'use strict';
// Новые маршруты: этапы заказа, трекинг, оплата наличными, шлюзы, каталог, подтверждение получения.
// Как и в routes.test.js, Express подменён простой имитацией.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function fakeExpress() {
  const routes = [];
  const mk = () => { const a = { routes, set() {}, disable() {}, use() {} }; for (const m of ['get', 'post']) a[m] = (path, ...h) => routes.push({ method: m.toUpperCase(), path, handlers: h }); return a; };
  const ex = () => mk();
  ex.json = () => (req, res, next) => next();
  ex.raw = () => (req, res, next) => next();
  return ex;
}
function load(fake) {
  const orig = Module._load;
  Module._load = function (req, ...r) { return req === 'express' ? fake : orig.call(this, req, ...r); };
  try { delete require.cache[require.resolve('../src/app')]; return require('../src/app'); } finally { Module._load = orig; }
}
function run(handlers, req) {
  return new Promise((resolve, reject) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); }, set() { return this; }, sendStatus(c) { resolve({ code: c }); } };
    let i = 0;
    const next = err => { if (err) return reject(err); const h = handlers[i++]; if (!h) return resolve({ code: 'no-response' }); try { const r = h(req, res, next); if (r && r.catch) r.catch(reject); } catch (e) { reject(e); } };
    next();
  });
}

const TOKEN = 'a-very-long-admin-token-123';
const log = [];
const service = {
  publicMethods: () => ({ online: [], offline: [] }), listProducts: () => [], approvedReviews: () => [],
  refreshOrderStatus: async (id, phone) => { log.push(['status', id, phone]); return { orderId: id }; },
  customerReceived: (id, phone) => { log.push(['received', id, phone]); return { orderId: id, display: 'delivered' }; },
  admin: {
    orders: () => [], setStage: (id, stage, note) => { log.push(['stage', id, stage, note]); return { id, stage }; },
    setTracking: (id, b) => { log.push(['tracking', id, b]); return { id }; }, markPaid: id => { log.push(['paid', id]); return { id, paid: true }; },
    paymentsStatus: () => ({ gateways: [] }), checkPayment: async n => ({ ok: true, name: n }), syncProducts: l => { log.push(['sync', l]); return { count: l.length }; }
  }
};
const cfg = { allowedOrigins: [], adminToken: TOKEN };
const get = (app, m, p) => app.routes.find(r => r.method === m && r.path === p);
const authed = { headers: { authorization: 'Bearer ' + TOKEN }, ip: '1.1.1.1' };

test('админ-маршруты требуют токен: без него и с чужим — 401, ADMIN_TOKEN не задан — 404', async () => {
  const app = load(fakeExpress()).createApp({ cfg, service });
  for (const [m, p] of [['GET', '/api/v1/admin/payments'], ['POST', '/api/v1/admin/payments/:name/check'], ['POST', '/api/v1/admin/products/sync'], ['POST', '/api/v1/admin/orders/:id/stage'], ['POST', '/api/v1/admin/orders/:id/tracking'], ['POST', '/api/v1/admin/orders/:id/paid']]) {
    const r = get(app, m, p);
    assert.ok(r, `нет маршрута ${m} ${p}`);
    assert.equal((await run(r.handlers, { headers: {}, ip: '2.2.2.2', params: {}, body: {} })).code, 401, p);
    assert.equal((await run(r.handlers, { headers: { authorization: 'Bearer wrong' }, ip: '3.3.3.3', params: {}, body: {} })).code, 401, p);
  }
  const off = load(fakeExpress()).createApp({ cfg: { ...cfg, adminToken: '' }, service });
  assert.equal((await run(get(off, 'GET', '/api/v1/admin/payments').handlers, { headers: authed.headers, ip: '4.4.4.4' })).code, 404);
});

test('админ-маршруты вызывают сервис с нужными аргументами', async () => {
  const app = load(fakeExpress()).createApp({ cfg, service });
  log.length = 0;
  assert.deepEqual((await run(get(app, 'POST', '/api/v1/admin/orders/:id/stage').handlers, { ...authed, params: { id: 'ORD-1' }, body: { stage: 'shipped', note: 'x' } })).body, { id: 'ORD-1', stage: 'shipped' });
  await run(get(app, 'POST', '/api/v1/admin/orders/:id/tracking').handlers, { ...authed, params: { id: 'ORD-1' }, body: { code: 'T1' } });
  assert.deepEqual((await run(get(app, 'POST', '/api/v1/admin/orders/:id/paid').handlers, { ...authed, params: { id: 'ORD-1' }, body: {} })).body, { id: 'ORD-1', paid: true });
  assert.deepEqual((await run(get(app, 'POST', '/api/v1/admin/payments/:name/check').handlers, { ...authed, params: { name: 'stripe' } })).body, { ok: true, name: 'stripe' });
  assert.deepEqual((await run(get(app, 'POST', '/api/v1/admin/products/sync').handlers, { ...authed, body: { products: [{ id: 1 }] } })).body, { count: 1 });
  assert.deepEqual(log.map(l => l[0]), ['stage', 'tracking', 'paid', 'sync']);
  assert.deepEqual(log[0], ['stage', 'ORD-1', 'shipped', 'x']);
});

test('публичные маршруты: статус заказа обновляется через банк, покупатель подтверждает получение', async () => {
  const app = load(fakeExpress()).createApp({ cfg, service });
  log.length = 0;
  assert.deepEqual((await run(get(app, 'POST', '/api/v1/orders/status').handlers, { ip: '5.5.5.5', body: { orderId: 'ORD-9', phone: '555' } })).body, { orderId: 'ORD-9' });
  assert.deepEqual((await run(get(app, 'POST', '/api/v1/orders/received').handlers, { ip: '5.5.5.5', body: { orderId: 'ORD-9', phone: '555' } })).body, { orderId: 'ORD-9', display: 'delivered' });
  assert.deepEqual(log.map(l => l[0]), ['status', 'received']);
});
