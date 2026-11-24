'use strict';

// Те же правила, что в index.html (RU / KA / EN)
const KW = {
  problem: ['брак', 'проблем', 'ошибк', 'претензи', 'жалоб', 'не пришл', 'не приш', 'испорчен', 'возврат', 'верните', 'обман', 'мошен', 'деньги', 'списал', 'плохо', 'разбит', 'просроч', 'problem', 'issue', 'broken', 'damaged', 'refund', 'complain', 'scam', 'not arrived', 'defect', 'wrong', 'პრობლემ', 'დეფექტ', 'გატეხ', 'თანხა', 'დაბრუნ', 'ჩივილ', 'გაფუჭ'],
  delivery: ['доставк', 'курьер', 'идёт', 'идет', 'привез', 'срок', 'deliver', 'courier', 'shipping', 'shipment', 'arrive', 'how long', 'მიწოდ', 'კურიერ', 'ჩამოვა'],
  payment: ['оплат', 'карт', 'заплат', 'цена', 'стоит', 'стоимост', 'перевод', 'iban', 'чек', 'pay', 'card', 'price', 'cost', 'invoice', 'გადახდ', 'ბარათ', 'ფას', 'ღირ']
};

function analyzeMessage(text) {
  const l = String(text).toLowerCase();
  const has = arr => arr.some(k => l.includes(k));
  if (has(KW.problem)) return { category: 'problem', priority: 'high' };
  if (has(KW.delivery)) return { category: 'delivery', priority: 'normal' };
  if (has(KW.payment)) return { category: 'payment', priority: 'normal' };
  return { category: 'general', priority: 'normal' };
}

module.exports = { analyzeMessage };
