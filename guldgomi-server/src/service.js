'use strict';
/**
 * Вся бизнес-логика без привязки к Express (чтобы её можно было тестировать отдельно).
 * Цены всегда берутся из базы сервера — цифрам из браузера не доверяем.
 */
const crypto = require('node:crypto');
const { HttpError, clean, digits, nowIso } = require('./util');
const { analyzeMessage } = require('./analysis');
const { upsertProducts } = require('./seed');

const LANGS = ['ru', 'ka', 'en'];
const OFFLINE_METHODS = ['courier', 'cash'];
const ONLINE_METHODS = ['bog', 'tbc', 'stripe'];
// Этапы выполнения заказа (их отмечает владелец). Оплата хранится отдельно, в поле status.
const STAGES = ['new', 'confirmed', 'packing', 'shipped', 'delivered', 'cancelled'];
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
    setStage: db.prepare('UPDATE orders SET stage = ?, updated_at = ?, shipped_at = COALESCE(?, shipped_at), delivered_at = COALESCE(?, delivered_at) WHERE id = ?'),
    setTracking: db.prepare('UPDATE orders SET courier = ?, tracking_code = ?, tracking_url = ?, delivery_note = ?, updated_at = ? WHERE id = ?'),
    markPaidOffline: db.prepare(`UPDATE orders SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ? AND status = 'new' AND provider IS NULL`),
    insertOrderEvent: db.prepare('INSERT INTO order_events (order_id, created_at, kind, detail) VALUES (?, ?, ?, ?)'),
    eventsByOrder: db.prepare('SELECT created_at, kind, detail FROM order_events WHERE order_id = ? ORDER BY id'),
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

  const addEvent = (orderId, kind, detail) => q.insertOrderEvent.run(orderId, nowIso(), kind, detail == null ? null : JSON.stringify(detail));

  /**
   * Одно понятное покупателю состояние: сначала проблемы с оплатой, потом отмена, потом этап выполнения.
   * Ключи совпадают с переводами на сайте (st_...).
   */
  function displayStatus(o) {
    if (['pending_payment', 'failed', 'review', 'refunded'].includes(o.status)) return o.status;
    if (o.stage === 'cancelled' || o.status === 'cancelled') return 'cancelled';
    if (o.stage === 'new' && o.status === 'paid') return 'paid';
    return o.stage || 'new';
  }

  function historyOf(orderId) {
    const out = [];
    for (const e of q.eventsByOrder.all(orderId)) {
      let d = null;
      try { d = e.detail ? JSON.parse(e.detail) : null; } catch (err) { /* ignore */ }
      if (e.kind === 'created') out.push({ key: 'new', at: e.created_at });
      else if (e.kind === 'stage' && d && d.to) out.push({ key: d.to, at: e.created_at, note: d.note || undefined, by: d.by || undefined });
      else if (['paid', 'failed', 'refunded', 'review'].includes(e.kind)) out.push({ key: e.kind, at: e.created_at });
    }
    return out;
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
    if (![...OFFLINE_METHODS, ...ONLINE_METHODS].includes(method)) throw new HttpError(400, 'bad_method', 'Unknown payment method');
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
    addEvent(id, 'created', { method: v.method });

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
    const tracking = (o.courier || o.tracking_code || o.tracking_url || o.delivery_note)
      ? { courier: o.courier || '', code: o.tracking_code || '', url: o.tracking_url || '', note: o.delivery_note || '' } : null;
    // status — состояние оплаты (как раньше); display — то, что показываем покупателю; stage — этап выполнения
    return { orderId: o.id, status: o.status, display: displayStatus(o), stage: o.stage, paid: o.status === 'paid', method: o.method, totalTetri: o.total_tetri, tracking, history: historyOf(o.id).map(h => ({ key: h.key, at: h.at })) };
  }

  // Страница банка возвращает покупателя на сайт раньше, чем придёт webhook, — поэтому при запросе статуса
  // неоплаченного заказа сразу спрашиваем банк (не чаще раза в 5 секунд на заказ)
  const lastRefresh = new Map();
  async function refreshOrderStatus(id, phone) {
    const pub = publicOrderStatus(id, phone);
    if (pub.status === 'pending_payment') {
      const o = q.orderById.get(pub.orderId);
      const last = lastRefresh.get(o.id) || 0;
      if (o.provider_payment_id && Date.now() - last > 5000) {
        lastRefresh.set(o.id, Date.now());
        if (lastRefresh.size > 2000) lastRefresh.clear();
        try { await reconcileOrder(o); } catch (e) { console.error('[refresh]', o.id, e.message); }
        return publicOrderStatus(id, phone);
      }
    }
    return pub;
  }

  // Покупатель подтверждает получение (только когда заказ уже передан в доставку)
  function customerReceived(id, phone) {
    const pub = publicOrderStatus(id, phone);
    const o = q.orderById.get(pub.orderId);
    if (o.stage !== 'shipped') throw new HttpError(409, 'not_shipped', 'The order has not been shipped yet');
    changeStage(o, 'delivered', 'customer', 'customer');
    return publicOrderStatus(id, phone);
  }

  // ---------- Этапы выполнения заказа ----------
  function changeStage(o, stage, note, by) {
    if (!STAGES.includes(stage)) throw new HttpError(400, 'bad_stage');
    // Пока оплата не подтверждена банком, заказ не продвигаем — иначе можно отправить товар без денег
    if (o.status === 'pending_payment' || o.status === 'review') throw new HttpError(409, 'payment_not_final');
    if ((o.status === 'failed' || o.status === 'refunded') && stage !== 'cancelled') throw new HttpError(409, 'payment_invalid');
    if (o.stage === stage) return false;
    const now = nowIso();
    q.setStage.run(stage, now, stage === 'shipped' ? now : null, stage === 'delivered' ? now : null, o.id);
    // Оплата курьеру/на месте считается полученной, когда заказ вручён
    if (stage === 'delivered' && o.status === 'new' && !o.provider && q.markPaidOffline.run(now, now, o.id).changes) addEvent(o.id, 'paid', { provider: 'offline', auto: true });
    addEvent(o.id, 'stage', { from: o.stage, to: stage, note: clean(note, 200) || undefined, by: by || 'admin' });
    // Оплаченный онлайн заказ отменили — владельцу нужно вернуть деньги в кабинете банка
    if (stage === 'cancelled' && o.status === 'paid' && o.provider && typeof telegram.send === 'function') {
      telegram.send(`↩️ <b>Отменён оплаченный заказ ${o.id}</b>\nСумма ${(o.total_tetri / 100).toFixed(2)} ₾ (${o.provider}). Верните деньги покупателю в кабинете банка.`);
    }
    return true;
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
        if (changed) { addEvent(order.id, 'review', { bank: info.amountTetri }); telegram.mismatch(order, `${(info.amountTetri / 100).toFixed(2)} ${info.currency || ''}`); }
        return 'review';
      }
      // переход выполняется ровно один раз — повторный webhook не даст второго уведомления
      const changed = q.transition.run('paid', now, now, null, order.id, 'pending_payment').changes;
      if (changed) { addEvent(order.id, 'paid', { provider: order.provider }); telegram.paid(parseItems(q.orderById.get(order.id))); }
      return 'paid';
    }
    if (info.status === 'failed') {
      const changed = q.transition.run('failed', now, null, null, order.id, 'pending_payment').changes;
      if (changed) { addEvent(order.id, 'failed'); telegram.failed(order); }
      return 'failed';
    }
    if (info.status === 'refunded') {
      const changed = q.transition.run('refunded', now, null, null, order.id, 'paid').changes;
      if (changed) { addEvent(order.id, 'refunded'); telegram.refunded(order); }
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
    if (evt.ignored) return { ok: true, ignored: true };
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
  const findOrder = id => { const o = q.orderById.get(clean(id, 20)); if (!o) throw new HttpError(404, 'not_found'); return o; };

  function adminShape(o) {
    return {
      id: o.id, createdAt: o.created_at, updatedAt: o.updated_at, name: o.customer_name, phone: o.phone, address: o.address, lang: o.lang,
      items: JSON.parse(o.items_json), totalTetri: o.total_tetri, method: o.method, provider: o.provider || null,
      status: o.status, stage: o.stage, display: displayStatus(o), paid: o.status === 'paid', paidAt: o.paid_at || null,
      tracking: { courier: o.courier || '', code: o.tracking_code || '', url: o.tracking_url || '', note: o.delivery_note || '' },
      shippedAt: o.shipped_at || null, deliveredAt: o.delivered_at || null, note: o.note || '', history: historyOf(o.id)
    };
  }

  const safeHttpUrl = u => {
    const v = clean(u, 500);
    if (!v) return '';
    try { const x = new URL(v); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch (e) { return null; }
  };

  function gatewayInfo() {
    const url = cfg.publicBaseUrl;
    const urlMissing = cfg.publicBaseUrl && cfg.siteUrl ? [] : ['PUBLIC_BASE_URL'];
    const need = pairs => pairs.filter(([v]) => !v).map(([, n]) => n);
    const st = cfg.stripe;
    return [
      { name: 'tbc', label: 'TBC Bank', ready: payments.get('tbc').enabled, mode: null,
        missing: [...need([[cfg.tbc.apiKey, 'TBC_API_KEY'], [cfg.tbc.clientId, 'TBC_CLIENT_ID'], [cfg.tbc.clientSecret, 'TBC_CLIENT_SECRET']]), ...urlMissing],
        webhookUrl: url ? `${url}/api/v1/webhooks/tbc` : null, webhookWhere: 'Кабинет мерчанта TBC → Website Management → Callback', warnings: [] },
      { name: 'bog', label: 'Bank of Georgia', ready: payments.get('bog').enabled, mode: null,
        missing: [...need([[cfg.bog.clientId, 'BOG_CLIENT_ID'], [cfg.bog.clientSecret, 'BOG_CLIENT_SECRET']]), ...urlMissing],
        webhookUrl: url ? `${url}/api/v1/webhooks/bog` : null, webhookWhere: 'Указывать в кабинете не нужно: сервер передаёт адрес в каждом платеже',
        warnings: payments.get('bog').enabled && !cfg.bog.publicKey ? ['BOG_CALLBACK_PUBLIC_KEY не задан: подпись callback не проверяется (статус всё равно перепроверяется через API банка)'] : [] },
      { name: 'stripe', label: 'Stripe', ready: payments.get('stripe').enabled, mode: st.keyLooksValid ? (/_live_/.test(st.secretKey) ? 'live' : 'test') : null,
        missing: [...(st.keyLooksValid ? [] : [st.secretKey ? 'STRIPE_SECRET_KEY (нужен секретный ключ sk_live_… или sk_test_…, а не публичный pk_…)' : 'STRIPE_SECRET_KEY']), ...urlMissing],
        webhookUrl: url ? `${url}/api/v1/webhooks/stripe` : null, webhookWhere: 'Stripe Dashboard → Developers → Webhooks → Add endpoint; события: checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed, checkout.session.expired',
        warnings: st.keyLooksValid && !st.webhookSecret ? ['STRIPE_WEBHOOK_SECRET не задан: оплата подтвердится при возврате покупателя на сайт или в течение 5 минут'] : [] }
    ];
  }

  const admin = {
    orders: () => q.allOrders.all().map(adminShape),
    reviews: () => q.allReviews.all(),
    messages: () => q.allMessages.all(),
    setReview(id, approved) { return q.setReview.run(approved ? 1 : 0, Number(id)).changes > 0; },
    setStage(id, stage, note) {
      const o = findOrder(id);
      changeStage(o, String(stage), note, 'admin');
      return adminShape(q.orderById.get(o.id));
    },
    // Старый маршрут /status: new | delivered | cancelled
    setOrderStatus(id, status) {
      if (!['new', 'delivered', 'cancelled'].includes(status)) throw new HttpError(400, 'bad_status');
      this.setStage(id, status);
      return true;
    },
    setTracking(id, body) {
      const o = findOrder(id);
      const b = body && typeof body === 'object' ? body : {};
      const url = safeHttpUrl(b.url);
      if (url === null) throw new HttpError(400, 'bad_url', 'Tracking link must start with http:// or https://');
      const t = { courier: clean(b.courier, 100), code: clean(b.code, 100), url, note: clean(b.note, 300) };
      q.setTracking.run(t.courier, t.code, t.url, t.note, nowIso(), o.id);
      addEvent(o.id, 'tracking', t);
      return adminShape(q.orderById.get(o.id));
    },
    // Оплата наличными/курьеру получена (для онлайн-оплаты статус ставит только банк)
    markPaid(id) {
      const o = findOrder(id);
      if (o.provider || !OFFLINE_METHODS.includes(o.method)) throw new HttpError(409, 'not_offline', 'Online payments are confirmed by the bank only');
      const now = nowIso();
      if (!q.markPaidOffline.run(now, now, o.id).changes) throw new HttpError(409, 'already_paid');
      addEvent(o.id, 'paid', { provider: 'offline' });
      return adminShape(q.orderById.get(o.id));
    },
    paymentsStatus: () => ({ baseUrl: cfg.publicBaseUrl || null, siteUrl: cfg.siteUrl || null, gateways: gatewayInfo() }),
    async checkPayment(name) {
      const p = payments.get(String(name));
      if (!p) throw new HttpError(404, 'not_found');
      if (!p.enabled) throw new HttpError(409, 'not_configured', 'Gateway keys are not set');
      try { return { ok: true, ...(await p.checkCredentials()) }; } catch (e) { return { ok: false, error: String(e.message).slice(0, 300) }; }
    },
    // Сайт присылает свой каталог: цены считает сервер, поэтому они должны совпадать с витриной
    syncProducts(list) {
      if (!Array.isArray(list) || !list.length || list.length > 500) throw new HttpError(400, 'bad_products');
      const norm = list.map(p => {
        const n = p && p.name && typeof p.name === 'object' ? p.name : {};
        return { id: Number(p && p.id), price: Number(p && p.price), name: { ru: clean(n.ru, 200), ka: clean(n.ka, 200), en: clean(n.en, 200) } };
      });
      if (norm.some(p => !Number.isInteger(p.id) || p.id <= 0 || !Number.isFinite(p.price) || p.price <= 0 || p.price > 100000)) throw new HttpError(400, 'bad_products', 'Each product needs a positive id and price');
      return { count: upsertProducts(db, norm), products: listProducts() };
    }
  };

  return { listProducts, publicMethods, createOrder, publicOrderStatus, refreshOrderStatus, customerReceived, handleWebhook, reconcilePending, createReview, createChatMessage, approvedReviews: () => q.approvedReviews.all(), admin };
}

module.exports = { makeService };
