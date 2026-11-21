'use strict';
const { escapeHtml: h, fmtMoney } = require('./util');

const METHOD_LABEL = { bog: 'Bank of Georgia (онлайн)', tbc: 'TBC Bank (онлайн)', courier: 'Курьеру', cash: 'На месте' };
const CAT_LABEL = { delivery: 'Доставка', payment: 'Оплата', problem: 'Проблема/Претензия', general: 'Общий вопрос' };

function itemsText(order) {
  return order.items.map(i => `• ${h(i.name.ru || i.name.en || i.name.ka || i.id)} × ${i.qty} — ${fmtMoney(i.priceTetri * i.qty)} ₾`).join('\n');
}
function orderBlock(order) {
  return `👤 ${h(order.customer_name)}\n📞 ${h(order.phone)}\n📍 ${h(order.address)}\n📦\n${itemsText(order)}\n💰 Итого: <b>${fmtMoney(order.total_tetri)} ₾</b>\n💳 ${h(METHOD_LABEL[order.method] || order.method)}`;
}

function makeTelegram(cfg) {
  const { token, chatId } = cfg.telegram;
  const enabled = !!(token && chatId);

  async function send(text) {
    if (!enabled) return false;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) console.error('[telegram] HTTP', res.status);
      return res.ok;
    } catch (e) {
      console.error('[telegram] error:', e.message);
      return false;
    }
  }

  return {
    enabled,
    send,
    newOrder: o => send(`🛒 <b>Новый заказ ${h(o.id)}</b>\n${orderBlock(o)}`),
    paid: o => send(`✅ <b>Оплачено: заказ ${h(o.id)}</b>\n${orderBlock(o)}`),
    failed: o => send(`❌ <b>Платёж не прошёл: заказ ${h(o.id)}</b>\n💰 ${fmtMoney(o.total_tetri)} ₾ · ${h(METHOD_LABEL[o.method] || o.method)}\n👤 ${h(o.customer_name)} · ${h(o.phone)}`),
    refunded: o => send(`↩️ <b>Возврат по заказу ${h(o.id)}</b>\n💰 ${fmtMoney(o.total_tetri)} ₾ · ${h(METHOD_LABEL[o.method] || o.method)}`),
    mismatch: (o, got) => send(`⚠️ <b>Несовпадение суммы по заказу ${h(o.id)}</b>\nОжидали ${fmtMoney(o.total_tetri)} ₾, банк сообщил ${h(got)}. Заказ НЕ помечен оплаченным — проверьте вручную.`),
    review: r => send(`⭐ <b>Новый отзыв (на модерации)</b>\n${h(r.author)} — ${r.rating}/5\n${h(r.text)}${r.order_id ? `\nЗаказ: ${h(r.order_id)}` : ''}`),
    chat: m => send(`${m.priority === 'high' ? '🔴 <b>СРОЧНО</b>' : '💬'} Сообщение в чате (${h((m.lang || '').toUpperCase())})\nКатегория: ${h(CAT_LABEL[m.category] || m.category)}\n${h(m.text)}`)
  };
}

module.exports = { makeTelegram };
