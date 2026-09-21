/*
 * Даты и процессуальные сроки. Работает и в браузере, и в Node: наружу
 * выставляется globalThis.KadDates, импортов нет.
 *
 * Дата внутри — строка 'ГГГГ-ММ-ДД'. Объект Date не используется как
 * носитель: часовой пояс пользователя не должен смещать календарный день,
 * а срок «до 15.10.2026» — это именно календарный день, а не момент.
 */
(function () {
  'use strict';

  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  const pad = (n) => String(n).padStart(2, '0');
  const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

  /** Существует ли такой календарный день (31 февраля отсекается здесь). */
  function valid(y, m, d) {
    if (!(y >= 1900 && y <= 2200) || !(m >= 1 && m <= 12) || !(d >= 1)) return false;
    return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  /**
   * Разбор даты из всего, что встречается в документах и в буфере обмена:
   * 23.06.2026, 23/06/2026, 23062026, 2026-06-23, «23 июня 2026».
   * Возвращает 'ГГГГ-ММ-ДД' либо null. Двузначный год не принимается
   * намеренно: в сроках «до 15.10.26» цена ошибки в веке слишком велика.
   */
  function parse(input) {
    if (!input) return null;
    const s = String(input).trim().toLowerCase().replace(/ /g, ' ');

    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return valid(+m[1], +m[2], +m[3]) ? iso(+m[1], +m[2], +m[3]) : null;

    m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/);
    if (m) return valid(+m[3], +m[2], +m[1]) ? iso(+m[3], +m[2], +m[1]) : null;

    m = s.match(/^(\d{2})(\d{2})(\d{4})$/);
    if (m) return valid(+m[3], +m[2], +m[1]) ? iso(+m[3], +m[2], +m[1]) : null;

    m = s.match(/^(\d{1,2})\s+([а-яё]+)\s+(\d{4})/);
    if (m) {
      const mi = MONTHS.findIndex((name) => name.startsWith(m[2].slice(0, 4)));
      if (mi >= 0 && valid(+m[3], mi + 1, +m[1])) return iso(+m[3], mi + 1, +m[1]);
    }
    return null;
  }

  /** Первая дата, найденная где-то внутри текста (для строк вида «от 23.06.2026 10:15»). */
  function find(text) {
    if (!text) return null;
    const s = String(text).replace(/ /g, ' ');
    let m = s.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/);
    if (m && valid(+m[3], +m[2], +m[1])) return iso(+m[3], +m[2], +m[1]);
    m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m && valid(+m[1], +m[2], +m[3])) return iso(+m[1], +m[2], +m[3]);
    m = s.toLowerCase().match(/(\d{1,2})\s+([а-яё]{3,})\s+(\d{4})/);
    if (m) {
      const mi = MONTHS.findIndex((name) => name.startsWith(m[2].slice(0, 4)));
      if (mi >= 0 && valid(+m[3], mi + 1, +m[1])) return iso(+m[3], mi + 1, +m[1]);
    }
    return null;
  }

  const fmt = (d) => d ? d.slice(8, 10) + '.' + d.slice(5, 7) + '.' + d.slice(0, 4) : '—';

  const fmtLong = (d) => d
    ? `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`
    : '—';

  const utc = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  const fromUTC = (ms) => {
    const t = new Date(ms);
    return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  };
  const shift = (d, days) => fromUTC(utc(d) + days * 86400000);
  /** Календарных дней между датами (b - a). */
  const diff = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);
  /** 1 — понедельник, 7 — воскресенье. */
  const weekday = (d) => new Date(utc(d)).getUTCDay() || 7;

  const today = () => {
    const t = new Date();
    return iso(t.getFullYear(), t.getMonth() + 1, t.getDate());
  };

  /*
   * Нерабочие праздничные дни — ст. 112 ТК РФ. Переносы, которые Правительство
   * устанавливает постановлением на каждый год отдельно (например, майские),
   * здесь неизвестны: постановление на будущий год ещё не издано. Поэтому
   * применяется только общее правило ч. 2 ст. 112 ТК — выходной, совпавший
   * с праздником, переносится на следующий рабочий день. Расчёт, который
   * мог задеть такой перенос, помечается как приблизительный.
   */
  const FIXED = ['01-01', '01-02', '01-03', '01-04', '01-05', '01-06', '01-07', '01-08',
    '02-23', '03-08', '05-01', '05-09', '06-12', '11-04'];

  const holidayCache = new Map();

  function holidays(year) {
    if (holidayCache.has(year)) return holidayCache.get(year);
    const set = new Set(FIXED.map((md) => `${year}-${md}`));
    // Перенос: идём по праздникам в хронологическом порядке и сдвигаем
    // совпавшие с выходным на первый свободный рабочий день.
    for (const md of FIXED) {
      const d = `${year}-${md}`;
      if (weekday(d) < 6) continue;
      let to = shift(d, 1);
      while (weekday(to) >= 6 || set.has(to)) to = shift(to, 1);
      set.add(to);
    }
    holidayCache.set(year, set);
    return set;
  }

  const isHoliday = (d) => holidays(+d.slice(0, 4)).has(d);
  const isWorkday = (d) => weekday(d) < 6 && !isHoliday(d);

  const nextWorkday = (d) => {
    let r = d;
    while (!isWorkday(r)) r = shift(r, 1);
    return r;
  };

  /**
   * Срок, исчисляемый днями: ч. 3 ст. 113 АПК РФ — нерабочие дни в него
   * не включаются, а течение начинается со следующего дня после события
   * (ч. 4 ст. 113). То есть «10 дней со дня вынесения определения» —
   * это десять рабочих дней, начиная со следующего рабочего.
   */
  function addWorkdays(from, days) {
    let d = from;
    let left = days;
    let met = 0;
    while (left > 0) {
      d = shift(d, 1);
      if (isHoliday(d)) met++;
      if (isWorkday(d)) left--;
    }
    // Праздник внутри срока — единственный случай, когда расчёт может
    // разойтись с действительностью: переносы на конкретный год устанавливает
    // отдельное постановление Правительства, и оно здесь неизвестно.
    return { date: d, approximate: met > 0, holidays: met };
  }

  /**
   * Срок, исчисляемый месяцами: истекает в соответствующее число последнего
   * месяца, а если такого числа нет — в последний день месяца (ч. 2 ст. 114
   * АПК РФ). Если день окончания нерабочий — переносится на следующий
   * рабочий (ч. 4 ст. 114).
   */
  function addMonths(from, months) {
    const y = +from.slice(0, 4);
    const m = +from.slice(5, 7);
    const d = +from.slice(8, 10);
    const t = new Date(Date.UTC(y, m - 1 + months, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    const raw = iso(t.getUTCFullYear(), t.getUTCMonth() + 1, Math.min(d, last));
    const date = nextWorkday(raw);
    // Сам срок календарный, поэтому сдвинуть его может только перенос
    // выходного дня в самом конце — когда день окончания оказался нерабочим.
    let met = 0;
    for (let x = raw; x <= date; x = shift(x, 1)) if (isHoliday(x)) met++;
    return { date, approximate: met > 0, holidays: met };
  }

  /** Календарные дни до даты: 0 — сегодня, отрицательное — просрочено. */
  const until = (date, from) => diff(from || today(), date);

  /** «осталось 3 дня» / «истёк 2 дня назад» — с правильными окончаниями. */
  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }
  const days = (n) => `${Math.abs(n)} ${plural(n, 'день', 'дня', 'дней')}`;

  globalThis.KadDates = {
    parse, find, fmt, fmtLong, shift, diff, weekday, today,
    isHoliday, isWorkday, nextWorkday, addWorkdays, addMonths, until, days, plural,
    MONTHS
  };
})();
