'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { injectApiUrl, MARK } = require('../src/site');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('в сайте есть метка для подстановки адреса', () => assert.ok(html.includes(MARK)));
test('с PUBLIC_BASE_URL подставляется он', () => {
  const out = injectApiUrl(html, 'https://x.up.railway.app');
  assert.ok(out.includes('const ASSISTANT_API_URL = "https://x.up.railway.app";'));
});
test('без PUBLIC_BASE_URL берётся адрес страницы', () => {
  const out = injectApiUrl(html, '');
  assert.ok(out.includes('const ASSISTANT_API_URL = window.location.origin;'));
  assert.ok(!out.includes(MARK));
});
