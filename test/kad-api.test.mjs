/*
 * Записи API картотеки в том виде, в каком их отдаёт настоящий kad.arbitr
 * (проба на раннере GitHub, tools/kad-probe.mjs): заявления, начавшего спор,
 * в хронологии нет, документы спора ссылаются на него полем ReasonDocumentId
 * и текстом в AdditionalInfo, итоговое определение подписано категорией спора.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { itemsToText } from '../server/kad-fetch.mjs';
import { C, X, R, fixture } from './load.mjs';

const { caseId, root, items } = JSON.parse(fixture('kad-api-items.json'));
const text = itemsToText(items, caseId);
const card = C.parse(text);
const d = X.build(card, { filedDate: '2026-06-23' });

test('записи API → текст: связь, заседание, срок обжалования, PDF', () => {
  assert.equal(card.records.length, 10);
  const acc = card.records.find((r) => r.date === '2026-06-29');
  assert.equal(acc.responseTo, 'Заявление (23.06.2026) от ПАО "СБЕРБАНК РОССИИ"');
  assert.equal(acc.responseToId, root);
  assert.deepEqual([acc.hearing.date, acc.hearing.time], ['2026-07-21', '11:30']);
  assert.match(acc.pdf, /^https:\/\/kad\.arbitr\.ru\/Kad\/PdfDocument\//);
  assert.ok(!acc.extra.some((l) => /штрихкод/i.test(l)), 'штрихкод — служебный, в подробности не идёт');
  const merits = card.records.find((r) => r.date === '2026-09-17');
  assert.equal(merits.appealUntil, '2026-10-19');
});

test('корень — по ссылкам: заявления в хронологии нет, чужое заявление банка не берётся', () => {
  assert.equal(d.rootFound, false);
  assert.equal(d.root.docId, root);
  assert.match(d.root.from, /СБЕРБАНК/);
  assert.equal(d.role, 'participant');
  assert.deepEqual(d.events.map((e) => e.rec.date),
    ['2026-06-23', '2026-06-29', '2026-07-21', '2026-08-05', '2026-09-15', '2026-09-17']);
  assert.ok(d.events.slice(1).every((e) => e.reasons.includes('ссылка на документ картотеки')));
  // Перерыв 23.06 и заявление 09.07 отвечают чужому спору того же банка.
  assert.ok(!d.events.some((e) => e.rec.date === '2026-07-09'));
});

test('определение «…и (или) применении последствий…» — по существу, исход по тексту', () => {
  assert.equal(d.stage, 'decided');
  assert.equal(R.STAGES[d.stage].label, 'Вынесено определение по существу');
  const t = d.tasks.find((x) => /по существу спора/.test(x.what));
  assert.equal(t.due.date, '2026-10-19', 'текста нет — срок обжалования из картотеки');
  assert.match(t.due.text, /по данным картотеки/);

  const merits = card.records.find((r) => r.date === '2026-09-17');
  const denied = X.build(card, { filedDate: '2026-06-23', texts: { [merits.id]: 'О П Р Е Д Е Л И Л:\nВ удовлетворении заявления ПАО Сбербанк о признании сделки недействительной отказать.' } });
  assert.equal(denied.stage, 'denied');
  const granted = X.build(card, { filedDate: '2026-06-23', texts: { [merits.id]: 'О П Р Е Д Е Л И Л:\nЗаявление удовлетворить. Признать недействительной сделку — договор дарения от 01.02.2024. Применить последствия недействительности сделки.' } });
  assert.equal(granted.stage, 'granted');
});

test('текст страницы без идентификаторов: чужой иск банка месяцем раньше корнем не становится', () => {
  const noIds = C.parse(text.split('\n').filter((l) => !/^(?:Документ|Ответ на документ):/.test(l)).join('\n'));
  const d2 = X.build(noIds, { filedDate: '2026-06-23' });
  assert.equal(d2.rootFound, false);
  assert.match(d2.root.from, /СБЕРБАНК/);
  assert.deepEqual(d2.events.map((e) => e.rec.date),
    ['2026-06-23', '2026-06-29', '2026-07-21', '2026-08-05', '2026-09-15', '2026-09-17']);
});

test('срок обжалования: текст определения важнее картотеки, картотека — важнее десяти дней', () => {
  const merits = card.records.find((r) => r.date === '2026-09-17');
  const text = 'О П Р Е Д Е Л И Л:\n1. Заявление удовлетворить.\n2. Признать недействительным договор.\n3. Определение может быть обжаловано в течение месяца со дня его принятия.';
  const d2 = X.build(card, { filedDate: '2026-06-23', texts: { [merits.id]: text } });
  const t = d2.tasks.find((x) => /вступление определения в силу/.test(x.what));
  assert.equal(t.due.date, '2026-10-19', '17.09.2026 + месяц = 17.10 (суббота) → 19.10');
  assert.match(t.due.text, /из текста определения/);
  // Без текста — срок картотеки (AppealDate).
  const t2 = d.tasks.find((x) => /по существу спора/.test(x.what));
  assert.equal(t2.due.date, '2026-10-19');
});
