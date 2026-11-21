'use strict';
/**
 * Загружает каталог (id, цены, названия) в базу сервера из скачанного index.html
 * (скачайте его кнопкой «Скачать готовый сайт» в админке) или из JSON-файла.
 *
 * Использование:  npm run sync-products -- путь/к/index.html
 */
const fs = require('node:fs');
const { makeConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { upsertProducts } = require('../src/seed');

const file = process.argv[2];
if (!file) { console.error('Укажите файл: npm run sync-products -- index.html'); process.exit(1); }
const raw = fs.readFileSync(file, 'utf8');
let list;
if (file.endsWith('.json')) list = JSON.parse(raw);
else {
  const m = raw.match(/<script id="embeddedStateScript">([\s\S]*?)<\/script>/);
  if (!m) { console.error('В файле не найден блок embeddedStateScript'); process.exit(1); }
  list = new Function(m[1] + ';return EMBEDDED_DEFAULT_STATE;')().products;
}
const db = openDb(makeConfig().dbPath);
console.log('Товаров обновлено:', upsertProducts(db, list));
db.close();
