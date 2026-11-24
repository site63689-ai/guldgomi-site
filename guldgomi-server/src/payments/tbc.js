'use strict';
/**
 * Модуль оплаты TBC Bank (E-Commerce / TPay API).
 * Документация: https://developers.tbcbank.ge
 *
 *  1. Токен:   POST https://api.tbcbank.ge/v1/tpay/access-token   (заголовок apikey, form: client_id, client_secret)
 *  2. Платёж:  POST https://api.tbcbank.ge/v1/tpay/payments       -> payId + links[rel=approval_url]
 *  3. Статус:  GET  https://api.tbcbank.ge/v1/tpay/payments/{payId}
 *  4. Callback от банка: POST на callbackUrl с телом, содержащим PaymentId.
 *     URL callback ТАКЖЕ нужно прописать в кабинете мерчанта (ecom.tbcpayments.ge, Website Management -> Callback).
 */
const { isTrustedUrl } = require('../util');

const TRUSTED_DOMAINS = ['tbcbank.ge', 'tbcpayments.ge'];

function mapStatus(s) {
  switch (String(s || '')) {
    case 'Succeeded': return 'paid';
    case 'Failed':
    case 'Expired': return 'failed';
    case 'Returned':
    case 'PartialReturned': return 'refunded';
    default: return 'pending'; // Created, Processing, WaitingConfirm ...
  }
}

const lari = tetri => Number((tetri / 100).toFixed(2));

function makeTbc(cfg) {
  const c = cfg.tbc;
  const cache = { token: '', exp: 0 };

  async function getToken(force = false) {
    if (!force && cache.token && Date.now() < cache.exp) return cache.token;
    const res = await fetch(`${c.apiBase}/v1/tpay/access-token`, {
      method: 'POST',
      headers: { apikey: c.apiKey, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret }).toString(),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`TBC auth failed: HTTP ${res.status}`);
    const j = await res.json();
    if (!j.access_token) throw new Error('TBC auth: no access_token in response');
    let ttl = Number(j.expires_in) || 1800;
    if (ttl > 3600) ttl = 3600;
    cache.token = j.access_token;
    cache.exp = Date.now() + Math.max(ttl - 30, 5) * 1000;
    return cache.token;
  }

  async function authed(method, url, body) {
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getToken(attempt > 0);
      res = await fetch(url, {
        method,
        headers: { apikey: c.apiKey, Authorization: 'Bearer ' + token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000)
      });
      if (res.status !== 401) return res;
    }
    return res;
  }

  async function createPayment(order) {
    const total = lari(order.total_tetri);
    const body = {
      amount: { currency: 'GEL', total, subTotal: total, tax: 0, shipping: 0 },
      returnurl: `${cfg.siteUrl}/?payment=return&order=${encodeURIComponent(order.id)}`,
      callbackUrl: `${cfg.publicBaseUrl}/api/v1/webhooks/tbc`,
      expirationMinutes: 12,
      language: order.lang === 'ka' ? 'KA' : 'EN',
      merchantPaymentId: order.id,
      extra: order.id.slice(0, 25),
      description: 'Guldgomi Honey'
    };
    const res = await authed('POST', `${c.apiBase}/v1/tpay/payments`, body);
    if (!res.ok) throw new Error(`TBC create payment: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    const link = Array.isArray(j.links) ? j.links.find(l => l.rel === 'approval_url') : null;
    const redirectUrl = link && link.uri;
    if (!j.payId || !isTrustedUrl(redirectUrl, TRUSTED_DOMAINS)) throw new Error('TBC create payment: unexpected response');
    return { paymentId: String(j.payId), redirectUrl };
  }

  async function getStatus(paymentId) {
    const res = await authed('GET', `${c.apiBase}/v1/tpay/payments/${encodeURIComponent(paymentId)}`);
    if (!res.ok) throw new Error(`TBC payment details: HTTP ${res.status}`);
    const j = await res.json();
    return {
      status: mapStatus(j.status),
      rawStatus: j.status || null,
      amountTetri: j.amount == null ? null : Math.round(Number(j.amount) * 100),
      currency: j.currency || null,
      externalOrderId: null
    };
  }

  function parseWebhook(rawBody, headers, ip) {
    let j = null;
    try { j = JSON.parse(rawBody.toString('utf8')); } catch (e) { /* не JSON */ }
    const paymentId = j && (j.PaymentId || j.paymentId || j.payId);
    const ipOk = !c.enforceIp || (ip && c.callbackIps.includes(ip));
    return { signatureChecked: c.enforceIp, signatureOk: ipOk, paymentId: paymentId ? String(paymentId) : null, externalOrderId: null };
  }

  /** Проверка ключей без создания платежа: просто получаем токен */
  async function checkCredentials() {
    await getToken(true);
    return {};
  }

  return { name: 'tbc', enabled: c.enabled, createPayment, getStatus, parseWebhook, checkCredentials, _mapStatus: mapStatus };
}

module.exports = { makeTbc };
