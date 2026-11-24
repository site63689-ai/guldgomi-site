'use strict';
const { HttpError } = require('../util');

function makePayments(cfg, providers) {
  const enabled = () => Object.values(providers).filter(p => p.enabled);

  /**
   * Выбор банка: тот, что просил сайт (если включён) -> DEFAULT_PAYMENT_GATEWAY -> первый включённый.
   * Банк без ключей в настройках просто недоступен.
   */
  function pick(requested) {
    const list = enabled();
    if (!list.length) throw new HttpError(503, 'payments_unavailable', 'No payment provider is configured');
    const r = String(requested || '').toLowerCase();
    return list.find(p => p.name === r) || list.find(p => p.name === cfg.defaultGateway) || list[0];
  }

  return { pick, enabledNames: () => enabled().map(p => p.name), get: name => providers[name] };
}

module.exports = { makePayments };
