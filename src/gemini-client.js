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

function makeGeminiClient({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 25000, baseUrl = BASE }) {
  async function create({ model, max_tokens, system, messages }) {
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
