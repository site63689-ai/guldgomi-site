'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { makeConfig, configWarnings } = require('./config');
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

const cfg = makeConfig();
const db = openDb(cfg.dbPath);
seedProductsIfEmpty(db);

const telegram = makeTelegram(cfg);
const payments = makePayments(cfg, { bog: makeBog(cfg), tbc: makeTbc(cfg) });
const service = makeService({ db, cfg, payments, telegram });
const assistant = createAssistantFromConfig(cfg);
// Сайт лежит в public/index.html. Если задан PUBLIC_BASE_URL, адрес сервера подставляется в страницу автоматически
const SITE_FILE = path.join(__dirname, '..', 'public', 'index.html');
let siteHtml = null;
if (fs.existsSync(SITE_FILE)) {
  siteHtml = injectApiUrl(fs.readFileSync(SITE_FILE, 'utf8'), cfg.publicBaseUrl);
}
const app = createApp({ cfg, service, assistant, siteHtml });

const server = app.listen(cfg.port, () => {
  console.log(`Guldgomi server запущен на порту ${cfg.port}`);
  console.log('Онлайн-оплата доступна через:', payments.enabledNames().join(', ') || '— (ни один банк не настроен)');
  console.log('ИИ-ассистент:', assistant ? `включён (${cfg.assistant.provider}, ${cfg.assistant.model})` : 'выключен');
  console.log('Сайт на главной странице:', siteHtml ? 'да (public/index.html)' : 'нет — положите index.html в папку public/');
  console.log('Telegram:', telegram.enabled ? 'включён' : 'выключен');
  configWarnings(cfg).forEach(w => console.warn('⚠️ ', w));
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
