'use strict';
/**
 * Ответы «по справке магазина» без обращения к ИИ.
 * Используются, только когда сервис ИИ (Google) перегружен или не ответил: покупатель всё равно получает
 * ответ на самые частые вопросы (доставка, оплата, товары и цены). Текст берётся из той же публичной базы знаний.
 */
const LANGS = ['ru', 'ka', 'en'];
const UP = { ru: 'RU', ka: 'KA', en: 'EN' };

const INTENTS = [
  ['delivery', /достав|курьер|самовывоз|shipping|deliver|courier|მიწოდ|კურიერ|გადმოგზავნ/i],
  ['payment', /оплат|карт[аойуе]|налич|платёж|платеж|payment|\bpay\b|card|cash|გადახდ|ბარათ|ნაღდი/i],
  ['products', /мёд|мед\b|мёда|меда|товар|цен[ауыё]|стоит|каталог|ассортимент|honey|price|cost|product|catalog|what do you (have|sell)|თაფლ|ფას|პროდუქტ|რა ღირს/i]
];

const T = {
  intro: {
    ru: 'Сейчас ИИ-помощник перегружен, поэтому отвечаю по справке магазина.',
    ka: 'ახლა AI ასისტენტი გადატვირთულია, ამიტომ გპასუხობთ მაღაზიის ცნობარის მიხედვით.',
    en: 'The AI assistant is overloaded right now, so here is the answer from the shop reference.'
  },
  outro: {
    ru: 'Если нужно подробнее, нажмите «Позвать оператора».',
    ka: 'დეტალებისთვის დააჭირეთ „ოპერატორის გამოძახებას“.',
    en: 'For more details, press “Call operator”.'
  },
  payment: {
    ru: 'Оплатить заказ можно курьеру при получении, на месте, а также картой онлайн (TBC Bank, Банк Грузии, Stripe), если способ подключён. В корзине показываются только доступные способы. Данные карты вводятся на защищённой странице банка.',
    ka: 'შეკვეთის გადახდა შეიძლება კურიერთან მიღებისას, ადგილზე, ასევე ბარათით ონლაინ (TBC Bank, საქართველოს ბანკი, Stripe), თუ მეთოდი ჩართულია. კალათაში ჩანს მხოლოდ ხელმისაწვდომი მეთოდები. ბარათის მონაცემები იწერება ბანკის დაცულ გვერდზე.',
    en: 'You can pay the courier on delivery, pay on site, or pay online by card (TBC Bank, Bank of Georgia, Stripe) when that method is enabled. The cart shows only the available methods. Card details are entered on the bank’s secure page.'
  },
  products: { ru: 'Наши товары:', ka: 'ჩვენი პროდუქტები:', en: 'Our products:' }
};

function section(kb, title) {
  const i = kb.search(new RegExp('^## ' + title, 'm'));
  if (i < 0) return '';
  const rest = kb.slice(i + 3);
  const j = rest.search(/^## /m);
  return j < 0 ? rest : rest.slice(0, j);
}

// Строка вида "- RU: текст" под заголовком "Стоимость:" и т. п.
function langLine(block, heading, lang) {
  const i = block.indexOf(heading + ':');
  if (i < 0) return '';
  const after = block.slice(i + heading.length + 1);
  const end = after.search(/^[^\s-].*:\s*$/m);
  const part = end < 0 ? after : after.slice(0, end);
  const m = part.match(new RegExp('^- ' + UP[lang] + ':\\s*(.+)$', 'm'));
  return m ? m[1].trim() : '';
}

function makeOfflineAnswers(kb, contacts = '') {
  const delivery = section(kb, 'Доставка');
  const products = [];
  const re = /^### (.+?) — ([\d.,]+) ₾\s*$([\s\S]*?)(?=^### |^## |(?![\s\S]))/gm;
  let m;
  while ((m = re.exec(kb))) {
    const names = {};
    for (const l of LANGS) { const n = m[3].match(new RegExp('^Название ' + UP[l] + ':\\s*(.+)$', 'm')); names[l] = n ? n[1].trim() : m[1]; }
    products.push({ names, price: m[2] });
  }

  function body(intent, lang) {
    if (intent === 'delivery') {
      const parts = [langLine(delivery, 'Стоимость', lang), langLine(delivery, 'Зоны и сроки', lang) || langLine(delivery, 'Краткая информация', lang)].filter(Boolean);
      return parts.join('\n');
    }
    if (intent === 'payment') return T.payment[lang];
    if (intent === 'products') return products.length ? T.products[lang] + '\n' + products.map(p => `• ${p.names[lang]} — ${p.price} ₾`).join('\n') : '';
    return '';
  }

  /** Возвращает ответ или null, если вопрос не про доставку, оплату или товары */
  function answer(text, lang = 'ru') {
    if (!LANGS.includes(lang)) lang = 'ru';
    const hit = INTENTS.find(([, rx]) => rx.test(text));
    if (!hit) return null;
    const b = body(hit[0], lang);
    if (!b) return null;
    return [T.intro[lang], b, contacts, T.outro[lang]].filter(Boolean).join('\n\n');
  }
  return { answer };
}

module.exports = { makeOfflineAnswers };
