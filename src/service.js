'use strict';
/**
 * Вся бизнес-логика без привязки к Express (чтобы её можно было тестировать отдельно).
 * Цены всегда берутся из базы сервера — цифрам из браузера не доверяем.
 */
const crypto = require('node:crypto');
const { HttpError, clean, digits, nowIso } = require('./util');
const { analyzeMessage } = require('./analysis');

const LANGS = ['ru', 'ka', 'en'];
const OFFLINE_METHODS = ['courier', 'cash'];
const MAX_QTY = 50;
const MAX_LINES = 30;

function makeService({ db, cfg, payments, telegram }) {
  const q = {
    product: db.prepare('SELECT * FROM products WHERE id = ? AND active = 1'),
    products: db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY id'),
    orderById: db.prepare('SELECT * FROM orders WHERE id = ?'),
    orderByProvider: db.prepare('SELECT * FROM orders WHERE provider = ? AND provider_payment_id = ?'),
    insertOrder: db.prepare(`INSERT INTO orders (id, created_at, updated_at, customer_name, phone, address, lang, items_json, total_tetri, currency, method, status)
                             VALUES (@id, @now, @now, @name, @phone, @address, @lang, @items, @total, 'GEL', @method, @status)`),
    setProvider: db.prepare('UPDATE orders SET provider = ?, provider_payment_id = ?, updated_at = ? WHERE id = ?'),
    transition: db.prepare('UPDATE orders SET status = ?, updated_at = ?, paid_at = COALESCE(?, paid_at), note = COALESCE(?, note) WHERE id = ? AND status = ?'),
    setStatusAny: db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?'),
    pending: db.prepare(`SELECT * FROM orders WHERE status = 'pending_payment' AND provider_payment_id IS NOT NULL AND created_at < ? AND created_at > ?`),
    orderByPhone: db.prepare('SELECT id, phone FROM orders'),
    insertReview: db.prepare('INSERT INTO reviews (created_at, author, rating, text, order_id, approved) VALUES (?, ?, ?, ?, ?, 0)'),
    approvedReviews: db.prepare('SELECT id, created_at, author, rating, text FROM reviews WHERE approved = 1 ORDER BY id DESC LIMIT 100'),
    allReviews: db.prepare('SELECT * FROM reviews ORDER BY id DESC LIMIT 500'),
    setReview: db.prepare('UPDATE reviews SET approved = ? WHERE id = ?'),
    insertMessage: db.prepare('INSERT INTO messages (created_at, text, lang, category, priority) VALUES (?, ?, ?, ?, ?)'),
    allMessages: db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 500'),
    allOrders: db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500'),
    insertEvent: db.prepare('INSERT INTO payment_events (created_at, provider, payload) VALUES (?, ?, ?)')
  };

  const parseItems = o => ({ ...o, items: JSON.parse(o.items_json) });

  function newOrderId() {
    for (let i = 0; i < 20; i++) {
      const id = 'ORD-' + crypto.randomInt(100000, 1000000);
      if (!q.orderById.get(id)) return id;
    }
    throw new HttpError(500, 'id_generation_failed');
  }

  function publicMethods() {
    return { online: payments.enabledNames(), offline: OFFLINE_METHODS };
  }

  // ---------- Каталог ----------
  function listProducts() {
    return q.products.all().map(p => ({ id: p.id, priceTetri: p.price_tetri, name: { ru: p.name_ru, ka: p.name_ka, en: p.name_en } }));
  }

  // ---------- Заказ ----------
  function validateOrderInput(body) {
    const b = body && typeof body === 'object' ? body : {};
    const c = b.customer && typeof b.customer === 'object' ? b.customer : {};
    const name = clean(c.name, 100);
    const phone = clean(c.phone, 30);
    const address = clean(c.address, 300);
    if (!name || !address) throw new HttpError(400, 'missing_fields', 'Name and address are required');
    if (digits(phone).length < 7 || digits(phone).length > 15) throw new HttpError(400, 'bad_phone', 'Invalid phone number');
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > MAX_LINES) throw new HttpError(400, 'bad_items', 'Cart is empty or too large');
    const merged = new Map();
    for (const it of b.items) {
      const id = Number(it && it.id);
      const qty = Number(it && it.qty);
      if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new HttpError(400, 'bad_items', 'Invalid item');
      merged.set(id, Math.min((merged.get(id) || 0) + qty, MAX_QTY));
    }
    const method = String(b.method || '').toLowerCase();
    if (![...OFFLINE_METHODS, 'bog', 'tbc'].includes(method)) throw new HttpError(400, 'bad_method', 'Unknown payment method');
    const lang = LANGS.includes(b.lang) ? b.lang : 'ru';
    return { name, phone, address, items: merged, method, lang };
  }

  async function createOrder(body) {
    const v = validateOrderInput(body);

    // Цены и названия — только из базы
    const items = [];
    let total = 0;
    for (const [id, qty] of v.items) {
      const p = q.product.get(id);
      if (!p) throw new HttpError(400, 'unknown_product', `Product ${id} is not available`);
      items.push({ id: p.id, qty, priceTetri: p.price_tetri, name: { ru: p.name_ru, ka: p.name_ka, en: p.name_en } });
      total += p.price_tetri * qty;
    }
    if (total <= 0) throw new HttpError(400, 'bad_total', 'Order total must be positive');

    const online = !OFFLINE_METHODS.includes(v.method);
    let provider = null;
    if (online) {
      provider = payments.get(v.method);
      if (!provider || !provider.enabled) throw new HttpError(400, 'method_unavailable', 'This payment method is not available');
    }

    const id = newOrderId();
    q.insertOrder.run({ id, now: nowIso(), name: v.name, phone: v.phone, address: v.address, lang: v.lang, items: JSON.stringify(items), total, method: v.method, status: online ? 'pending_payment' : 'new' });
    let order = parseItems(q.orderById.get(id));

    if (!online) {
      telegram.newOrder(order);
      return { orderId: id, status: 'new', totalTetri: total };
    }

    try {
      const pay = await provider.createPayment(order);
      q.setProvider.run(provider.name, pay.paymentId, nowIso(), id);
      return { orderId: id, status: 'pending_payment', totalTetri: total, redirectUrl: pay.redirectUrl };
    } catch (e) {
      console.error(`[${provider.name}] createPayment failed for ${id}:`, e.message);
      q.setStatusAny.run('failed', nowIso(), id);
      throw new HttpError(502, 'payment_create_failed', 'Could not create the payment');
    }
  }

  // Публичный статус: нужен и номер заказа, и телефон (последние цифры), чтобы нельзя было перебирать чужие заказы
  function publicOrderStatus(id, phone) {
    const o = q.orderById.get(clean(id, 20));
    const pd = digits(phone);
    const od = o ? digits(o.phone) : '';
    if (!o || pd.length < 7 || !(od.endsWith(pd) || pd.endsWith(od))) throw new HttpError(404, 'not_found');
    return { orderId: o.id, status: o.status, totalTetri: o.total_tetri };
  }

  // ---------- Оплата: единая точка обработки результата ----------
  async function reconcileOrder(order) {
    const provider = payments.get(order.provider);
    if (!provider || !provider.enabled || !order.provider_payment_id) return null;
    const info = await provider.getStatus(order.provider_payment_id);
    return applyBankStatus(order, info);
  }

  function applyBankStatus(order, info) {
    const now = nowIso();
    if (info.status === 'paid') {
      const amountOk = info.amountTetri === order.total_tetri && (!info.currency || info.currency === 'GEL');
      if (!amountOk) {
        const changed = q.transition.run('review', now, null, 'Amount mismatch: bank=' + info.amountTetri + ' ' + info.currency, order.id, 'pending_payment').changes;
        if (changed) telegram.mismatch(order, `${(info.amountTetri / 100).toFixed(2)} ${info.currency || ''}`);
        return 'review';
      }
      // переход выполняется ровно один раз — повторный webhook не даст второго уведомления
      const changed = q.transition.run('paid', now, now, null, order.id, 'pending_payment').changes;
      if (changed) telegram.paid(parseItems(q.orderById.get(order.id)));
      return 'paid';
    }
    if (info.status === 'failed') {
      const changed = q.transition.run('failed', now, null, null, order.id, 'pending_payment').changes;
      if (changed) telegram.failed(order);
      return 'failed';
    }
    if (info.status === 'refunded') {
      const changed = q.transition.run('refunded', now, null, null, order.id, 'paid').changes;
      if (changed) telegram.refunded(order);
      return 'refunded';
    }
    return 'pending';
  }

  async function handleWebhook(providerName, rawBody, headers, ip) {
    const provider = payments.get(providerName);
    if (!provider || !provider.enabled) throw new HttpError(404, 'not_found');
    const evt = provider.parseWebhook(rawBody, headers, ip);
    q.insertEvent.run(nowIso(), providerName, rawBody.toString('utf8').slice(0, 4000));
    if (!evt.signatureOk) {
      console.warn(`[${providerName}] webhook rejected: bad signature/ip`);
      throw new HttpError(401, 'bad_signature');
    }
    if (!evt.paymentId) throw new HttpError(400, 'no_payment_id');
    const order = q.orderByProvider.get(providerName, evt.paymentId);
    if (!order) {
      console.warn(`[${providerName}] webhook for unknown payment ${evt.paymentId}`);
      return { ok: true, ignored: true }; // отвечаем 200, чтобы банк не слал повторы бесконечно
    }
    // Не верим содержимому callback — спрашиваем статус у банка напрямую
    const result = await reconcileOrder(order);
    return { ok: true, result };
  }

  async function reconcilePending() {
    const olderThan = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const newerThan = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    for (const o of q.pending.all(olderThan, newerThan)) {
      try { await reconcileOrder(o); } catch (e) { console.error('[reconcile]', o.id, e.message); }
    }
  }

  // ---------- Отзывы ----------
  function createReview(body) {
    const b = body && typeof body === 'object' ? body : {};
    const author = clean(b.author, 80);
    const text = clean(b.text, 1000);
    const rating = Number(b.rating);
    const ref = clean(b.orderRef, 40);
    if (!author || !text || !Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'bad_review');
    const rd = digits(ref);
    // Отзыв может оставить только тот, у кого есть заказ (по номеру заказа или телефону)
    const match = q.orderByPhone.all().find(o => o.id.toLowerCase() === ref.replace(/\s+/g, '').toLowerCase() || (rd.length >= 7 && digits(o.phone).length >= 7 && (digits(o.phone).endsWith(rd) || rd.endsWith(digits(o.phone)))));
    if (!match) throw new HttpError(403, 'not_a_buyer');
    const r = q.insertReview.run(nowIso(), author, rating, text, match.id);
    telegram.review({ author, rating, text, order_id: match.id });
    return { id: Number(r.lastInsertRowid), status: 'pending_moderation' };
  }

  // ---------- Чат ----------
  function createChatMessage(body) {
    const b = body && typeof body === 'object' ? body : {};
    const text = clean(b.text, 1000);
    if (!text) throw new HttpError(400, 'empty_message');
    const lang = LANGS.includes(b.lang) ? b.lang : 'ru';
    const a = analyzeMessage(text);
    q.insertMessage.run(nowIso(), text, lang, a.category, a.priority);
    telegram.chat({ text, lang, ...a });
    return a;
  }

  // ---------- Админ ----------
  const admin = {
    orders: () => q.allOrders.all().map(parseItems),
    reviews: () => q.allReviews.all(),
    messages: () => q.allMessages.all(),
    setReview(id, approved) { return q.setReview.run(approved ? 1 : 0, Number(id)).changes > 0; },
    setOrderStatus(id, status) {
      if (!['new', 'delivered', 'cancelled'].includes(status)) throw new HttpError(400, 'bad_status');
      const o = q.orderById.get(String(id));
      if (!o) throw new HttpError(404, 'not_found');
      // оплату вручную через API не выставляем — только банк
      if (o.status === 'pending_payment' || o.status === 'review') throw new HttpError(409, 'payment_not_final');
      q.setStatusAny.run(status, nowIso(), o.id);
      return true;
    }
  };

  return { listProducts, publicMethods, createOrder, publicOrderStatus, handleWebhook, reconcilePending, createReview, createChatMessage, approvedReviews: () => q.approvedReviews.all(), admin };
}

module.exports = { makeService };
