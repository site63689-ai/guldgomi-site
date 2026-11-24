'use strict';
/**
 * Модуль оплаты Bank of Georgia (BOG Payments API).
 * Документация: https://api.bog.ge/docs/en/payments/introduction
 *
 *  1. Токен:   POST https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token  (client_credentials, Basic)
 *  2. Платёж:  POST https://api.bog.ge/payments/v1/ecommerce/orders   -> id + _links.redirect.href
 *  3. Статус:  GET  https://api.bog.ge/payments/v1/receipt/{order_id}
 *  4. Callback от банка: POST на callback_url, заголовок Callback-Signature (RSA-SHA256 по сырому телу)
 */
const crypto = require('node:crypto');
const { isTrustedUrl, clean } = require('../util');

const TRUSTED_DOMAINS = ['bog.ge'];

function mapStatus(key) {
  switch (String(key || '').toLowerCase()) {
    case 'completed': return 'paid';
    case 'rejected': return 'failed';
    case 'refunded':
    case 'refunded_partially': return 'refunded';
    default: return 'pending'; // created, processing, auth_requested, blocked ...
  }
}

const lari = tetri => Number((tetri / 100).toFixed(2));

function makeBog(cfg) {
  const c = cfg.bog;
  const cache = { token: '', exp: 0 };

  async function getToken(force = false) {
    if (!force && cache.token && Date.now() < cache.exp) return cache.token;
    const res = await fetch(c.authUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`BOG auth failed: HTTP ${res.status}`);
    const j = await res.json();
    if (!j.access_token) throw new Error('BOG auth: no access_token in response');
    // В документации пример expires_in выглядит неверным, поэтому ограничиваем срок кэша сверху.
    // Если токен всё же протух раньше — authed() обновит его при ответе 401.
    let ttl = Number(j.expires_in) || 300;
    if (ttl > 3600) ttl = 3600;
    cache.token = j.access_token;
    cache.exp = Date.now() + Math.max(ttl - 30, 5) * 1000;
    return cache.token;
  }

  async function authed(method, url, { body, headers = {} } = {}) {
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getToken(attempt > 0);
      res = await fetch(url, {
        method,
        headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000)
      });
      if (res.status !== 401) return res;
    }
    return res;
  }

  /** order: строка из БД с items (priceTetri, qty, name) */
  async function createPayment(order) {
    const body = {
      callback_url: `${cfg.publicBaseUrl}/api/v1/webhooks/bog`,
      external_order_id: order.id,
      purchase_units: {
        currency: 'GEL',
        total_amount: lari(order.total_tetri),
        basket: order.items.map(i => ({
          product_id: String(i.id),
          description: clean(i.name.en || i.name.ru || i.name.ka || '', 100),
          quantity: i.qty,
          unit_price: lari(i.priceTetri)
        }))
      },
      redirect_urls: {
        success: `${cfg.siteUrl}/?payment=success&order=${encodeURIComponent(order.id)}`,
        fail: `${cfg.siteUrl}/?payment=fail&order=${encodeURIComponent(order.id)}`
      },
      ttl: 30
    };
    const res = await authed('POST', `${c.apiBase}/payments/v1/ecommerce/orders`, {
      body,
      headers: { 'Idempotency-Key': crypto.randomUUID(), 'Accept-Language': order.lang === 'ka' ? 'ka' : 'en' }
    });
    if (!res.ok) throw new Error(`BOG create order: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    const redirectUrl = j && j._links && j._links.redirect && j._links.redirect.href;
    if (!j.id || !isTrustedUrl(redirectUrl, TRUSTED_DOMAINS)) throw new Error('BOG create order: unexpected response');
    return { paymentId: String(j.id), redirectUrl };
  }

  /** Всегда спрашиваем статус у банка напрямую — содержимому callback не доверяем */
  async function getStatus(paymentId) {
    const res = await authed('GET', `${c.apiBase}/payments/v1/receipt/${encodeURIComponent(paymentId)}`);
    if (!res.ok) throw new Error(`BOG receipt: HTTP ${res.status}`);
    const j = await res.json();
    const key = j && j.order_status && j.order_status.key;
    const amount = j && j.purchase_units && j.purchase_units.request_amount;
    return {
      status: mapStatus(key),
      rawStatus: key || null,
      amountTetri: amount == null ? null : Math.round(Number(amount) * 100),
      currency: (j && j.purchase_units && j.purchase_units.currency_code) || null,
      externalOrderId: (j && j.external_order_id) || null
    };
  }

  function verifySignature(rawBody, signatureB64) {
    if (!signatureB64) return false;
    try {
      const v = crypto.createVerify('RSA-SHA256');
      v.update(rawBody);
      v.end();
      return v.verify(c.publicKey, signatureB64, 'base64');
    } catch (e) {
      return false;
    }
  }

  function parseWebhook(rawBody, headers) {
    const signatureChecked = !!c.publicKey;
    const signatureOk = signatureChecked ? verifySignature(rawBody, headers['callback-signature']) : true;
    let j = null;
    try { j = JSON.parse(rawBody.toString('utf8')); } catch (e) { /* не JSON */ }
    const b = j && j.body;
    return {
      signatureChecked,
      signatureOk,
      paymentId: b && b.order_id ? String(b.order_id) : null,
      externalOrderId: b && b.external_order_id ? String(b.external_order_id) : null
    };
  }

  /** Проверка ключей без создания платежа: просто получаем токен */
  async function checkCredentials() {
    await getToken(true);
    return { signatureKey: !!c.publicKey };
  }

  return { name: 'bog', enabled: c.enabled, createPayment, getStatus, parseWebhook, checkCredentials, _mapStatus: mapStatus };
}

module.exports = { makeBog };
