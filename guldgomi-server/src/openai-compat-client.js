'use strict';
/**
 * Запасной ИИ-провайдер с API, совместимым с OpenAI (по умолчанию Groq).
 * Интерфейс тот же, что у gemini-client: client.messages.create({ model, max_tokens, system, messages }).
 * Используется только если Google недоступен (см. failover-client.js).
 */
const GROQ_BASE = 'https://api.groq.com/openai/v1';

function makeOpenAICompatClient({ apiKey, baseUrl = GROQ_BASE, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
  async function create({ model, max_tokens, system, messages }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { const e = new Error('timeout'); e.name = 'TimeoutError'; ctrl.abort(e); }, timeoutMs);
    try {
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model, max_tokens: max_tokens || 1500, temperature: 0.3,
            messages: [{ role: 'system', content: (system || []).map(s => s.text).join('\n\n') }]
              .concat(messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })))
          }),
          signal: ctrl.signal
        });
      } catch (e) {
        const err = new Error(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? `Backup AI timeout (${timeoutMs} мс)` : `Backup AI network error: ${e && e.message}`);
        err.status = 504;
        throw err;
      }
      if (!res.ok) {
        let detail = '';
        try { detail = ((await res.json()).error || {}).message || ''; } catch (e) { /* не JSON */ }
        const err = new Error(`Backup AI HTTP ${res.status}${detail ? ': ' + String(detail).slice(0, 200) : ''}`);
        err.status = res.status;
        throw err;
      }
      const j = await res.json();
      const text = String(((j.choices || [])[0] || {}).message?.content || '').trim();
      return { content: text ? [{ type: 'text', text }] : [] };
    } finally { clearTimeout(timer); }
  }
  return { messages: { create } };
}

module.exports = { makeOpenAICompatClient };
