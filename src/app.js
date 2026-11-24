'use strict';
const express = require('express');
const { HttpError, rateLimit, safeEqual } = require('./util');

function createApp({ cfg, service, assistant = null, siteHtml = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render/Railway стоят за прокси — нужен реальный IP клиента

  // Заголовки безопасности
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN' });
    next();
  });

  // CORS: только ваш сайт. Вебхуки банков идут сервер-в-сервер и CORS не требуют.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && cfg.allowedOrigins.includes(origin)) {
      res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Max-Age': '600' });
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const json = express.json({ limit: '20kb' });
  const limitStrict = rateLimit({ windowMs: 60 * 1000, max: 20 });
  const limitLoose = rateLimit({ windowMs: 60 * 1000, max: 120 });

  app.get('/health', (req, res) => res.json({ ok: true }));

  // ---------- Вебхуки банков: нужно СЫРОЕ тело (для проверки подписи BOG) ----------
  app.post('/api/v1/webhooks/:provider', express.raw({ type: '*/*', limit: '200kb' }), wrap(async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const out = await service.handleWebhook(String(req.params.provider), body, req.headers, req.ip);
    res.status(200).json(out);
  }));

  // ---------- Публичное API для сайта ----------
  app.get('/api/v1/config', limitLoose, (req, res) => res.json({ ...service.publicMethods(), assistant: !!assistant }));
  app.get('/api/v1/products', limitLoose, (req, res) => res.json(service.listProducts()));
  app.get('/api/v1/reviews', limitLoose, (req, res) => res.json(service.approvedReviews()));

  app.post('/api/v1/orders', limitStrict, json, wrap(async (req, res) => res.status(201).json(await service.createOrder(req.body))));
  app.post('/api/v1/orders/status', limitLoose, json, wrap(async (req, res) => {
    res.json(await service.refreshOrderStatus(req.body && req.body.orderId, req.body && req.body.phone));
  }));
  app.post('/api/v1/orders/received', limitStrict, json, wrap(async (req, res) => {
    res.json(service.customerReceived(req.body && req.body.orderId, req.body && req.body.phone));
  }));
  app.post('/api/v1/reviews', limitStrict, json, wrap(async (req, res) => res.status(201).json(service.createReview(req.body))));
  // ИИ-ассистент: отдельный, более жёсткий лимит (каждый запрос стоит денег)
  const limitAssistant = rateLimit({ windowMs: 60 * 1000, max: 8 });
  app.post('/api/v1/assistant', limitAssistant, express.json({ limit: '8kb' }), wrap(async (req, res) => {
    if (!assistant) throw new HttpError(503, 'assistant_unavailable', 'Assistant is not configured');
    res.json(await assistant.reply(req.body, req.ip));
  }));
  // Страница диагностики: открыть в браузере /api/v1/assistant/health. Только счётчики и коды, без ключей и текстов
  app.get('/api/v1/assistant/health', limitLoose, (req, res) => {
    if (!assistant) return res.json({ enabled: false, hint: 'Не задан GEMINI_API_KEY' });
    res.json({ enabled: true, backupProvider: !!(cfg.assistant && cfg.assistant.backup), ...(assistant.stats || {}) });
  });
  app.post('/api/v1/chat', limitStrict, json, wrap(async (req, res) => res.status(201).json(service.createChatMessage(req.body))));

  // ---------- Админ-API (по секретному токену в заголовке Authorization: Bearer ...) ----------
  const adminAuth = rateLimit({ windowMs: 60 * 1000, max: 30 });
  function requireAdmin(req, res, next) {
    if (!cfg.adminToken) return res.status(404).json({ error: 'not_found' });
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m || !safeEqual(m[1], cfg.adminToken)) return res.status(401).json({ error: 'unauthorized' });
    next();
  }
  app.get('/api/v1/admin/orders', adminAuth, requireAdmin, (req, res) => res.json(service.admin.orders()));
  app.get('/api/v1/admin/reviews', adminAuth, requireAdmin, (req, res) => res.json(service.admin.reviews()));
  app.get('/api/v1/admin/messages', adminAuth, requireAdmin, (req, res) => res.json(service.admin.messages()));
  app.post('/api/v1/admin/reviews/:id/:action', adminAuth, requireAdmin, (req, res) => {
    const a = req.params.action;
    if (a !== 'approve' && a !== 'hide') return res.status(400).json({ error: 'bad_action' });
    res.json({ ok: service.admin.setReview(req.params.id, a === 'approve') });
  });
  app.post('/api/v1/admin/orders/:id/status', adminAuth, requireAdmin, json, (req, res) => {
    res.json({ ok: service.admin.setOrderStatus(req.params.id, String(req.body && req.body.status)) });
  });
  // Этапы заказа, трекинг доставки, получение оплаты наличными
  app.post('/api/v1/admin/orders/:id/stage', adminAuth, requireAdmin, json, (req, res) => {
    res.json(service.admin.setStage(req.params.id, req.body && req.body.stage, req.body && req.body.note));
  });
  app.post('/api/v1/admin/orders/:id/tracking', adminAuth, requireAdmin, json, (req, res) => {
    res.json(service.admin.setTracking(req.params.id, req.body));
  });
  app.post('/api/v1/admin/orders/:id/paid', adminAuth, requireAdmin, json, (req, res) => {
    res.json(service.admin.markPaid(req.params.id));
  });
  // Платёжные шлюзы: какие ключи введены, адреса webhook, проверка ключей
  app.get('/api/v1/admin/payments', adminAuth, requireAdmin, (req, res) => res.json(service.admin.paymentsStatus()));
  app.post('/api/v1/admin/payments/:name/check', adminAuth, requireAdmin, wrap(async (req, res) => res.json(await service.admin.checkPayment(req.params.name))));
  // Каталог: сайт присылает свои товары и цены
  app.post('/api/v1/admin/products/sync', adminAuth, requireAdmin, express.json({ limit: '300kb' }), (req, res) => {
    res.json(service.admin.syncProducts(req.body && req.body.products));
  });

  // Сам сайт (только эти два адреса — других файлов сервер не раздаёт)
  if (siteHtml) {
    const serveSite = (req, res) => { res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.send(siteHtml); };
    app.get('/', serveSite);
    app.get('/index.html', serveSite);
  }

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err && (err.type === 'entity.too.large' || err.type === 'entity.parse.failed')) return res.status(400).json({ error: 'bad_request' });
    console.error('[error]', err);
    res.status(500).json({ error: 'server_error' });
  });

  return app;
}

module.exports = { createApp };
