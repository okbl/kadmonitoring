import test from 'node:test';
import assert from 'node:assert/strict';
import { D } from './load.mjs';

test('разбор дат во всех видах, в которых их вставляют', () => {
  assert.equal(D.parse('23.06.2026'), '2026-06-23');
  assert.equal(D.parse('23062026'), '2026-06-23');
  assert.equal(D.parse('2026-06-23'), '2026-06-23');
  assert.equal(D.parse('23 июня 2026'), '2026-06-23');
  assert.equal(D.parse('31.02.2026'), null);
  assert.equal(D.parse('23.06.26'), null, 'двузначный год не принимается');
  assert.equal(D.find('Заявление  от (23.06.2026) от ПАО'), '2026-06-23');
});

test('срок в днях — рабочие дни со следующего дня (ст. 113 АПК РФ)', () => {
  // Пятница 16.10.2026 + 10 рабочих дней = пятница 30.10.2026.
  assert.equal(D.addWorkdays('2026-10-16', 10).date, '2026-10-30');
  // 30.10.2026 (пт) + 5: выходные и праздник 4 ноября пропускаются.
  const r = D.addWorkdays('2026-10-30', 5);
  assert.equal(r.date, '2026-11-09');
  assert.equal(r.approximate, true, 'праздник внутри срока — дата помечается приблизительной');
});

test('срок в месяцах — то же число, конец месяца, перенос с выходного (ст. 114 АПК РФ)', () => {
  assert.equal(D.addMonths('2026-12-31', 2).date, '2027-03-01', '28.02.2027 — воскресенье, перенос на понедельник');
  assert.equal(D.addMonths('2026-07-15', 2).date, '2026-09-15');
});
