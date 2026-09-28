import test from 'node:test';
import assert from 'node:assert/strict';
import { C, X, fixture } from './load.mjs';

/*
 * Фикстура — карточка банкротного дела, где рядом с нашим спором (заявление
 * ПАО «Сбербанк России» от 23.06.2026) идут чужие: оспаривание, поданное
 * управляющим 20.06.2026, заявление банка о включении в реестр от 22.06.2026,
 * отчёт и ходатайства по процедуре — со своими определениями «в ответ на».
 */
const card = C.parse(fixture('card-sber.txt'));
const build = (spec) => X.build(card, { filedDate: '2026-06-23', ...spec });

test('разбор карточки: записи, «В ответ на», дата заседания, PDF, публикация', () => {
  assert.equal(card.meta.caseNo, 'А40-123456/2025');
  assert.equal(card.records.length, 17);
  const nm = card.records.find((r) => r.date === '2026-06-26');
  assert.equal(nm.content, 'Об оставлении заявления без движения');
  assert.equal(nm.responseTo, 'Заявление от (23.06.2026) от ПАО "СБЕРБАНК РОССИИ"');
  assert.match(nm.pdf, /^https:\/\/kad\.arbitr\.ru\/Document\/Pdf\//);
  assert.match(nm.published, /MSK/, 'строка «27.06.2026 10:11:12 MSK» — публикация, а не новая запись');
  // «В ответ на» в одной строке с содержанием — режется по метке.
  const other = card.records.find((r) => r.date === '2026-07-01');
  assert.equal(other.content, 'О принятии заявления к производству');
  assert.match(other.responseTo, /О включении в реестр/);
  // Метка «Дата и время судебного заседания» и значение на разных строках.
  const acc = card.records.find((r) => r.date === '2026-07-15');
  assert.deepEqual([acc.hearing.date, acc.hearing.time], ['2026-08-12', '10:30']);
});

test('спор выделяется по «В ответ на», чужие документы не попадают', () => {
  const d = build();
  assert.equal(d.root.date, '2026-06-23');
  assert.match(d.root.from, /СБЕРБАНК/);
  assert.deepEqual(d.events.map((e) => e.rec.date), [
    '2026-06-23', '2026-06-26', '2026-07-10', '2026-07-15', '2026-08-05', '2026-08-12', '2026-09-16'
  ]);
  assert.ok(d.events.every((e) => e.confidence === 'root' || e.confidence === 'exact'));
  // Транзитивно: документы во исполнение отвечают определению, отзыв — определению о принятии.
  assert.equal(d.events.find((e) => e.rec.date === '2026-07-10').via, d.events[1].rec.id);
  // Письменные пояснения без «В ответ на» — только «возможно относится».
  assert.deepEqual(d.maybe.map((m) => m.rec.date), ['2026-07-20']);
});

test('стадия, роль, заседание и требования к управляющему', () => {
  const d = build();
  assert.equal(d.stage, 'pending');
  assert.equal(d.role, 'participant', 'заявление подал кредитор — управляющий участник спора');
  assert.deepEqual([d.hearing.date, d.hearing.time], ['2026-10-21', '14:20']);
  const reply = d.tasks.find((t) => /отзыв на заявление/.test(t.what));
  assert.ok(reply.done, 'отзыв управляющего от 05.08.2026 уже в карточке');
  assert.equal(reply.done.date, '2026-08-05');
  const open = d.tasks.filter((t) => !t.done);
  assert.ok(open.length >= 3);
  assert.ok(open.filter((t) => t.due).every((t) => t.due.date === '2026-10-21'));
  // Требование «дождаться принятия» уже неактуально: заявление принято.
  assert.ok(!d.tasks.some((t) => /Дождаться определения о принятии/.test(t.what)));
});

test('поручение суда управляющему из текста определения — со сроком', () => {
  const ev = card.records.find((r) => r.date === '2026-09-16');
  const d = build({ texts: { [ev.id]: 'О П Р Е Д Е Л И Л:\nОтложить судебное заседание на 21.10.2026 на 14 час. 20 мин.\nФинансовому управляющему представить выписки по счетам должника в срок до 14.10.2026.' } });
  const t = d.tasks.find((x) => x.fromText);
  assert.match(t.what, /выписки по счетам/);
  assert.equal(t.due.date, '2026-10-14');
  assert.equal(d.tasks[0], t, 'ближайший срок — первым');
});

test('два заявления банка в один день: связь по дате и заявителю — только «вероятно»', () => {
  const text = fixture('card-sber.txt').replace(
    '22.06.2026\nЗаявление\nПАО "СБЕРБАНК РОССИИ"\nО включении в реестр требований кредиторов',
    '23.06.2026\nЗаявление\nПАО "СБЕРБАНК РОССИИ"\nО включении в реестр требований кредиторов');
  const d = X.build(C.parse(text), { filedDate: '2026-06-23' });
  const nm = d.events.find((e) => e.rec.date === '2026-06-26');
  assert.equal(nm.confidence, 'likely');
  assert.match(nm.reasons.join(' '), /подходит и к другому документу/);
});

test('ответ с чужим предметом («О включении в реестр…») к спору не относится', () => {
  const d = build();
  assert.ok(!d.events.some((e) => e.rec.date === '2026-07-01'));
});

test('заявления ещё нет в карточке — корень по дате подачи', () => {
  const d = X.build(C.parse(''), { filedDate: '2026-09-25', applicant: 'ПАО Сбербанк' });
  assert.equal(d.rootFound, false);
  assert.equal(d.stage, 'filed');
  assert.equal(d.role, 'participant');
  assert.equal(d.tasks[0].due.date, '2026-10-02', 'пять рабочих дней на решение о принятии');
});

test('ручные исправления: включить, исключить, выбрать заявление', () => {
  const extra = card.records.find((r) => r.date === '2026-07-20');
  const nm = card.records.find((r) => r.date === '2026-06-26');
  const d = build({ include: [extra.id], exclude: [nm.id] });
  assert.ok(d.events.some((e) => e.rec.id === extra.id && e.confidence === 'manual'));
  assert.ok(!d.events.some((e) => e.rec.id === nm.id));
  // Без определения об оставлении без движения теряется и ответ на него.
  assert.ok(!d.events.some((e) => e.rec.date === '2026-07-10'));

  const fu = card.records.find((r) => r.date === '2026-06-20');
  const d2 = build({ rootId: fu.id });
  assert.equal(d2.role, 'applicant');
  assert.deepEqual(d2.events.map((e) => e.rec.date), ['2026-06-20', '2026-07-03']);
});

test('новые документы — те, которых не было при прошлом просмотре', () => {
  const seen = build().events.slice(0, 5).map((e) => e.rec.id);
  const d = build({ known: seen });
  assert.deepEqual(d.events.filter((e) => e.isNew).map((e) => e.rec.date), ['2026-08-12', '2026-09-16']);
  assert.equal(X.summary(d).newEvents, 2);
});

test('HTML-вставка разбирается так же, как текст', () => {
  const html = '<html><body>' + fixture('card-sber.txt').split('\n').map((l) => {
    const pdf = l.match(/^PDF: (.*)$/);
    return pdf ? `<a href="${pdf[1].replace('https://kad.arbitr.ru', '')}">скачать</a>` : `<div>${l}</div>`;
  }).join('') + '</body></html>';
  const c2 = C.parse(html);
  assert.equal(c2.diagnostics.source, 'html');
  assert.equal(c2.records.length, 17);
  assert.equal(c2.diagnostics.withPdf, 3, 'относительные ссылки на PDF становятся полными');
  assert.equal(X.build(c2, { filedDate: '2026-06-23' }).events.length, 7);
});
