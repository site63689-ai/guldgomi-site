'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { makeConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { upsertProducts } = require('../src/seed');
const { makeBog } = require('../src/payments/bog');
const { makeTbc } = require('../src/payments/tbc');
const { makeStripe } = require('../src/payments/stripe');
const { makePayments } = require('../src/payments');
const { makeService } = require('../src/service');

const SK = 'sk_test_' + 'a'.repeat(24);
const WHSEC = 'whsec_testsecret';

// ---- поддельный Stripe ----
function startMockStripe() {
  const state = { sessions: {}, calls: [], status: 'open', payment: 'unpaid', amount: null, refunded: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      state.calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers.authorization !== 'Bearer ' + SK) return send({ error: { message: 'Invalid API Key provided' } }, 401);
      if (req.url === '/v1/checkout/sessions' && req.method === 'POST') {
        const f = new URLSearchParams(body);
        const id = 'cs_test_' + Object.keys(state.sessions).length;
        state.sessions[id] = f;
        return send({ id, url: 'https://checkout.stripe.com/c/pay/' + id });
      }
      let m = req.url.match(/^\/v1\/checkout\/sessions\/([^?]+)/);
      if (m && req.method === 'GET') {
        const f = state.sessions[m[1]];
        if (!f) return send({ error: { message: 'nf' } }, 404);
        let total = 0;
        for (let i = 0; f.has(`line_items[${i}][quantity]`); i++) total += Number(f.get(`line_items[${i}][quantity]`)) * Number(f.get(`line_items[${i}][price_data][unit_amount]`));
        return send({ id: m[1], status: state.status, payment_status: state.payment, amount_total: state.amount ?? total, currency: 'gel', client_reference_id: f.get('client_reference_id'), payment_intent: { latest_charge: { refunded: state.refunded } } });
      }
      if (req.url.startsWith('/v1/checkout/sessions?') && req.method === 'GET') return send({ data: [] });
      send({ error: { message: 'nf' } }, 404);
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, state, url: 'http://127.0.0.1:' + server.address().port })));
}

async function setup(envExtra = {}) {
  const stripe = await startMockStripe();
  const env = { PUBLIC_BASE_URL: 'https://api.example.com', SITE_URL: 'https://shop.example.com', STRIPE_SECRET_KEY: SK, STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE: stripe.url, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c', ...envExtra };
  const cfg = makeConfig(env);
  const db = openDb(':memory:');
  upsertProducts(db, [{ id: 1, price: 30, name: { ru: 'Мёд', ka: 'თაფლი', en: 'Honey' } }, { id: 2, price: 45.5, name: { ru: 'Каштан', ka: 'წ', en: 'Chestnut' } }]);
  const sent = [];
  const rec = n => (...a) => { sent.push([n, a[0] && (a[0].id || a[0])]); };
  const telegram = { enabled: true, newOrder: rec('new'), paid: rec('paid'), failed: rec('failed'), refunded: rec('refunded'), mismatch: rec('mismatch'), review: rec('review'), chat: rec('chat'), send: rec('send') };
  const payments = makePayments(cfg, { bog: makeBog(cfg), tbc: makeTbc(cfg), stripe: makeStripe(cfg) });
  const service = makeService({ db, cfg, payments, telegram });
  const hook = (obj, { secret = WHSEC, ts = Math.floor(Date.now() / 1000), type = 'checkout.session.completed' } = {}) => {
    const raw = Buffer.from(JSON.stringify({ id: 'evt_1', type, data: { object: obj } }));
    const sig = crypto.createHmac('sha256', secret).update(`${ts}.${raw.toString('utf8')}`).digest('hex');
    return { raw, headers: { 'stripe-signature': `t=${ts},v1=${sig}` } };
  };
  return { stripe, cfg, db, service, sent, hook, close: () => stripe.server.close() };
}
const order = (over = {}) => ({ customer: { name: 'Ника', phone: '+995 555 11 22 33', address: 'Тбилиси, Руставели 1' }, items: [{ id: 1, qty: 2 }, { id: 2, qty: 1 }], method: 'stripe', lang: 'ru', ...over });
const PHONE = '555112233';

test('Stripe: платёж создаётся по ценам сервера, ссылка ведёт на stripe.com', async () => {
  const t = await setup();
  try {
    const r = await t.service.createOrder(order({ items: [{ id: 1, qty: 2 }, { id: 2, qty: 1 }], price: 1, total: 1 }));
    assert.equal(r.status, 'pending_payment');
    assert.match(r.redirectUrl, /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
    assert.equal(r.totalTetri, 10550);
    const call = t.stripe.state.calls.find(c => c.method === 'POST');
    assert.equal(call.headers['idempotency-key'], 'guldgomi-' + r.orderId);
    const f = new URLSearchParams(call.body);
    assert.equal(f.get('mode'), 'payment');
    assert.equal(f.get('line_items[0][price_data][currency]'), 'gel');
    assert.equal(f.get('line_items[0][price_data][unit_amount]'), '3000');
    assert.equal(f.get('line_items[1][price_data][unit_amount]'), '4550');
    assert.equal(f.get('client_reference_id'), r.orderId);
    assert.equal(f.get('success_url'), 'https://shop.example.com/?payment=success&order=' + r.orderId);
    assert.ok(Number(f.get('expires_at')) - Date.now() / 1000 >= 30 * 60, 'Stripe требует срок жизни сессии не меньше 30 минут');
  } finally { t.close(); }
});

test('Stripe: подпись webhook, подтверждение оплаты ровно один раз', async () => {
  const t = await setup();
  try {
    const r = await t.service.createOrder(order());
    const sid = Object.keys(t.stripe.state.sessions)[0];
    t.stripe.state.status = 'complete'; t.stripe.state.payment = 'paid';
    const h = t.hook({ id: sid });
    assert.deepEqual(await t.service.handleWebhook('stripe', h.raw, h.headers, '1.1.1.1'), { ok: true, result: 'paid' });
    await t.service.handleWebhook('stripe', h.raw, h.headers, '1.1.1.1');
    assert.equal(t.sent.filter(s => s[0] === 'paid').length, 1);
    assert.equal(t.service.publicOrderStatus(r.orderId, PHONE).status, 'paid');
  } finally { t.close(); }
});

test('Stripe: плохая подпись, чужой секрет, устаревшая метка времени и отсутствие секрета отклоняются', async () => {
  const t = await setup();
  try {
    await t.service.createOrder(order());
    const sid = Object.keys(t.stripe.state.sessions)[0];
    t.stripe.state.status = 'complete'; t.stripe.state.payment = 'paid';
    for (const h of [t.hook({ id: sid }, { secret: 'whsec_other' }), t.hook({ id: sid }, { ts: Math.floor(Date.now() / 1000) - 3600 }), { raw: Buffer.from('{}'), headers: {} }]) {
      await assert.rejects(() => t.service.handleWebhook('stripe', h.raw, h.headers, '1.1.1.1'), e => e.status === 401);
    }
    assert.equal(t.sent.filter(s => s[0] === 'paid').length, 0);
  } finally { t.close(); }
  const n = await setup({ STRIPE_WEBHOOK_SECRET: '' });
  try {
    await n.service.createOrder(order());
    const sid = Object.keys(n.stripe.state.sessions)[0];
    const h = n.hook({ id: sid }, { secret: '' });
    await assert.rejects(() => n.service.handleWebhook('stripe', h.raw, h.headers, '1.1.1.1'), e => e.status === 401);
  } finally { n.close(); }
});

test('Stripe: посторонние события игнорируются, а несовпадение суммы уходит на проверку', async () => {
  const t = await setup();
  try {
    const r = await t.service.createOrder(order());
    const sid = Object.keys(t.stripe.state.sessions)[0];
    const other = t.hook({ id: 'ch_123' }, { type: 'charge.succeeded' });
    assert.deepEqual(await t.service.handleWebhook('stripe', other.raw, other.headers, '1.1.1.1'), { ok: true, ignored: true });
    t.stripe.state.status = 'complete'; t.stripe.state.payment = 'paid'; t.stripe.state.amount = 100;
    const h = t.hook({ id: sid });
    assert.equal((await t.service.handleWebhook('stripe', h.raw, h.headers, '1.1.1.1')).result, 'review');
    assert.equal(t.service.publicOrderStatus(r.orderId, PHONE).status, 'review');
    assert.deepEqual(t.sent.filter(s => s[0] === 'mismatch').length, 1);
  } finally { t.close(); }
});

test('Stripe: истёкшая сессия = платёж не прошёл; возврат определяется по charge', async () => {
  const t = await setup();
  try {
    const r = await t.service.createOrder(order());
    t.stripe.state.status = 'expired';
    const pub = await t.service.refreshOrderStatus(r.orderId, PHONE);
    assert.equal(pub.status, 'failed');
    assert.equal(pub.display, 'failed');
  } finally { t.close(); }
  const p = makeStripe(makeConfig({ PUBLIC_BASE_URL: 'https://a.b', SITE_URL: 'https://c.d', STRIPE_SECRET_KEY: SK }));
  assert.equal(p._mapSession({ status: 'complete', payment_status: 'paid', payment_intent: { latest_charge: { refunded: true } } }), 'refunded');
  assert.equal(p._mapSession({ status: 'complete', payment_status: 'unpaid' }), 'pending');
});

test('покупатель вернулся с банка раньше webhook: статус обновляется сразу, но не чаще раза в 5 секунд', async () => {
  const t = await setup();
  try {
    const r = await t.service.createOrder(order());
    assert.equal((await t.service.refreshOrderStatus(r.orderId, PHONE)).status, 'pending_payment');
    const getsBefore = t.stripe.state.calls.filter(c => c.method === 'GET').length;
    t.stripe.state.status = 'complete'; t.stripe.state.payment = 'paid';
    // повторный запрос в пределах 5 секунд не ходит в банк
    assert.equal((await t.service.refreshOrderStatus(r.orderId, PHONE)).status, 'pending_payment');
    assert.equal(t.stripe.state.calls.filter(c => c.method === 'GET').length, getsBefore);
  } finally { t.close(); }
});

test('ключ pk_ (публичный) или без адреса сервера — Stripe выключен и не показывается покупателям', async () => {
  assert.equal(makeConfig({ PUBLIC_BASE_URL: 'https://a.b', STRIPE_SECRET_KEY: 'pk_live_' + 'x'.repeat(30) }).stripe.enabled, false);
  assert.equal(makeConfig({ STRIPE_SECRET_KEY: SK }).stripe.enabled, false);
  const t = await setup({ STRIPE_SECRET_KEY: 'pk_test_' + 'x'.repeat(30) });
  try {
    assert.deepEqual(t.service.publicMethods().online, []);
    await assert.rejects(() => t.service.createOrder(order()), e => e.status === 400 && e.code === 'method_unavailable');
    const g = t.service.admin.paymentsStatus().gateways.find(x => x.name === 'stripe');
    assert.equal(g.ready, false);
    assert.match(g.missing.join(' '), /sk_live/);
  } finally { t.close(); }
});

test('этапы заказа: подтверждён → собирается → в пути → доставлен; история и время', async () => {
  const t = await setup();
  try {
    const r = await t.service.createOrder(order({ method: 'courier' }));
    for (const st of ['confirmed', 'packing', 'shipped']) assert.equal(t.service.admin.setStage(r.orderId, st).stage, st);
    let pub = t.service.publicOrderStatus(r.orderId, PHONE);
    assert.equal(pub.display, 'shipped');
    assert.deepEqual(pub.history.map(h => h.key), ['new', 'confirmed', 'packing', 'shipped']);
    const a = t.service.admin.orders().find(o => o.id === r.orderId);
    assert.ok(a.shippedAt);
    assert.throws(() => t.service.admin.setStage(r.orderId, 'flying'), e => e.status === 400);
    assert.throws(() => t.service.admin.setStage('ORD-000000', 'packing'), e => e.status === 404);
    // доставка наличным заказом = оплата получена
    assert.equal(a.paid, false);
    const d = t.service.admin.setStage(r.orderId, 'delivered', 'Вручено лично');
    assert.equal(d.paid, true);
    assert.equal(d.display, 'delivered');
    assert.ok(d.deliveredAt);
  } finally { t.close(); }
});

test('нельзя продвигать заказ, пока банк не подтвердил оплату', async () => {
  const t = await setup();
  try {
    const r = await t.service.createOrder(order());
    assert.throws(() => t.service.admin.setStage(r.orderId, 'shipped'), e => e.status === 409 && e.code === 'payment_not_final');
    assert.throws(() => t.service.admin.setStage(r.orderId, 'cancelled'), e => e.status === 409);
    t.stripe.state.status = 'expired';
    await t.service.refreshOrderStatus(r.orderId, PHONE);
    assert.throws(() => t.service.admin.setStage(r.orderId, 'shipped'), e => e.code === 'payment_invalid');
    assert.equal(t.service.admin.setStage(r.orderId, 'cancelled').display, 'failed', 'при неудачной оплате покупатель видит «оплата не прошла»');
  } finally { t.close(); }
});

test('оплаченный онлайн заказ: после оплаты виден как «оплачен», отмена напоминает вернуть деньги', async () => {
  const t = await setup();
  try {
    const r = await t.service.createOrder(order());
    t.stripe.state.status = 'complete'; t.stripe.state.payment = 'paid';
    const pub = await t.service.refreshOrderStatus(r.orderId, PHONE);
    assert.equal(pub.display, 'paid');
    assert.equal(t.service.admin.setStage(r.orderId, 'confirmed').display, 'confirmed');
    t.service.admin.setStage(r.orderId, 'cancelled');
    assert.equal(t.sent.filter(s => s[0] === 'send').length, 1, 'владельцу уходит напоминание о возврате');
    assert.equal(t.service.publicOrderStatus(r.orderId, PHONE).display, 'cancelled');
  } finally { t.close(); }
});

test('трекинг доставки: курьер, код, ссылка; опасные ссылки отклоняются; покупатель видит данные', async () => {
  const t = await setup();
  try {
    const r = await t.service.createOrder(order({ method: 'cash' }));
    assert.equal(t.service.publicOrderStatus(r.orderId, PHONE).tracking, null);
    const a = t.service.admin.setTracking(r.orderId, { courier: 'Wolt', code: 'TRK-123', url: 'https://track.example.com/TRK-123', note: 'Позвонит за час' });
    assert.equal(a.tracking.code, 'TRK-123');
    const pub = t.service.publicOrderStatus(r.orderId, PHONE);
    assert.deepEqual(pub.tracking, { courier: 'Wolt', code: 'TRK-123', url: 'https://track.example.com/TRK-123', note: 'Позвонит за час' });
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.y', 'просто текст']) {
      assert.throws(() => t.service.admin.setTracking(r.orderId, { url: bad }), e => e.status === 400 && e.code === 'bad_url', bad);
    }
    assert.equal(t.service.admin.setTracking(r.orderId, { courier: 'Курьер', url: '' }).tracking.url, '');
  } finally { t.close(); }
});

test('оплата наличными: владелец отмечает получение; для онлайн-заказа нельзя', async () => {
  const t = await setup();
  try {
    const cash = await t.service.createOrder(order({ method: 'cash' }));
    assert.equal(t.service.admin.markPaid(cash.orderId).paid, true);
    assert.throws(() => t.service.admin.markPaid(cash.orderId), e => e.status === 409);
    const online = await t.service.createOrder(order());
    assert.throws(() => t.service.admin.markPaid(online.orderId), e => e.status === 409 && e.code === 'not_offline');
  } finally { t.close(); }
});

test('покупатель подтверждает получение только после отправки', async () => {
  const t = await setup();
  try {
    const r = await t.service.createOrder(order({ method: 'courier' }));
    assert.throws(() => t.service.customerReceived(r.orderId, PHONE), e => e.status === 409 && e.code === 'not_shipped');
    t.service.admin.setStage(r.orderId, 'shipped');
    assert.throws(() => t.service.customerReceived(r.orderId, '999999999'), e => e.status === 404);
    assert.equal(t.service.customerReceived(r.orderId, PHONE).display, 'delivered');
    const h = t.service.publicOrderStatus(r.orderId, PHONE).history;
    assert.equal(h[h.length - 1].key, 'delivered');
  } finally { t.close(); }
});

test('синхронизация каталога: цены с сайта становятся ценами сервера, лишние товары отключаются', async () => {
  const t = await setup();
  try {
    const res = t.service.admin.syncProducts([{ id: 1, price: 33.5, name: { ru: 'Мёд', ka: '', en: 'Honey' } }, { id: 3, price: 12, name: { ru: 'Новый', ka: '', en: 'New' } }]);
    assert.equal(res.count, 2);
    assert.deepEqual(t.service.listProducts().map(p => [p.id, p.priceTetri]), [[1, 3350], [3, 1200]]);
    const r = await t.service.createOrder(order({ method: 'courier', items: [{ id: 1, qty: 2 }, { id: 3, qty: 1 }] }));
    assert.equal(r.totalTetri, 7900);
    await assert.rejects(() => t.service.createOrder(order({ method: 'courier', items: [{ id: 2, qty: 1 }] })), e => e.code === 'unknown_product');
    for (const bad of [[], 'x', [{ id: 'a', price: 5 }], [{ id: 1, price: -1 }], [{ id: 1, price: 0 }], [{ id: 1, price: 1e9 }]]) {
      assert.throws(() => t.service.admin.syncProducts(bad), e => e.status === 400, JSON.stringify(bad));
    }
    assert.equal(t.service.listProducts().length, 2, 'после ошибки каталог не изменился');
  } finally { t.close(); }
});

test('диагностика шлюзов: что не хватает, адреса webhook, проверка ключей', async () => {
  const t = await setup();
  try {
    const s = t.service.admin.paymentsStatus();
    const by = n => s.gateways.find(g => g.name === n);
    assert.equal(by('stripe').ready, true);
    assert.equal(by('stripe').mode, 'test');
    assert.equal(by('stripe').webhookUrl, 'https://api.example.com/api/v1/webhooks/stripe');
    assert.deepEqual(by('tbc').missing, ['TBC_API_KEY', 'TBC_CLIENT_ID', 'TBC_CLIENT_SECRET']);
    assert.deepEqual(by('bog').missing, ['BOG_CLIENT_ID', 'BOG_CLIENT_SECRET']);
    assert.ok(!JSON.stringify(s).includes(SK), 'секретные ключи не отдаются');
    assert.deepEqual(await t.service.admin.checkPayment('stripe'), { ok: true, mode: 'test' });
    await assert.rejects(() => t.service.admin.checkPayment('tbc'), e => e.status === 409);
    await assert.rejects(() => t.service.admin.checkPayment('paypal'), e => e.status === 404);
  } finally { t.close(); }
  const bad = await setup();
  bad.stripe.state.calls.length = 0;
  bad.cfg.stripe.secretKey = 'sk_test_' + 'b'.repeat(24); // ключ, который Stripe не примет
  try {
    const out = await bad.service.admin.checkPayment('stripe');
    assert.equal(out.ok, false);
    assert.match(out.error, /401/);
    assert.ok(!out.error.includes('sk_test_'));
  } finally { bad.close(); }
});

test('миграция: старая база получает этапы, «delivered» из status переезжает в stage', () => {
  const file = path.join(os.tmpdir(), 'guldgomi-mig-' + process.pid + '.db');
  fs.rmSync(file, { force: true });
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, customer_name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL, lang TEXT NOT NULL DEFAULT 'ru', items_json TEXT NOT NULL, total_tetri INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'GEL', method TEXT NOT NULL, status TEXT NOT NULL, provider TEXT, provider_payment_id TEXT, paid_at TEXT, note TEXT);`);
  const ins = old.prepare(`INSERT INTO orders (id, created_at, updated_at, customer_name, phone, address, items_json, total_tetri, method, status, provider) VALUES (?, 'x', 'x', 'n', '555112233', 'a', '[]', 100, ?, ?, ?)`);
  ins.run('ORD-1', 'courier', 'delivered', null); ins.run('ORD-2', 'bog', 'delivered', 'bog'); ins.run('ORD-3', 'courier', 'new', null); ins.run('ORD-4', 'bog', 'paid', 'bog');
  old.close();
  const db = openDb(file);
  const get = id => db.prepare('SELECT status, stage FROM orders WHERE id = ?').get(id);
  assert.deepEqual({ ...get('ORD-1') }, { status: 'new', stage: 'delivered' });
  assert.deepEqual({ ...get('ORD-2') }, { status: 'paid', stage: 'delivered' });
  assert.deepEqual({ ...get('ORD-3') }, { status: 'new', stage: 'new' });
  assert.deepEqual({ ...get('ORD-4') }, { status: 'paid', stage: 'new' });
  openDb(file).close(); // повторный запуск миграции безопасен
  db.close(); fs.rmSync(file, { force: true });
});
