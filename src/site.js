'use strict';
// Подставляет адрес сервера в страницу сайта. Если PUBLIC_BASE_URL не задан, сайт и сервер на одном адресе —
// берём адрес, с которого открыта страница (window.location.origin), поэтому ассистент работает и без переменной.
const MARK = "const ASSISTANT_API_URL = '';";
function injectApiUrl(html, publicBaseUrl) {
  const value = publicBaseUrl ? JSON.stringify(publicBaseUrl) : 'window.location.origin';
  return html.replace(MARK, 'const ASSISTANT_API_URL = ' + value + ';');
}
module.exports = { injectApiUrl, MARK };
