'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS products (
      id          INTEGER PRIMARY KEY,
      price_tetri INTEGER NOT NULL,
      name_ru     TEXT NOT NULL DEFAULT '',
      name_ka     TEXT NOT NULL DEFAULT '',
      name_en     TEXT NOT NULL DEFAULT '',
      active      INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS orders (
      id                  TEXT PRIMARY KEY,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      customer_name       TEXT NOT NULL,
      phone               TEXT NOT NULL,
      address             TEXT NOT NULL,
      lang                TEXT NOT NULL DEFAULT 'ru',
      items_json          TEXT NOT NULL,
      total_tetri         INTEGER NOT NULL,
      currency            TEXT NOT NULL DEFAULT 'GEL',
      method              TEXT NOT NULL,
      status              TEXT NOT NULL,
      provider            TEXT,
      provider_payment_id TEXT,
      paid_at             TEXT,
      note                TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_provider ON orders(provider, provider_payment_id);

    CREATE TABLE IF NOT EXISTS reviews (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      author     TEXT NOT NULL,
      rating     INTEGER NOT NULL,
      text       TEXT NOT NULL,
      order_id   TEXT,
      approved   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      text       TEXT NOT NULL,
      lang       TEXT,
      category   TEXT,
      priority   TEXT
    );

    CREATE TABLE IF NOT EXISTS payment_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      provider   TEXT NOT NULL,
      payload    TEXT
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id   TEXT NOT NULL,
      created_at TEXT NOT NULL,
      kind       TEXT NOT NULL,
      detail     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);
  `);

  // Миграция существующей базы: этап выполнения заказа и данные доставки
  const cols = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
  const add = (name, ddl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${ddl}`); };
  add('stage', "TEXT NOT NULL DEFAULT 'new'");   // new | confirmed | packing | shipped | delivered | cancelled
  add('courier', 'TEXT');
  add('tracking_code', 'TEXT');
  add('tracking_url', 'TEXT');
  add('delivery_note', 'TEXT');                  // заметка, которую видит покупатель
  add('shipped_at', 'TEXT');
  add('delivered_at', 'TEXT');
  // Старая версия хранила «доставлен/отменён» прямо в status — переносим в stage
  db.exec(`UPDATE orders SET stage = 'delivered', status = CASE WHEN provider IS NULL THEN 'new' ELSE 'paid' END WHERE status = 'delivered'`);
  db.exec(`UPDATE orders SET stage = 'cancelled', status = CASE WHEN provider IS NULL THEN 'new' ELSE 'paid' END WHERE status = 'cancelled'`);
  return db;
}

module.exports = { openDb };
