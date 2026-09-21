/*
 * Разбор карточки дела с kad.arbitr. Наружу — globalThis.KadCard.
 *
 * Разбор текстовый, а не по CSS-классам. Причины две. Во-первых, в
 * приложение попадает именно текст: карточку выделяют Ctrl+A и копируют,
 * и разметки в буфере может не быть вовсе. Во-вторых, вёрстку картотеки
 * меняют без предупреждения, а порядок строк — «дата, тип документа, кто
 * подал, в ответ на что» — держится годами.
 *
 * HTML, если он есть, всё равно сначала превращается в такой же текст:
 * одна ветка разбора вместо двух, которые расходятся.
 */
(function () {
  'use strict';

  /* Строки интерфейса картотеки, попадающие в буфер вместе с данными. */
  const NOISE = [
    /^картотека арбитражных дел/i, /^кад\b/i, /^поиск(\s|$)/i, /^расширенный поиск/i,
    /^электронное дело$/i, /^хронология$/i, /^судебные акты$/i, /^все документы$/i,
    /^скачать/i, /^печать/i, /^ознакомиться/i, /^подать (документ|заявление)/i,
    /^следить за делом/i, /^моё дело/i, /^войти/i, /^выйти/i, /^регистрация/i,
    /^сервис/i, /^версия для печати/i, /^свернуть/i, /^развернуть/i, /^показать (ещё|все)/i,
    /^\d+\s*(документ|документов|документа)$/i, /^страница \d+/i, /^всего найдено/i,
    /^фильтр/i, /^сбросить/i, /^применить/i, /^закрыть$/i, /^назад$/i, /^вперёд$/i,
    /^cookie/i, /^мы используем/i, /^капча/i, /^проверка/i, /^javascript/i
  ];

  /* Поля записи. Порядок важен: сначала более длинные метки. */
  const FIELDS = [
    { key: 'responseTo', re: /^в\s+ответ\s+на[:\s]*(.*)$/i },
    { key: 'applicant', re: /^(?:заявитель|истец|кредитор)(?:\s*\(.*?\))?[:\s]+(.*)$/i },
    { key: 'respondent', re: /^(?:ответчик|должник|заинтересованное\s+лицо)[:\s]+(.*)$/i },
    { key: 'thirdParty', re: /^(?:третье\s+лицо|иные\s+лица)[:\s]+(.*)$/i },
    { key: 'judge', re: /^(?:судья|председательствующий)[:\s]+(.*)$/i },
    { key: 'instance', re: /^(?:инстанция|суд)[:\s]+(.*)$/i },
    { key: 'published', re: /^(?:дата\s+публикации|опубликован[оа]?)[:\s]+(.*)$/i },
    { key: 'from', re: /^(?:от|подал|заявитель\s+документа)[:\s]+(.*)$/i }
  ];

  /* Инстанции идут в карточке заголовками и переключают контекст записей. */
  const INSTANCES = [
    { re: /перв(ая|ой)\s+инстанц/i, name: 'Первая инстанция' },
    { re: /апелляц/i, name: 'Апелляция' },
    { re: /кассац/i, name: 'Кассация' },
    { re: /надзор|верховн/i, name: 'Надзор' }
  ];

  const DATE_AT_START = /^(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4})(?:\s+(\d{1,2}:\d{2}))?\s*(.*)$/;
  const TIME_ONLY = /^(\d{1,2}:\d{2}(?::\d{2})?)$/;
  /*
   * Номер дела: буква «А» в картотеке бывает и кириллической, и латинской.
   * Границу слова \b здесь использовать нельзя — кириллица для неё не буква,
   * и перед «А40-…» она не срабатывает; поэтому граница задана явно.
   */
  const CASE_NO = /(?:^|[^0-9A-Za-zА-Яа-яЁё])([АA]\s?\d{1,3}\s?-\s?\d{1,7}\s?\/\s?\d{4})/;

  /** ё→е, кавычки к одному виду, пробелы свёрнуты — для сравнения строк. */
  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/ /g, ' ')
      .replace(/ё/g, 'е')
      .replace(/[«»"'`„“”]/g, '')
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * HTML → текст. Блочные теги дают перевод строки: без этого «В ответ на»
   * склеивается с названием документа в одну строку и поле теряется.
   */
  function htmlToText(html) {
    if (typeof DOMParser === 'undefined') {
      return html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>|<\/(p|div|li|tr|td|th|h\d|section|article)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c));
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const el of doc.querySelectorAll('script,style,noscript,svg')) el.remove();
    for (const el of doc.querySelectorAll('br')) el.replaceWith('\n');
    for (const el of doc.querySelectorAll('p,div,li,tr,td,th,h1,h2,h3,h4,section,article,dt,dd'))
      el.append('\n');
    return doc.body ? doc.body.textContent : '';
  }

  /** Текст → массив содержательных строк. */
  function lines(raw) {
    return String(raw)
      .replace(/ /g, ' ')
      .replace(/\r/g, '')
      .split('\n')
      .map((l) => l.replace(/[\t ]+/g, ' ').trim())
      .filter((l) => l && l !== '·' && l !== '—' && l !== '-' && !NOISE.some((re) => re.test(l)));
  }

  /** Номер дела, суд, ссылка на карточку и участники «шапки». */
  function meta(all) {
    const D = globalThis.KadDates;
    const head = all.slice(0, 60);
    const text = all.join('\n');

    const no = ((text.match(CASE_NO) || [])[1] || '').replace(/\s+/g, '');
    const url = (text.match(/https?:\/\/kad\.arbitr\.ru\/[^\s"'<>]+/i) || [''])[0];
    const guid = (url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) ||
      text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [''])[0];

    let court = '';
    for (const l of head) {
      if (/(арбитражный суд|апелляционн|кассационн)/i.test(l) && l.length < 120) { court = l; break; }
    }

    // Должник: в карточке банкротного дела он идёт как «Должник: …», а в шапке
    // может стоять после номера дела без метки — тогда не угадываем.
    let debtor = '';
    const dm = text.match(/должник[:\s]+([^\n]{3,120})/i);
    if (dm) debtor = dm[1].trim();

    let judge = '';
    const jm = text.match(/суд(?:ья|ьи)[:\s]+([^\n]{3,80})/i);
    if (jm) judge = jm[1].trim();

    let subject = '';
    const sm = text.match(/^(?:о\s|о\b)[^\n]{5,160}$/im);
    if (sm) subject = sm[0].trim();

    const filed = (() => {
      const m = text.match(/(?:дата\s+регистрации|поступило|дата\s+поступления)[:\s]+([^\n]+)/i);
      return m ? D.find(m[1]) : null;
    })();

    return { caseNo: no, court, judge, debtor, subject, url, guid, filed };
  }

  /**
   * Записи карточки. Границей записи считается строка, начинающаяся с даты:
   * так устроены и хронология, и список судебных актов, и «Электронное дело».
   */
  function records(all) {
    const D = globalThis.KadDates;
    const out = [];
    let cur = null;
    let instance = '';

    const push = () => {
      if (!cur) return;
      // Запись без названия документа бесполезна и только шумит в таймлайне.
      if (cur.title) out.push(cur);
      cur = null;
    };

    for (let i = 0; i < all.length; i++) {
      const line = all[i];

      const inst = INSTANCES.find((x) => x.re.test(line) && line.length < 80 && !DATE_AT_START.test(line));
      if (inst && !/^в\s+ответ/i.test(line)) {
        instance = inst.name;
        if (!cur) continue;
      }

      const dm = line.match(DATE_AT_START);
      if (dm && D.parse(dm[1])) {
        push();
        cur = {
          date: D.parse(dm[1]),
          time: dm[2] || '',
          title: '',
          instance,
          extra: [],
          line: i
        };
        const rest = (dm[3] || '').trim();
        if (rest) absorb(cur, rest);
        continue;
      }

      if (!cur) continue;

      if (TIME_ONLY.test(line)) { cur.time = cur.time || line; continue; }
      absorb(cur, line);
    }
    push();

    for (const r of out) {
      r.title = r.title.replace(/\s*[·|]\s*$/, '').trim();
      r.id = `${r.date}|${norm(r.title).slice(0, 80)}|${norm(r.from || r.applicant || '').slice(0, 40)}`;
    }

    // Один и тот же документ попадает и в хронологию, и в судебные акты.
    const seen = new Map();
    for (const r of out) {
      const prev = seen.get(r.id);
      if (!prev) { seen.set(r.id, r); continue; }
      // Сливаем: у одной копии может быть «В ответ на», у другой — участники.
      for (const k of ['responseTo', 'applicant', 'respondent', 'thirdParty', 'judge', 'from', 'published', 'time'])
        if (!prev[k] && r[k]) prev[k] = r[k];
      prev.extra.push(...r.extra.filter((x) => !prev.extra.includes(x)));
    }

    return [...seen.values()].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : a.line - b.line);
  }

  /** Распределяет строку записи: поле, название документа или подробность. */
  function absorb(rec, line) {
    for (const f of FIELDS) {
      const m = line.match(f.re);
      if (m) {
        const v = (m[1] || '').trim();
        if (!v) { rec[f.key + 'Pending'] = true; return; }
        rec[f.key] = rec[f.key] ? rec[f.key] + '; ' + v : v;
        return;
      }
    }
    // Пустая метка «В ответ на:» переносом отделена от значения.
    for (const f of FIELDS) {
      if (rec[f.key + 'Pending']) {
        rec[f.key] = line;
        delete rec[f.key + 'Pending'];
        return;
      }
    }
    if (!rec.title) { rec.title = line; return; }
    // Организация или ФИО сразу после названия — это тот, кто подал документ.
    if (!rec.from && looksLikeParty(line)) { rec.from = line; return; }
    if (!rec.extra.includes(line)) rec.extra.push(line);
  }

  const ORG = /(ООО|ОАО|ЗАО|ПАО|АО|НАО|ИП|ГУП|МУП|АНО|НКО|Банк|банк|фонд|ФНС|УФНС|МИФНС|инспекция|управление)/;
  const FIO = /^[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?\s+[А-ЯЁ][а-яё.]+(?:\s+[А-ЯЁ][а-яё.]+)?$/;
  /* «Финансовый управляющий Сидоров П.П.» — участник, а не подробность:
     от того, кто подал заявление, зависит весь состав обязанностей ФУ. */
  const MANAGER = /^(?:финансов|арбитражн|конкурсн|внешн|временн)[а-яё]*\s+управляющ/i;

  function looksLikeParty(line) {
    if (line.length > 140) return false;
    if (MANAGER.test(line)) return true;
    if (/^[а-яё]/.test(line) && !ORG.test(line)) return false;
    return ORG.test(line) || FIO.test(line) || /^["«][^»"]{2,80}["»]$/.test(line);
  }

  /**
   * Разбор вставки. Принимает и HTML, и текст; результат один и тот же.
   * diagnostics нужен, когда разбор дал пусто: без него пользователю
   * нечего прислать, а мне — нечего починить.
   */
  function parse(input, opts) {
    const raw = String(input || '');
    const isHtml = (opts && opts.html) || /<\/?(html|body|div|table|td|span)[\s>]/i.test(raw);
    const text = isHtml ? htmlToText(raw) : raw;
    const all = lines(text);
    const recs = records(all);
    return {
      meta: meta(all),
      records: recs,
      diagnostics: {
        source: isHtml ? 'html' : 'text',
        lines: all.length,
        records: recs.length,
        head: all.slice(0, 12),
        withResponseTo: recs.filter((r) => r.responseTo).length
      }
    };
  }

  globalThis.KadCard = { parse, lines, htmlToText, records, meta, norm, CASE_NO };
})();
