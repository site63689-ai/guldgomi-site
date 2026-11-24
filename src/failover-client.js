'use strict';
/** Сначала основной провайдер (Google); если он перегружен или недоступен — запасной с его собственной моделью. */
const RETRYABLE = s => s === undefined || s === 404 || s === 408 || s === 429 || s >= 500;

function makeFailoverClient(primary, backup, backupModel) {
  async function create(req) {
    try { return await primary.messages.create(req); }
    catch (e) {
      if (!e || !RETRYABLE(e.status)) throw e;
      console.warn(`[ai] основной провайдер недоступен (${e.message}) — переходим на запасной (${backupModel})`);
      try { return await backup.messages.create({ ...req, model: backupModel }); }
      catch (e2) { console.warn(`[ai] запасной провайдер тоже не ответил: ${e2 && e2.message}`); throw e; } // клиенту важна исходная причина
    }
  }
  return { messages: { create } };
}
module.exports = { makeFailoverClient };
