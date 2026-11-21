'use strict';
console.log('Guldgomi: запуск...');
const fs = require('node:fs');
const path = require('node:path');
const { makeConfig } = require('./config');
const { openDb } = require('./db');
const { makeTelegram } = require('./telegram');
const { makeBog } = require('./payments/bog');
const { makeTbc } = require('./payments/tbc');
const { makePayments } = require('./payments');
const { makeService } = require('./service');
const { seedProductsIfEmpty } = require('./seed');
const { createApp } = require('./app');
const { createAssistantFromConfig } = require('./assistant');
const { injectApiUrl } = require('./site');

// Случайная ошибка в одном запросе не должна ронять весь сервер
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e && e.stack || e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e && e.stack || e));

const cfg = makeConfig();
const db = openDb(cfg.dbPath);
seedProductsIfEmpty(db);

const telegram = makeTelegram(cfg);
const payments = makePayments(cfg, { bog: makeBog(cfg), tbc: makeTbc(cfg) });
const service = makeService({ db, cfg, payments, telegram });
const assistant = createAssistantFromConfig(cfg);
// Сайт лежит в public/index.html. Адрес сервера подставляется в страницу автоматически (PUBLIC_BASE_URL или адрес страницы)
const SITE_FILE = path.join(__dirname, '..', 'public', 'index.html');
let siteHtml = null;
if (fs.existsSync(SITE_FILE)) siteHtml = injectApiUrl(fs.readFileSync(SITE_FILE, 'utf8'), cfg.publicBaseUrl);
const app = createApp({ cfg, service, assistant, siteHtml });

const server = app.listen(cfg.port, () => {
  console.log(`Guldgomi server запущен на порту ${cfg.port}`);
  console.log('Сайт на главной странице:', siteHtml ? 'да (public/index.html)' : 'нет — положите index.html в папку public/');
  console.log('ИИ-ассистент:', assistant ? `включён (${cfg.assistant.provider}, ${cfg.assistant.model}${cfg.assistant.fallbackModels.length ? ', запасная ' + cfg.assistant.fallbackModels.join(', ') : ''})` : 'выключен (нет GEMINI_API_KEY) — в виджете будут контакты поддержки');
  // Всё ниже необязательно — это не ошибки
  const off = [];
  if (!payments.enabledNames().length) off.push('онлайн-оплата банками');
  if (!telegram.enabled) off.push('Telegram-уведомления');
  if (!cfg.adminToken) off.push('админ-API');
  console.log('Необязательные функции выключены:', off.join(', ') || '—');
});

// Страховка: если webhook потерялся, раз в несколько минут сверяем неоплаченные заказы с банком
const timer = setInterval(() => service.reconcilePending().catch(e => console.error('[reconcile]', e.message)), cfg.reconcileEveryMs);
timer.unref();

function shutdown() {
  clearInterval(timer);
  server.close(() => { try { db.close(); } catch (e) { /* ignore */ } process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
