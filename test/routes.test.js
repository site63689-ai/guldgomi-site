'use strict';
// Проверка слоя маршрутов без настоящего Express (в тестовой среде пакеты не ставятся):
// подставляем простую имитацию, которая записывает зарегистрированные маршруты и прогоняет обработчики.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function fakeExpress() {
  const routes = [], uses = [];
  const app = fn => app;
  const mk = () => {
    const a = { routes, uses, set() {}, disable() {}, use(...h) { uses.push(h); }, };
    for (const m of ['get', 'post']) a[m] = (path, ...h) => routes.push({ method: m.toUpperCase(), path, handlers: h });
    return a;
  };
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
    const res = { code: 200, headers: {}, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); }, send(b) { resolve({ code: this.code, html: b, headers: this.headers }); }, sendStatus(c) { resolve({ code: c }); }, set(h) { Object.assign(this.headers, h); return this; } };
    let i = 0;
    const next = err => { if (err) return reject(err); const h = handlers[i++]; if (!h) return resolve({ code: 'no-response' }); try { const r = h(req, res, next); if (r && r.catch) r.catch(reject); } catch (e) { reject(e); } };
    next();
  });
}

const cfg = { allowedOrigins: [], adminToken: '' };
const service = { publicMethods: () => ({ online: ['bog'], offline: ['courier', 'cash'] }), listProducts: () => [], approvedReviews: () => [] };

test('маршруты зарегистрированы, ассистент и конфиг работают', async () => {
  const fake = fakeExpress();
  const { createApp } = load(fake);
  const calls = [];
  const assistant = { reply: async (body, ip) => { calls.push([body, ip]); return { reply: 'ok', handoff: false }; } };
  const app = createApp({ cfg, service, assistant });
  const find = (m, p) => app.routes.find(r => r.method === m && r.path === p);
  for (const [m, p] of [['GET', '/health'], ['GET', '/api/v1/config'], ['POST', '/api/v1/orders'], ['POST', '/api/v1/assistant'], ['POST', '/api/v1/webhooks/:provider']])
    assert.ok(find(m, p), `нет маршрута ${m} ${p}`);

  const cfgRes = await run(find('GET', '/api/v1/config').handlers, { ip: '1.1.1.1' });
  assert.deepEqual(cfgRes.body, { online: ['bog'], offline: ['courier', 'cash'], assistant: true });

  const out = await run(find('POST', '/api/v1/assistant').handlers, { ip: '9.9.9.9', body: { text: 'hi' } });
  assert.deepEqual(out.body, { reply: 'ok', handoff: false });
  assert.deepEqual(calls[0], [{ text: 'hi' }, '9.9.9.9']);
});

test('без ассистента: /api/v1/assistant отвечает 503 и config.assistant=false', async () => {
  const { createApp } = load(fakeExpress());
  const app = createApp({ cfg, service, assistant: null });
  const find = (m, p) => app.routes.find(r => r.method === m && r.path === p);
  assert.equal((await run(find('GET', '/api/v1/config').handlers, { ip: 'x' })).body.assistant, false);
  await assert.rejects(() => run(find('POST', '/api/v1/assistant').handlers, { ip: 'x', body: { text: 'hi' } }), e => e.status === 503);
});

test('ограничитель частоты на /assistant: 9-й запрос за минуту получает 429', async () => {
  const { createApp } = load(fakeExpress());
  const app = createApp({ cfg, service, assistant: { reply: async () => ({ reply: 'ok', handoff: false }) } });
  const h = app.routes.find(r => r.method === 'POST' && r.path === '/api/v1/assistant').handlers;
  let last;
  for (let i = 0; i < 9; i++) last = await run(h, { ip: '5.5.5.5', body: { text: 'x' } });
  assert.equal(last.code, 429);
  assert.equal((await run(h, { ip: '6.6.6.6', body: { text: 'x' } })).code, 200);
});

test('сайт отдаётся на / и /index.html; других файлов сервер не раздаёт', async () => {
  const { createApp } = load(fakeExpress());
  const app = createApp({ cfg, service, assistant: null, siteHtml: '<html>САЙТ</html>' });
  for (const p of ['/', '/index.html']) {
    const r = await run(app.routes.find(x => x.method === 'GET' && x.path === p).handlers, { ip: 'x' });
    assert.equal(r.html, '<html>САЙТ</html>');
    assert.match(r.headers['Content-Type'], /text\/html/);
  }
  assert.equal(app.routes.filter(x => x.method === 'GET').some(x => x.path === '/.env' || x.path === '/*'), false);
  const none = load(fakeExpress()).createApp({ cfg, service, assistant: null });
  assert.equal(none.routes.some(x => x.path === '/'), false, 'без файла сайта главная страница не регистрируется');
});

test('диагностика ассистента: счётчики без секретов', async () => {
  const { makeAssistant } = require('../src/assistant');
  const client = { messages: { create: async () => ({ content: [{ type: 'text', text: 'Здравствуйте!' }] }) } };
  const assistant = makeAssistant({ client, model: 'm', knowledge: '# KB\n- Телефон: +995\n' });
  await assistant.reply({ text: 'привет' }, '1.1.1.1');
  const { createApp } = load(fakeExpress());
  const app = createApp({ cfg: { ...cfg, assistant: { backup: { apiKey: 'SECRET' } } }, service, assistant });
  const find = (m, p) => app.routes.find(r => r.method === m && r.path === p);
  const out = await run(find('GET', '/api/v1/assistant/health').handlers, { ip: 'x' });
  assert.equal(out.body.enabled, true);
  assert.equal(out.body.backupProvider, true);
  assert.equal(out.body.answered, 1);
  assert.ok(out.body.lastOkAt);
  assert.equal(JSON.stringify(out.body).includes('SECRET'), false);
});

test('CORS: чат и config открыты для любого адреса сайта, заказы и админка — только для своего', async () => {
  const { createApp } = load(fakeExpress());
  const app = createApp({ cfg: { ...cfg, allowedOrigins: ['https://shop.ge'] }, service, assistant: null });
  const cors = app.uses[1][0];
  const call = (path, origin) => { const headers = {}; cors({ headers: { origin }, path, method: 'POST' }, { set(h) { Object.assign(headers, h); }, sendStatus() {} }, () => {}); return headers; };
  assert.equal(call('/api/v1/assistant', 'https://x.github.io')['Access-Control-Allow-Origin'], '*');
  assert.equal(call('/api/v1/config', 'https://x.github.io')['Access-Control-Allow-Origin'], '*');
  assert.equal(call('/api/v1/orders', 'https://x.github.io')['Access-Control-Allow-Origin'], undefined);
  assert.equal(call('/api/v1/admin/orders', 'https://x.github.io')['Access-Control-Allow-Origin'], undefined);
  assert.equal(call('/api/v1/orders', 'https://shop.ge')['Access-Control-Allow-Origin'], 'https://shop.ge');
});
