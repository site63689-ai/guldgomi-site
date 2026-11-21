'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeConfig } = require('../src/config');

test('Конфиг без единой переменной: порт 8000, ассистент выключен, ничего не падает', () => {
  const c = makeConfig({});
  assert.equal(c.port, 8000);
  assert.equal(c.assistant.apiKey, '');
  assert.equal(c.bog.enabled, false);
});
test('Достаточно GEMINI_API_KEY: включается Gemini с запасной моделью', () => {
  const c = makeConfig({ GEMINI_API_KEY: 'k' });
  assert.equal(c.assistant.provider, 'gemini');
  assert.deepEqual(c.assistant.fallbackModels, ['gemini-flash-lite-latest']);
});
test('PORT от Railway используется', () => assert.equal(makeConfig({ PORT: '5123' }).port, 5123));
test('Адрес сервера берётся из RAILWAY_PUBLIC_DOMAIN, SITE_URL и CORS — из него же', () => {
  const c = makeConfig({ RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' });
  assert.equal(c.publicBaseUrl, 'https://x.up.railway.app');
  assert.equal(c.siteUrl, 'https://x.up.railway.app');
  assert.deepEqual(c.allowedOrigins, ['https://x.up.railway.app']);
});
test('Явный PUBLIC_BASE_URL важнее RAILWAY_PUBLIC_DOMAIN', () => {
  assert.equal(makeConfig({ PUBLIC_BASE_URL: 'https://my.site/', RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }).publicBaseUrl, 'https://my.site');
});
