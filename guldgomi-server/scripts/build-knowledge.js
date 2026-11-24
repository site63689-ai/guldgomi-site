'use strict';
/**
 * Собирает knowledge/knowledge_base.md ТОЛЬКО из публичных данных сайта.
 *
 * Используется белый список полей: всё, чего нет в списке ниже, в базу знаний попасть не может
 * (администраторы и PIN-коды, журнал безопасности, чаты, заказы, отзывы, токены, IBAN, шлюзы, ключи).
 *
 * Использование:  npm run build-knowledge -- путь/к/index.html
 */
const fs = require('node:fs');
const path = require('node:path');

const LANGS = [['ru', 'RU'], ['ka', 'KA'], ['en', 'EN']];

function loadState(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/<script id="embeddedStateScript">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('В файле не найден блок embeddedStateScript');
  return new Function(m[1] + ';return EMBEDDED_DEFAULT_STATE;')();
}

const oneLine = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const loc = (v, l) => (v && typeof v === 'object' ? oneLine(v[l]) : l === 'ru' ? oneLine(v) : '');
const langLines = (v, indent = '') => LANGS.map(([l, L]) => (loc(v, l) ? `${indent}- ${L}: ${loc(v, l)}` : '')).filter(Boolean).join('\n');

/** Собирает markdown из состояния сайта (экспортируется для тестов). */
function buildKnowledge(state, staticMd) {
  const s = (state && state.settings) || {};
  const out = [];
  out.push('# База знаний магазина (только публичная информация с сайта)\n');

  out.push('## Магазин');
  out.push('Название: ' + (loc(s.siteName, 'ru') || loc(s.siteName, 'en') || 'Guldgomi Honey'));
  if (state.story) {
    out.push('Слоган:\n' + langLines(state.story.title));
    out.push('Описание:\n' + langLines(state.story.subtitle));
  }

  out.push('\n## Контакты поддержки');
  if (oneLine(s.phone)) out.push(`- Телефон: ${oneLine(s.phone)}`);
  if (oneLine(s.email)) out.push(`- Email: ${oneLine(s.email)}`);

  if (s.showDelivery !== false) {
    out.push('\n## Доставка (тексты со страницы «Доставка»)');
    out.push('Краткая информация:\n' + langLines(s.bannerDesc));
    out.push('Зоны и сроки:\n' + langLines(s.delZone));
    out.push('Стоимость:\n' + langLines(s.delPrice));
  }

  out.push('\n## Способы оплаты, включённые в магазине');
  const pay = [];
  if (s.showPayCourier !== false) pay.push('Курьеру (оплата при встрече)');
  if (s.showPayCash !== false) pay.push('На месте');
  if (s.showPayCard !== false) pay.push('Онлайн-оплата картой через банк (если подключена; в корзине показываются только доступные способы)');
  pay.forEach(p => out.push('- ' + p));

  out.push('\n## Каталог товаров (название — цена в ₾)');
  (state.products || []).forEach(p => {
    const price = Number(p.price);
    if (!Number.isFinite(price)) return;
    out.push(`\n### ${loc(p.name, 'ru') || loc(p.name, 'en')} — ${price} ₾`);
    out.push(langLines(p.name, 'Название ') .replace(/^Название - /gm, 'Название '));
    out.push('Описание:\n' + langLines(p.desc));
  });

  out.push('\n' + staticMd.trim() + '\n');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('Укажите файл: npm run build-knowledge -- index.html'); process.exit(1); }
  const staticMd = fs.readFileSync(path.join(__dirname, '..', 'knowledge', 'static_public.md'), 'utf8');
  const md = buildKnowledge(loadState(file), staticMd);
  const outFile = path.join(__dirname, '..', 'knowledge', 'knowledge_base.md');
  fs.writeFileSync(outFile, md);
  console.log('Готово:', outFile, `(${md.length} символов)`);
}

module.exports = { buildKnowledge, loadState };
