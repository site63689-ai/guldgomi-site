'use strict';
const fs = require('node:fs');
const path = require('node:path');

// price в лари (может быть 12.5) -> тетри (целое число), чтобы не копить ошибки округления
const toTetri = p => Math.round(Number(p) * 100);

function upsertProducts(db, list) {
  const stmt = db.prepare(`INSERT INTO products (id, price_tetri, name_ru, name_ka, name_en, active) VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET price_tetri = excluded.price_tetri, name_ru = excluded.name_ru, name_ka = excluded.name_ka, name_en = excluded.name_en, active = 1`);
  const ids = [];
  db.exec('BEGIN');
  try {
    for (const p of list) {
      const id = Number(p.id);
      const price = toTetri(p.price);
      if (!Number.isInteger(id) || !Number.isFinite(price) || price <= 0) throw new Error('Некорректный товар: ' + JSON.stringify(p));
      const n = p.name && typeof p.name === 'object' ? p.name : { ru: String(p.name || ''), ka: String(p.name || ''), en: String(p.name || '') };
      stmt.run(id, price, n.ru || '', n.ka || '', n.en || '');
      ids.push(id);
    }
    // товары, которых нет в новом списке, отключаем (старые заказы остаются целыми)
    if (ids.length) db.prepare(`UPDATE products SET active = 0 WHERE id NOT IN (${ids.map(() => '?').join(',')})`).run(...ids);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ids.length;
}

function seedProductsIfEmpty(db) {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM products').get();
  if (c > 0) return 0;
  const file = path.join(__dirname, '..', 'seed', 'products.json');
  if (!fs.existsSync(file)) return 0;
  return upsertProducts(db, JSON.parse(fs.readFileSync(file, 'utf8')));
}

module.exports = { upsertProducts, seedProductsIfEmpty, toTetri };
