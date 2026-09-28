/*
 * Какой текст карточки разбирать: записи из API картотеки или текст
 * страницы. Берётся тот, где больше записей; к тексту API приписывается
 * шапка дела со страницы — номер, суд, должник в записях API не повторяются.
 * Общий для сервера (server.mjs) и облачной проверки (tools/cloud-check.mjs).
 */
import '../src/dates.js';
import '../src/kad.js';

export function chooseText(r, url) {
  const { KadCard } = globalThis;
  const page = r.pageText ? KadCard.parse(r.pageText) : null;
  const api = r.apiText ? KadCard.parse(r.apiText) : null;
  const pn = page ? page.records.length : 0;
  const an = api ? api.records.length : 0;
  if (an && an >= pn) {
    const m = (page && page.meta) || {};
    const head = [m.caseNo, m.court, m.debtor && `Должник: ${m.debtor}`, m.judge && `Судья: ${m.judge}`, url].filter(Boolean);
    return { text: `${head.join('\n')}\n${r.apiText}`, note: `Карточка загружена: ${an} документов из хронологии картотеки` };
  }
  if (pn) return { text: r.pageText, note: `Карточка загружена: ${pn} документов по тексту страницы` };
  const e = new Error('в загруженной карточке не найдено ни одного документа — возможно, картотека изменила вёрстку. Вставьте страницу вручную (Ctrl+A, Ctrl+C)');
  e.status = 502;
  throw e;
}
