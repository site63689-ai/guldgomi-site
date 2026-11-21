'use strict';
const path = require('node:path');

const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const trimSlash = s => String(s || '').trim().replace(/\/+$/, '');
const pem = v => String(v || '').replace(/\\n/g, '\n').trim();

function makeConfig(env = process.env) {
  const publicBaseUrl = trimSlash(env.PUBLIC_BASE_URL);
  const siteUrl = trimSlash(env.SITE_URL);
  // Без этих двух адресов банку нечего сообщить в callback и некуда вернуть покупателя
  const urlsReady = !!publicBaseUrl && !!siteUrl;

  const bog = {
    clientId: (env.BOG_CLIENT_ID || '').trim(),
    clientSecret: (env.BOG_CLIENT_SECRET || '').trim(),
    publicKey: pem(env.BOG_CALLBACK_PUBLIC_KEY),
    apiBase: trimSlash(env.BOG_API_BASE || 'https://api.bog.ge'),
    authUrl: (env.BOG_AUTH_URL || 'https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token').trim()
  };
  bog.enabled = !!(bog.clientId && bog.clientSecret && urlsReady);

  const tbc = {
    apiKey: (env.TBC_API_KEY || '').trim(),
    clientId: (env.TBC_CLIENT_ID || '').trim(),
    clientSecret: (env.TBC_CLIENT_SECRET || '').trim(),
    apiBase: trimSlash(env.TBC_API_BASE || 'https://api.tbcbank.ge'),
    // Проверка IP банка по документации TBC. По умолчанию выключена: статус всё равно перепроверяется через API
    enforceIp: env.TBC_ENFORCE_IP === 'true',
    callbackIps: list(env.TBC_CALLBACK_IPS || '193.104.20.44,193.104.20.45,185.52.80.44,185.52.80.45')
  };
  tbc.enabled = !!(tbc.apiKey && tbc.clientId && tbc.clientSecret && urlsReady);

  return {
    port: Number(env.PORT) || 3000,
    publicBaseUrl,
    siteUrl,
    allowedOrigins: list(env.ALLOWED_ORIGINS || env.SITE_URL).map(trimSlash),
    dbPath: env.DB_PATH || path.join(process.cwd(), 'data', 'shop.db'),
    adminToken: env.ADMIN_TOKEN || '',
    defaultGateway: String(env.DEFAULT_PAYMENT_GATEWAY || '').toLowerCase(),
    telegram: { token: (env.TELEGRAM_BOT_TOKEN || '').trim(), chatId: (env.TELEGRAM_CHAT_ID || '').trim() },
    assistant: {
      apiKey: (env.ANTHROPIC_API_KEY || '').trim(),
      model: (env.ANTHROPIC_MODEL || 'claude-haiku-5-5').trim(),
      dailyLimit: Number(env.ASSISTANT_DAILY_LIMIT) || 300,
      perIpDaily: Number(env.ASSISTANT_PER_IP_DAILY) || 60,
      kbPath: env.KNOWLEDGE_BASE_PATH || path.join(__dirname, '..', 'knowledge', 'knowledge_base.md')
    },
    reconcileEveryMs: (Number(env.RECONCILE_MINUTES) || 5) * 60 * 1000,
    bog,
    tbc
  };
}

function configWarnings(cfg) {
  const w = [];
  if (!cfg.publicBaseUrl) w.push('PUBLIC_BASE_URL не задан — банки отключены (нужен адрес для callback).');
  if (!cfg.siteUrl) w.push('SITE_URL не задан — банки отключены (некуда вернуть покупателя).');
  if (cfg.publicBaseUrl && !cfg.publicBaseUrl.startsWith('https://')) w.push('PUBLIC_BASE_URL должен начинаться с https:// (банки требуют HTTPS для callback).');
  if (!cfg.allowedOrigins.length) w.push('ALLOWED_ORIGINS пуст — браузер сайта не сможет обращаться к серверу.');
  if (!cfg.bog.enabled && !cfg.tbc.enabled) w.push('Ни один банк не настроен — онлайн-оплата отключена (заказы «курьеру/на месте» работают).');
  if (cfg.bog.enabled && !cfg.bog.publicKey) w.push('BOG_CALLBACK_PUBLIC_KEY не задан — подпись callback BOG не проверяется (статус всё равно перепроверяется через API банка).');
  if (!cfg.telegram.token || !cfg.telegram.chatId) w.push('Telegram не настроен — уведомления отключены.');
  if (!cfg.assistant.apiKey) w.push('ANTHROPIC_API_KEY не задан — ИИ-ассистент отключён (в виджете будут контакты поддержки).');
  if (!cfg.adminToken) w.push('ADMIN_TOKEN не задан — админ-API выключен.');
  return w;
}

module.exports = { makeConfig, configWarnings };
