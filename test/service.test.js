'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { makeConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { upsertProducts } = require('../src/seed');
const { makeBog } = require('../src/payments/bog');
const { makeTbc } = require('../src/payments/tbc');
const { makePayments } = require('../src/payments');
const { makeService } = require('../src/service');

// ---- поддельный банк ----
function startMockBank() {
  const state = { bogStatus: 'created', bogAmount: null, tbcStatus: 'Created', tbcAmount: null, orders: {}, tbcPays: {}, calls: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      state.calls.push(req.method + ' ' + req.url);
      const send = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/bog-token') return send({ access_token: 'bogtok', token_type: 'Bearer', expires_in: 300 });
      if (req.url === '/payments/v1/ecommerce/orders' && req.method === 'POST') {
        assert.match(req.headers.authorization, /^Bearer bogtok$/);
        const j = JSON.parse(body);
        const id = 'bogorder' + Object.keys(state.orders).length;
        state.orders[id] = j;
        return send({ id, _links: { redirect: { href: 'https://payment.bog.ge/?order_id=' + id } } });
      }
      let m = req.url.match(/^\/payments\/v1\/receipt\/(.+)$/);
      if (m) {
        const o = state.orders[m[1]];
        return send({ order_status: { key: state.bogStatus }, external_order_id: o.external_order_id, purchase_units: { request_amount: state.bogAmount ?? o.purchase_units.total_amount, currency_code: 'GEL' } });
      }
      if (req.url === '/v1/tpay/access-token') { assert.equal(req.headers.apikey, 'tbckey'); return send({ access_token: 'tbctok', expires_in: 1800 }); }
      if (req.url === '/v1/tpay/payments' && req.method === 'POST') {
        const j = JSON.parse(body);
        const payId = 'tpay-' + Object.keys(state.tbcPays).length;
        state.tbcPays[payId] = j;
        return send({ payId, status: 'Created', links: [{ uri: 'https://api.tbcbank.ge/v1/tpay/payments/' + payId, method: 'GET', rel: 'self' }, { uri: 'https://tpay.tbcbank.ge/checkout/choose-payment-method/' + payId, method: 'REDIRECT', rel: 'approval_url' }] });
      }
      m = req.url.match(/^\/v1\/tpay\/payments\/(.+)$/);
      if (m) { const p = state.tbcPays[m[1]]; return send({ payId: m[1], status: state.tbcStatus, currency: 'GEL', amount: state.tbcAmount ?? p.amount.total }); }
      send({ error: 'nf' }, 404);
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, state, url: 'http://127.0.0.1:' + server.address().port })));
}

async function setup(envExtra = {}) {
  const bank = await startMockBank();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = {
    PUBLIC_BASE_URL: 'https://api.example.com', SITE_URL: 'https://shop.example.com',
    BOG_CLIENT_ID: 'id', BOG_CLIENT_SECRET: 'sec', BOG_API_BASE: bank.url, BOG_AUTH_URL: bank.url + '/bog-token',
    BOG_CALLBACK_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
    TBC_API_KEY: 'tbckey', TBC_CLIENT_ID: 'tid', TBC_CLIENT_SECRET: 'tsec', TBC_API_BASE: bank.url,
    TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c', ...envExtra
  };
  const cfg = makeConfig(env);
  const db = openDb(':memory:');
  upsertProducts(db, [{ id: 1, price: 30, name: { ru: 'Мёд', ka: 'თაფლი', en: 'Honey' } }, { id: 2, price: 45.5, name: { ru: 'Каштан', ka: 'წ', en: 'Chestnut' } }]);
  const sent = [];
  const rec = n => (...a) => { sent.push([n, a[0] && a[0].id]); };
  const telegram = { enabled: true, newOrder: rec('new'), paid: rec('paid'), failed: rec('failed'), refunded: rec('refunded'), mismatch: rec('mismatch'), review: rec('review'), chat: rec('chat') };
  const payments = makePayments(cfg, { bog: makeBog(cfg), tbc: makeTbc(cfg) });
  const service = makeService({ db, cfg, payments, telegram });
  const sign = raw => { const s = crypto.createSign('RSA-SHA256'); s.update(raw); s.end(); return s.sign(privateKey, 'base64'); };
  return { bank, cfg, db, service, sent, sign, close: () => bank.server.close() };
}

const order = (over = {}) => ({ customer: { name: 'Ника', phone: '+995 555 11 22 33', address: 'Тбилиси, Руставели 1' }, items: [{ id: 1, qty: 2 }, { id: 2, qty: 1 }], method: 'bog', lang: 'ru', ...over });

test('цена считается на сервере, а не берётся из браузера', async () => {
  const t = await setup();
  const r = await t.service.createOrder(order({ method: 'cash', total: 1, items: [{ id: 1, qty: 2, price: 0.01 }, { id: 2, qty: 1 }] }));
  assert.equal(r.totalTetri, 10550);
  assert.equal(r.status, 'new');
  assert.deepEqual(t.sent, [['new', r.orderId]]);
  t.close();
});

test('валидация: пустая корзина, чужой товар, плохой телефон, неизвестный метод', async () => {
  const t = await setup();
  for (const bad of [order({ items: [] }), order({ items: [{ id: 99, qty: 1 }] }), order({ items: [{ id: 1, qty: -1 }] }), order({ items: [{ id: 1, qty: 1.5 }] }), order({ customer: { name: 'A', phone: '12', address: 'x' } }), order({ method: 'paypal' }), null])
    await assert.rejects(() => t.service.createOrder(bad), e => e.status === 400 || e.status === 400);
  t.close();
});

test('BOG: создание платежа, redirectUrl, webhook с подписью -> paid один раз', async () => {
  const t = await setup();
  const r = await t.service.createOrder(order());
  assert.match(r.redirectUrl, /^https:\/\/payment\.bog\.ge\//);
  assert.equal(r.status, 'pending_payment');
  const sentBody = Object.values(t.bank.state.orders)[0];
  assert.equal(sentBody.purchase_units.total_amount, 105.5);
  assert.equal(sentBody.callback_url, 'https://api.example.com/api/v1/webhooks/bog');
  assert.equal(sentBody.external_order_id, r.orderId);
  assert.deepEqual(t.sent, []); // пока не оплачено — уведомления нет

  t.bank.state.bogStatus = 'completed';
  const raw = Buffer.from(JSON.stringify({ event: 'order_payment', body: { order_id: 'bogorder0' } }));
  const out = await t.service.handleWebhook('bog', raw, { 'callback-signature': t.sign(raw) }, '1.1.1.1');
  assert.equal(out.result, 'paid');
  await t.service.handleWebhook('bog', raw, { 'callback-signature': t.sign(raw) }, '1.1.1.1'); // повтор
  assert.deepEqual(t.sent, [['paid', r.orderId]]);
  assert.equal(t.service.publicOrderStatus(r.orderId, '555112233').status, 'paid');
  t.close();
});

test('BOG: неверная подпись отклоняется и ничего не меняет', async () => {
  const t = await setup();
  const r = await t.service.createOrder(order());
  t.bank.state.bogStatus = 'completed';
  const raw = Buffer.from(JSON.stringify({ body: { order_id: 'bogorder0' } }));
  await assert.rejects(() => t.service.handleWebhook('bog', raw, { 'callback-signature': 'AAAA' }, 'x'), e => e.status === 401);
  await assert.rejects(() => t.service.handleWebhook('bog', raw, {}, 'x'), e => e.status === 401);
  assert.equal(t.service.publicOrderStatus(r.orderId, '555112233').status, 'pending_payment');
  t.close();
});

test('BOG: callback не доверяем — банк говорит "rejected" => failed, не paid', async () => {
  const t = await setup();
  const r = await t.service.createOrder(order());
  t.bank.state.bogStatus = 'rejected';
  const raw = Buffer.from(JSON.stringify({ body: { order_id: 'bogorder0', order_status: { key: 'completed' } } }));
  const out = await t.service.handleWebhook('bog', raw, { 'callback-signature': t.sign(raw) });
  assert.equal(out.result, 'failed');
  assert.deepEqual(t.sent, [['failed', r.orderId]]);
  t.close();
});

test('несовпадение суммы не помечается оплаченным', async () => {
  const t = await setup();
  const r = await t.service.createOrder(order());
  t.bank.state.bogStatus = 'completed'; t.bank.state.bogAmount = 1;
  const raw = Buffer.from(JSON.stringify({ body: { order_id: 'bogorder0' } }));
  const out = await t.service.handleWebhook('bog', raw, { 'callback-signature': t.sign(raw) });
  assert.equal(out.result, 'review');
  assert.deepEqual(t.sent, [['mismatch', r.orderId]]);
  t.close();
});

test('TBC: создание платежа, approval_url, webhook PaymentId -> paid', async () => {
  const t = await setup();
  const r = await t.service.createOrder(order({ method: 'tbc', lang: 'ka' }));
  assert.match(r.redirectUrl, /^https:\/\/tpay\.tbcbank\.ge\/checkout\//);
  const body = Object.values(t.bank.state.tbcPays)[0];
  assert.deepEqual(body.amount, { currency: 'GEL', total: 105.5, subTotal: 105.5, tax: 0, shipping: 0 });
  assert.equal(body.language, 'KA');
  assert.equal(body.merchantPaymentId, r.orderId);
  t.bank.state.tbcStatus = 'Succeeded';
  const raw = Buffer.from(JSON.stringify({ PaymentId: 'tpay-0' }));
  const out = await t.service.handleWebhook('tbc', raw, {}, '193.104.20.44');
  assert.equal(out.result, 'paid');
  assert.deepEqual(t.sent, [['paid', r.orderId]]);
  t.close();
});

test('TBC: проверка IP при включении TBC_ENFORCE_IP', async () => {
  const t = await setup({ TBC_ENFORCE_IP: 'true' });
  await t.service.createOrder(order({ method: 'tbc' }));
  const raw = Buffer.from(JSON.stringify({ PaymentId: 'tpay-0' }));
  await assert.rejects(() => t.service.handleWebhook('tbc', raw, {}, '8.8.8.8'), e => e.status === 401);
  t.bank.state.tbcStatus = 'Succeeded';
  assert.equal((await t.service.handleWebhook('tbc', raw, {}, '185.52.80.45')).result, 'paid');
  t.close();
});

test('банк без ключей отключён; при пустых ключах обоих банков онлайн-оплаты нет', async () => {
  const t = await setup({ TBC_API_KEY: '' });
  assert.deepEqual(t.service.publicMethods().online, ['bog']);
  await assert.rejects(() => t.service.createOrder(order({ method: 'tbc' })), e => e.code === 'method_unavailable');
  await assert.rejects(() => t.service.handleWebhook('tbc', Buffer.from('{}'), {}), e => e.status === 404);
  t.close();
  const n = await setup({ TBC_API_KEY: '', BOG_CLIENT_ID: '' });
  assert.deepEqual(n.service.publicMethods().online, []);
  assert.equal((await n.service.createOrder(order({ method: 'courier' }))).status, 'new');
  await assert.rejects(() => n.service.createOrder(order({ method: 'bog' })), e => e.code === 'method_unavailable');
  n.close();
});

test('без PUBLIC_BASE_URL банки отключаются (некуда слать callback)', async () => {
  const t = await setup({ PUBLIC_BASE_URL: '' });
  assert.deepEqual(t.service.publicMethods().online, []);
  t.close();
});

test('банк вернул ссылку на чужой домен — платёж отклонён, заказ failed', async () => {
  const t = await setup();
  const orig = t.bank.server.listeners('request')[0];
  t.bank.server.removeAllListeners('request');
  t.bank.server.on('request', (req, res) => {
    if (req.url === '/payments/v1/ecommerce/orders') { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'x', _links: { redirect: { href: 'https://evil.example/pay' } } })); }); }
    else orig(req, res);
  });
  await assert.rejects(() => t.service.createOrder(order()), e => e.status === 502);
  assert.equal(t.db.prepare('SELECT status FROM orders').get().status, 'failed');
  t.close();
});

test('reconcilePending подбирает оплату, если webhook потерялся', async () => {
  const t = await setup();
  const r = await t.service.createOrder(order());
  t.db.prepare('UPDATE orders SET created_at = ?').run(new Date(Date.now() - 10 * 60000).toISOString());
  t.bank.state.bogStatus = 'completed';
  await t.service.reconcilePending();
  assert.equal(t.service.publicOrderStatus(r.orderId, '555112233').status, 'paid');
  t.close();
});

test('статус заказа требует телефон', async () => {
  const t = await setup();
  const r = await t.service.createOrder(order({ method: 'cash' }));
  assert.throws(() => t.service.publicOrderStatus(r.orderId, '999999999'), e => e.status === 404);
  assert.throws(() => t.service.publicOrderStatus(r.orderId, ''), e => e.status === 404);
  t.close();
});

test('отзывы: только покупатели, модерация, Telegram', async () => {
  const t = await setup();
  assert.throws(() => t.service.createReview({ author: 'A', rating: 5, text: 'ok', orderRef: '555112233' }), e => e.status === 403);
  const r = await t.service.createOrder(order({ method: 'cash' }));
  const rv = t.service.createReview({ author: 'Ника', rating: 5, text: '<b>супер</b>', orderRef: '555 11 22 33' });
  assert.equal(t.service.approvedReviews().length, 0);
  t.service.admin.setReview(rv.id, true);
  assert.equal(t.service.approvedReviews().length, 1);
  assert.throws(() => t.service.createReview({ author: 'A', rating: 9, text: 'x', orderRef: r.orderId }), e => e.status === 400);
  assert.ok(t.sent.some(s => s[0] === 'review'));
  t.close();
});

test('чат: категория и приоритет, уведомление', async () => {
  const t = await setup();
  assert.deepEqual(t.service.createChatMessage({ text: 'Деньги списались, но заказ не пришёл', lang: 'ru' }), { category: 'problem', priority: 'high' });
  assert.equal(t.service.createChatMessage({ text: 'how long is delivery?' }).category, 'delivery');
  assert.throws(() => t.service.createChatMessage({ text: '  ' }), e => e.status === 400);
  assert.equal(t.sent.filter(s => s[0] === 'chat').length, 2);
  t.close();
});

test('админ не может вручную выставить оплату', async () => {
  const t = await setup();
  const r = await t.service.createOrder(order());
  assert.throws(() => t.service.admin.setOrderStatus(r.orderId, 'delivered'), e => e.status === 409);
  assert.throws(() => t.service.admin.setOrderStatus(r.orderId, 'paid'), e => e.status === 400);
  t.close();
});
