'use strict';
const path = require('node:path');

const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const trimSlash = s => String(s || '').trim().replace(/\/+$/, '');
const pem = v => String(v || '').replace(/\\n/g, '\n').trim();

function makeAssistantConfig(env) {
  // GEMINI тоже принимаем как имя переменной — так её чаще всего называют по ошибке
  const geminiKey = (env.GEMINI_API_KEY || env.GEMINI || '').trim();
  const anthropicKey = (env.ANTHROPIC_API_KEY || '').trim();
  let provider = String(env.AI_PROVIDER || '').toLowerCase();
  if (provider !== 'gemini' && provider !== 'anthropic') provider = geminiKey ? 'gemini' : anthropicKey ? 'anthropic' : '';
  const apiKey = provider === 'gemini' ? geminiKey : provider === 'anthropic' ? anthropicKey : '';
  const model = provider === 'gemini' ? (env.GEMINI_MODEL || 'gemini-flash-latest') : (env.ANTHROPIC_MODEL || 'claude-haiku-5-5');
  return {
    provider, apiKey, model: String(model).trim(),
    // запасные модели Gemini на случай перегрузки основной (через запятую; пусто = без запасных)
    fallbackModels: provider === 'gemini' ? list(env.GEMINI_FALLBACK_MODELS === undefined ? 'gemini-flash-lite-latest,gemini-2.5-flash,gemini-2.5-flash-lite' : env.GEMINI_FALLBACK_MODELS) : [],
    // необязательный запасной провайдер (Groq, бесплатный тариф): подключается, если задан GROQ_API_KEY
    backup: (env.GROQ_API_KEY || '').trim() ? { apiKey: env.GROQ_API_KEY.trim(), model: (env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim(), baseUrl: (env.GROQ_BASE_URL || '').trim() } : null,
    dailyLimit: Number(env.ASSISTANT_DAILY_LIMIT) || 300,
    perIpDaily: Number(env.ASSISTANT_PER_IP_DAILY) || 60,
    kbPath: env.KNOWLEDGE_BASE_PATH || path.join(__dirname, '..', 'knowledge', 'knowledge_base.md')
  };
}

function makeConfig(env = process.env) {
  // Адрес сервера: PUBLIC_BASE_URL, а если его нет — домен, который Railway выдаёт сам (RAILWAY_PUBLIC_DOMAIN)
  const railwayDomain = String(env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  const publicBaseUrl = trimSlash(env.PUBLIC_BASE_URL) || (railwayDomain ? 'https://' + railwayDomain : '');
  // Сайт отдаётся этим же сервером, поэтому SITE_URL по умолчанию совпадает с адресом сервера
  const siteUrl = trimSlash(env.SITE_URL) || publicBaseUrl;
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

  const stripe = {
    secretKey: (env.STRIPE_SECRET_KEY || '').trim(),
    webhookSecret: (env.STRIPE_WEBHOOK_SECRET || '').trim(),
    apiBase: trimSlash(env.STRIPE_API_BASE || 'https://api.stripe.com'),
    currency: 'gel' // суммы на сервере хранятся в тетри (1/100 лари), поэтому Stripe всегда получает GEL
  };
  // Секретный ключ должен начинаться с sk_ или rk_ (ключ pk_ — публичный, им платёж создать нельзя)
  stripe.keyLooksValid = /^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(stripe.secretKey);
  stripe.enabled = stripe.keyLooksValid && urlsReady;

  // Слишком короткий токен администратора не принимаем — это защита заказов и клиентов
  const adminTokenRaw = String(env.ADMIN_TOKEN || '');

  return {
    port: Number(env.PORT) || 8000,
    publicBaseUrl,
    siteUrl,
    allowedOrigins: list(env.ALLOWED_ORIGINS || env.SITE_URL || publicBaseUrl).map(trimSlash),
    dbPath: env.DB_PATH || path.join(process.cwd(), 'data', 'shop.db'),
    adminToken: adminTokenRaw.length >= 16 ? adminTokenRaw : '',
    adminTokenTooShort: adminTokenRaw.length > 0 && adminTokenRaw.length < 16,
    defaultGateway: String(env.DEFAULT_PAYMENT_GATEWAY || '').toLowerCase(),
    telegram: { token: (env.TELEGRAM_BOT_TOKEN || '').trim(), chatId: (env.TELEGRAM_CHAT_ID || '').trim() },
    assistant: makeAssistantConfig(env),
    reconcileEveryMs: (Number(env.RECONCILE_MINUTES) || 5) * 60 * 1000,
    bog,
    tbc,
    stripe
  };
}

function configWarnings(cfg) {
  const w = [];
  if (!cfg.publicBaseUrl) w.push('PUBLIC_BASE_URL не задан — банки отключены (нужен адрес для callback).');
  if (!cfg.siteUrl) w.push('SITE_URL не задан — банки отключены (некуда вернуть покупателя).');
  if (cfg.publicBaseUrl && !cfg.publicBaseUrl.startsWith('https://')) w.push('PUBLIC_BASE_URL должен начинаться с https:// (банки требуют HTTPS для callback).');
  if (!cfg.allowedOrigins.length) w.push('ALLOWED_ORIGINS пуст — браузер сайта не сможет обращаться к серверу.');
  if (!cfg.bog.enabled && !cfg.tbc.enabled && !cfg.stripe.enabled) w.push('Ни один банк не настроен — онлайн-оплата отключена (заказы «курьеру/на месте» работают).');
  if (cfg.bog.enabled && !cfg.bog.publicKey) w.push('BOG_CALLBACK_PUBLIC_KEY не задан — подпись callback BOG не проверяется (статус всё равно перепроверяется через API банка).');
  if (!cfg.telegram.token || !cfg.telegram.chatId) w.push('Telegram не настроен — уведомления отключены.');
  if (!cfg.assistant.apiKey) w.push('Ключ ИИ не задан (GEMINI_API_KEY или ANTHROPIC_API_KEY) — ИИ-ассистент отключён (в виджете будут контакты поддержки).');
  if (cfg.adminTokenTooShort) w.push('ADMIN_TOKEN короче 16 символов — админ-API выключен. Задайте длинный случайный пароль.');
  else if (!cfg.adminToken) w.push('ADMIN_TOKEN не задан — админ-API выключен.');
  return w;
}

module.exports = { makeConfig, configWarnings };
