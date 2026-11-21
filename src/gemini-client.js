'use strict';
/**
 * Адаптер Google Gemini (REST, без SDK) с тем же интерфейсом, что использует assistant.js:
 *   client.messages.create({ model, max_tokens, system: [{type:'text', text}], messages: [{role, content}] })
 *   -> { content: [{ type: 'text', text }] }
 *
 * Документация: https://ai.google.dev/gemini-api/docs/generate-content/text-generation
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *   заголовок x-goog-api-key, тело: system_instruction, contents[{role: user|model, parts:[{text}]}], generationConfig
 */
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Ошибки, при которых имеет смысл попробовать другую модель (или ту же ещё раз): перегрузка Google, сбой, таймаут, лимит.
// Ошибки ключа и запроса (400/401/403) повторять бесполезно.
const RETRYABLE = status => status === undefined || status === 404 || status === 408 || status === 429 || status >= 500;

function makeGeminiClient({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 12000, baseUrl = BASE, fallbackModels = [] }) {
  async function create({ model, max_tokens, system, messages }) {
    // Основная модель, затем запасные. Если запасных нет — одна повторная попытка той же модели.
    const chain = [model, ...fallbackModels.filter(m => m && m !== model)];
    if (chain.length === 1) chain.push(model);
    let lastErr;
    for (const m of chain.slice(0, 2)) {
      try { return await callOnce({ model: m, max_tokens, system, messages }); }
      catch (e) {
        lastErr = e;
        if (!RETRYABLE(e.status)) throw e;
        console.warn(`[gemini] ${m}: ${e.message} — пробуем следующую попытку`);
      }
    }
    throw lastErr;
  }

  async function callOnce({ model, max_tokens, system, messages }) {
    const body = {
      system_instruction: { parts: (system || []).map(s => ({ text: s.text })) },
      contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: max_tokens || 1500 }
    };
    const res = await fetchImpl(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      let detail = '';
      try { detail = ((await res.json()).error || {}).message || ''; } catch (e) { /* не JSON */ }
      const err = new Error(`Gemini HTTP ${res.status}${detail ? ': ' + detail.slice(0, 200) : ''}`);
      err.status = res.status;
      throw err;
    }
    const j = await res.json();
    // Запрос заблокирован фильтрами Google — возвращаем пустой ответ, ассистент покажет запасной текст
    if (j.promptFeedback && j.promptFeedback.blockReason) return { content: [] };
    const cand = Array.isArray(j.candidates) ? j.candidates[0] : null;
    const parts = (cand && cand.content && Array.isArray(cand.content.parts)) ? cand.content.parts : [];
    // «мысли» модели (thought: true), если они вернулись, пользователю не показываем
    const text = parts.filter(p => p && typeof p.text === 'string' && !p.thought).map(p => p.text).join('').trim();
    return { content: text ? [{ type: 'text', text }] : [] };
  }
  return { messages: { create } };
}

module.exports = { makeGeminiClient };
