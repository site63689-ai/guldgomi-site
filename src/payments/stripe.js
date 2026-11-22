'use strict';
/**
 * Модуль оплаты Stripe (Checkout Sessions, без SDK — обычный REST).
 * Документация: https://docs.stripe.com/api/checkout/sessions
 *
 *  1. Платёж:  POST /v1/checkout/sessions  (form-urlencoded)  -> id (cs_...) + url (страница оплаты Stripe)
 *  2. Статус:  GET  /v1/checkout/sessions/{id}                -> payment_status: paid | unpaid
 *  3. Webhook: POST на /api/v1/webhooks/stripe, заголовок Stripe-Signature = t=<время>,v1=<HMAC-SHA256>
 *              подпись считается по строке "<t>.<сырое тело>" секретом whsec_...
 * Данные карты вводятся на странице Stripe — на сайт и сервер они не попадают.
 */
const crypto = require('node:crypto');
const { isTrustedUrl, clean } = require('../util');

const TRUSTED_DOMAINS = ['stripe.com'];
const TOLERANCE_SEC = 300;

function mapSession(s) {
  if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') {
    const charge = s.payment_intent && typeof s.payment_intent === 'object' ? s.payment_intent.latest_charge : null;
    if (charge && typeof charge === 'object' && charge.refunded === true) return 'refunded';
    return 'paid';
  }
  if (s.status === 'expired') return 'failed';
  return 'pending'; // open, либо complete + unpaid (отложенные способы оплаты)
}

function makeStripe(cfg) {
  const c = cfg.stripe;

  async function call(method, path, form, extraHeaders = {}) {
    return fetch(c.apiBase + path, {
      method,
      headers: { Authorization: 'Bearer ' + c.secretKey, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...extraHeaders },
      body: form ? form.toString() : undefined,
      signal: AbortSignal.timeout(15000)
    });
  }

  async function errorText(res) {
    try { const j = await res.json(); return (j.error && (j.error.message || j.error.code)) || ''; } catch (e) { return ''; }
  }

  /** order: строка из БД с items (priceTetri, qty, name) */
  async function createPayment(order) {
    const f = new URLSearchParams();
    f.set('mode', 'payment');
    f.set('success_url', `${cfg.siteUrl}/?payment=success&order=${encodeURIComponent(order.id)}`);
    f.set('cancel_url', `${cfg.siteUrl}/?payment=fail&order=${encodeURIComponent(order.id)}`);
    f.set('client_reference_id', order.id);
    f.set('metadata[order_id]', order.id);
    f.set('payment_intent_data[metadata][order_id]', order.id);
    f.set('locale', order.lang === 'ru' ? 'ru' : order.lang === 'en' ? 'en' : 'auto');
    f.set('expires_at', String(Math.floor(Date.now() / 1000) + 31 * 60)); // Stripe: не меньше 30 минут
    order.items.forEach((it, i) => {
      f.set(`line_items[${i}][quantity]`, String(it.qty));
      f.set(`line_items[${i}][price_data][currency]`, c.currency);
      f.set(`line_items[${i}][price_data][unit_amount]`, String(it.priceTetri));
      f.set(`line_items[${i}][price_data][product_data][name]`, clean((it.name && (it.name[order.lang] || it.name.en || it.name.ru || it.name.ka)) || 'Item ' + it.id, 120));
    });
    const res = await call('POST', '/v1/checkout/sessions', f, { 'Idempotency-Key': 'guldgomi-' + order.id });
    if (!res.ok) throw new Error(`Stripe create session: HTTP ${res.status} ${await errorText(res)}`.trim());
    const j = await res.json();
    if (!j.id || !String(j.id).startsWith('cs_') || !isTrustedUrl(j.url, TRUSTED_DOMAINS)) throw new Error('Stripe create session: unexpected response');
    return { paymentId: String(j.id), redirectUrl: j.url };
  }

  /** Всегда спрашиваем статус у Stripe напрямую — содержимому webhook не доверяем */
  async function getStatus(paymentId) {
    const res = await call('GET', `/v1/checkout/sessions/${encodeURIComponent(paymentId)}?expand[]=payment_intent.latest_charge`);
    if (!res.ok) throw new Error(`Stripe retrieve session: HTTP ${res.status}`);
    const j = await res.json();
    return {
      status: mapSession(j),
      rawStatus: `${j.status || ''}/${j.payment_status || ''}`,
      amountTetri: Number.isInteger(j.amount_total) ? j.amount_total : null,
      currency: j.currency ? String(j.currency).toUpperCase() : null,
      externalOrderId: j.client_reference_id || null
    };
  }

  function verifySignature(rawBody, header) {
    if (!c.webhookSecret || !header) return false;
    const parts = String(header).split(',').map(p => p.trim().split('='));
    const t = (parts.find(p => p[0] === 't') || [])[1];
    const sigs = parts.filter(p => p[0] === 'v1').map(p => p[1]).filter(Boolean);
    if (!t || !sigs.length || !/^\d+$/.test(t)) return false;
    if (Math.abs(Date.now() / 1000 - Number(t)) > TOLERANCE_SEC) return false;
    const expected = crypto.createHmac('sha256', c.webhookSecret).update(`${t}.${rawBody.toString('utf8')}`).digest();
    return sigs.some(s => {
      try { const b = Buffer.from(s, 'hex'); return b.length === expected.length && crypto.timingSafeEqual(b, expected); } catch (e) { return false; }
    });
  }

  function parseWebhook(rawBody, headers) {
    const signatureOk = verifySignature(rawBody, headers['stripe-signature']);
    let j = null;
    try { j = JSON.parse(rawBody.toString('utf8')); } catch (e) { /* не JSON */ }
    const obj = j && j.data && j.data.object;
    const isSession = j && typeof j.type === 'string' && j.type.startsWith('checkout.session.') && obj && typeof obj.id === 'string' && obj.id.startsWith('cs_');
    return { signatureChecked: true, signatureOk, paymentId: isSession ? obj.id : null, ignored: !isSession, externalOrderId: isSession ? obj.client_reference_id || null : null };
  }

  /** Проверка ключа без создания платежа (кнопка «Проверить» в админке) */
  async function checkCredentials() {
    const res = await call('GET', '/v1/checkout/sessions?limit=1');
    if (res.status === 401) throw new Error('Stripe отклонил ключ (HTTP 401): проверьте STRIPE_SECRET_KEY');
    if (res.status === 403) throw new Error('У ключа нет прав на Checkout Sessions (HTTP 403): создайте ключ с правами Write на Checkout Sessions');
    if (!res.ok) throw new Error(`Stripe ответил HTTP ${res.status}`);
    return { mode: /^(sk|rk)_live_/.test(c.secretKey) ? 'live' : 'test' };
  }

  return { name: 'stripe', enabled: c.enabled, createPayment, getStatus, parseWebhook, checkCredentials, _mapSession: mapSession };
}

module.exports = { makeStripe };
