'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeGeminiClient } = require('../src/gemini-client');
const { makeConfig } = require('../src/config');
const { makeAssistant } = require('../src/assistant');

const reply = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });

test('Gemini: формат запроса соответствует документации', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Привет!' }] } }] }) }; };
  const c = makeGeminiClient({ apiKey: 'KEY', fetchImpl });
  const out = await c.messages.create({ model: 'gemini-flash-latest', max_tokens: 900, system: [{ type: 'text', text: 'ПРАВИЛА' }, { type: 'text', text: 'БАЗА' }], messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] });
  assert.deepEqual(out, { content: [{ type: 'text', text: 'Привет!' }] });
  assert.equal(seen.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent');
  assert.equal(seen.init.headers['x-goog-api-key'], 'KEY');
  assert.ok(!seen.url.includes('KEY'), 'ключ не должен попадать в URL');
  const b = JSON.parse(seen.init.body);
  assert.deepEqual(b.system_instruction.parts.map(p => p.text), ['ПРАВИЛА', 'БАЗА']);
  assert.deepEqual(b.contents.map(m => m.role), ['user', 'model', 'user']);
  assert.equal(b.contents[2].parts[0].text, 'c');
  assert.equal(b.generationConfig.maxOutputTokens, 900);
});

test('Gemini: «мысли», блокировка и пустой ответ', async () => {
  const mk = body => makeGeminiClient({ apiKey: 'k', fetchImpl: reply(body) });
  const args = { model: 'm', messages: [{ role: 'user', content: 'x' }], system: [] };
  assert.equal((await mk({ candidates: [{ content: { parts: [{ text: 'думаю', thought: true }, { text: 'Ответ' }] } }] }).messages.create(args)).content[0].text, 'Ответ');
  assert.deepEqual((await mk({ promptFeedback: { blockReason: 'SAFETY' } }).messages.create(args)).content, []);
  assert.deepEqual((await mk({ candidates: [{ finishReason: 'MAX_TOKENS' }] }).messages.create(args)).content, []);
});

test('Gemini: HTTP-ошибки несут status; 429 превращается в «много обращений»', async () => {
  const c = makeGeminiClient({ apiKey: 'k', fetchImpl: reply({ error: { message: 'quota' } }, 429) });
  const a = makeAssistant({ client: c, model: 'm', knowledge: '# KB\n- Телефон: +995\n' });
  await assert.rejects(() => a.reply({ text: 'привет' }), e => e.status === 429 && e.code === 'assistant_busy');
  const c2 = makeGeminiClient({ apiKey: 'k', fetchImpl: reply({ error: { message: 'model not found' } }, 404) });
  await assert.rejects(() => makeAssistant({ client: c2, model: 'm', knowledge: 'KB' }).reply({ text: 'привет' }), e => e.status === 502);
});

test('выбор провайдера по переменным окружения', () => {
  const base = { PUBLIC_BASE_URL: 'https://a.b', SITE_URL: 'https://c.d' };
  assert.deepEqual(pick({ ...base }), ['', '']);
  assert.deepEqual(pick({ ...base, GEMINI_API_KEY: 'g' }), ['gemini', 'gemini-flash-latest']);
  assert.deepEqual(pick({ ...base, GEMINI: 'g' }), ['gemini', 'gemini-flash-latest'], 'имя GEMINI тоже принимается');
  assert.deepEqual(pick({ ...base, ANTHROPIC_API_KEY: 'a' }), ['anthropic', 'claude-haiku-5-5']);
  assert.deepEqual(pick({ ...base, GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' })[0], 'gemini', 'по умолчанию бесплатный Gemini');
  assert.deepEqual(pick({ ...base, GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', AI_PROVIDER: 'anthropic' })[0], 'anthropic');
  assert.deepEqual(pick({ ...base, GEMINI_API_KEY: 'g', GEMINI_MODEL: 'gemini-x' }), ['gemini', 'gemini-x']);
  function pick(env) { const a = makeConfig(env).assistant; return [a.provider, a.provider ? a.model : '']; }
});

test('Gemini: при 503 основной модели пробуется запасная', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    if (urls.length === 1) return { ok: false, status: 503, json: async () => ({ error: { message: 'high demand' } }) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ок' }] } }] }) };
  };
  const c = makeGeminiClient({ apiKey: 'k', fetchImpl, fallbackModels: ['gemini-flash-lite-latest'] });
  const out = await c.messages.create({ model: 'gemini-flash-latest', messages: [{ role: 'user', content: 'x' }], system: [] });
  assert.equal(out.content[0].text, 'ок');
  assert.ok(urls[0].includes('gemini-flash-latest:') && urls[1].includes('gemini-flash-lite-latest:'));
});

test('Gemini: без запасных моделей — одна повторная попытка; ошибка ключа не повторяется', async () => {
  let n = 0;
  const flaky = async () => (++n === 1 ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ок' }] } }] }) });
  const c = makeGeminiClient({ apiKey: 'k', fetchImpl: flaky });
  assert.equal((await c.messages.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], system: [] })).content[0].text, 'ок');
  assert.equal(n, 2);
  let m = 0;
  const bad = async () => { m++; return { ok: false, status: 403, json: async () => ({ error: { message: 'bad key' } }) }; };
  await assert.rejects(() => makeGeminiClient({ apiKey: 'k', fetchImpl: bad, fallbackModels: ['x'] }).messages.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], system: [] }), e => e.status === 403);
  assert.equal(m, 1);
});

test('Gemini: запасные модели берутся из GEMINI_FALLBACK_MODELS (по умолчанию flash-lite)', () => {
  assert.deepEqual(makeConfig({ GEMINI_API_KEY: 'k' }).assistant.fallbackModels, ['gemini-flash-lite-latest']);
  assert.deepEqual(makeConfig({ GEMINI_API_KEY: 'k', GEMINI_FALLBACK_MODELS: '' }).assistant.fallbackModels, []);
  assert.deepEqual(makeConfig({ GEMINI_API_KEY: 'k', GEMINI_FALLBACK_MODELS: 'a, b' }).assistant.fallbackModels, ['a', 'b']);
});

test('Gemini: таймаут основной модели -> запасная; если обе недоступны — «много обращений»', async () => {
  const calls = [];
  const timeoutErr = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; return e; };
  const fetchImpl = async url => {
    calls.push(url);
    if (calls.length === 1) throw timeoutErr();
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ответ' }] } }] }) };
  };
  const c = makeGeminiClient({ apiKey: 'k', fetchImpl, fallbackModels: ['gemini-flash-lite-latest'] });
  assert.equal((await c.messages.create({ model: 'gemini-flash-latest', messages: [{ role: 'user', content: 'x' }], system: [] })).content[0].text, 'ответ');
  assert.ok(calls[1].includes('gemini-flash-lite-latest'));

  const always503 = async () => ({ ok: false, status: 503, json: async () => ({ error: { message: 'high demand' } }) });
  const c2 = makeGeminiClient({ apiKey: 'k', fetchImpl: always503, fallbackModels: ['gemini-flash-lite-latest'] });
  await assert.rejects(() => makeAssistant({ client: c2, model: 'm', knowledge: '# KB\n- Телефон: +995\n' }).reply({ text: 'привет' }), e => e.status === 429 && e.code === 'assistant_busy');
});

test('Gemini: таймаут одной попытки 10 с по умолчанию, реальный таймаут срабатывает', async () => {
  const c = makeGeminiClient({ apiKey: 'k', timeoutMs: 50, fetchImpl: (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))) });
  const t0 = Date.now();
  await assert.rejects(() => c.messages.create({ model: 'm', messages: [{ role: 'user', content: 'x' }], system: [] }), e => e.status === 504);
  assert.ok(Date.now() - t0 < 2000);
});
