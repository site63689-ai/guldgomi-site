'use strict';
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const escapeHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Убирает управляющие символы, схлопывает пробелы, режет по длине
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const digits = s => String(s == null ? '' : s).replace(/\D/g, '');

const nowIso = () => new Date().toISOString();

const fmtMoney = tetri => (tetri / 100).toFixed(2);

// Сравнение секретов за постоянное время
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Банк может вернуть только ссылку на свой домен — иначе не отправляем покупателя туда
function isTrustedUrl(url, domainSuffixes) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return domainSuffixes.some(d => u.hostname === d || u.hostname.endsWith('.' + d));
  } catch (e) {
    return false;
  }
}

// Простейший ограничитель частоты запросов (в памяти)
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  if (timer.unref) timer.unref();
  return function limiter(req, res, next) {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset <= now) { h = { count: 0, reset: now + windowMs }; hits.set(key, h); }
    h.count++;
    if (h.count > max) {
      res.status(429).json({ error: 'too_many_requests' });
      return;
    }
    next();
  };
}

module.exports = { HttpError, escapeHtml, clean, digits, nowIso, fmtMoney, safeEqual, isTrustedUrl, rateLimit };
