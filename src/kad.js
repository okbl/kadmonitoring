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
 * одна ветка разбора вместо двух, которые расходятся. Загрузчик на сервере
 * (server/kad-fetch.mjs) тоже отдаёт текст — либо текст страницы, либо
 * записи картотеки, переложенные в тот же построчный вид с явными метками.
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
    /^cookie/i, /^мы используем/i, /^капча/i, /^javascript/i,
    // Служебные строки настоящей карточки: штрихкод документа и подсказки.
    /^штрихкод\s*\d*$/i, /^нажмите, чтобы/i, /^отслеживать дело$/i, /^отправить на печать$/i,
    /^подать документы в суд$/i, /^ввести код$/i, /^отчет по датам публикаций$/i, /^перейти к банкротному виду$/i
  ];

  const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

  /* Поля записи. Порядок важен: сначала более длинные и более точные метки. */
  const FIELDS = [
    { key: 'responseToId', re: new RegExp(`^ответ\\s+на\\s+документ[:\\s]+(${GUID})\\s*$`, 'i') },
    { key: 'docId', re: new RegExp(`^(?:документ|id\\s+документа)[:\\s]+(${GUID})\\s*$`, 'i') },
    { key: 'pdf', re: /^pdf[:\s]+(https?:\/\/\S+)\s*$/i },
    { key: 'responseTo', re: /^в\s+ответ\s+на[:\s]*(.*)$/i },
    { key: 'hearingInfo', re: /^(?:дата\s+и\s+время\s+(?:судебного\s+)?заседания|(?:судебное\s+)?заседание\s+назначено(?:\s+на)?)[:\s]*(.*)$/i },
    { key: 'applicant', re: /^(?:заявитель|истец|кредитор)(?:\s*\(.*?\))?[:\s]+(.*)$/i },
    { key: 'respondent', re: /^(?:ответчик|должник|заинтересованное\s+лицо)[:\s]+(.*)$/i },
    { key: 'thirdParty', re: /^(?:третье\s+лицо|иные\s+лица)[:\s]+(.*)$/i },
    { key: 'judge', re: /^(?:судья|председательствующий)[:\s]+(.*)$/i },
    { key: 'instance', re: /^(?:инстанция|суд)[:\s]+(.*)$/i },
    { key: 'published', re: /^(?:дата\s+публикации|публикация|опубликован[оа]?)[:\s]+(.*)$/i },
    { key: 'appealUntil', re: /^обжалование\s+до[:\s]+(.*)$/i },
    { key: 'from', re: /^(?:подал|заявитель\s+документа)[:\s]+(.*)$/i }
  ];

  /*
   * «В ответ на» и дата заседания в тексте страницы бывают в одной строке с
   * названием документа: блоки картотеки строчные, и при копировании перевод
   * строки между ними теряется. Такая строка режется по метке.
   */
  const INLINE = /\s+(?=(?:в\s+ответ\s+на|дата\s+и\s+время\s+(?:судебного\s+)?заседания)[\s:])/i;

  /*
   * Инстанции идут в карточке заголовками и переключают контекст записей.
   * Узнаются только заголовки, а не любое упоминание: запись «Апелляционная
   * жалоба» в хронологии первой инстанции контекст не меняет.
   */
  const INSTANCES = [
    { re: /^перв[а-яё]*\s+инстанци/i, name: 'Первая инстанция' },
    { re: /^апелляционн[а-яё]*\s+инстанци|^[а-яё0-9-]*\s*арбитражн[а-яё]*\s+апелляционн[а-яё]*\s+суд/i, name: 'Апелляция' },
    { re: /^кассационн[а-яё]*\s+инстанци|^арбитражн[а-яё]*\s+суд\s+[а-яё-]+\s+(?:[а-яё-]+\s+)?округа/i, name: 'Кассация' },
    { re: /^надзорн[а-яё]*\s+инстанци|^верховн[а-яё]*\s+суд/i, name: 'Надзор' }
  ];

  const DATE_AT_START = /^(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4})(?:\s+(\d{1,2}:\d{2}))?\s*(.*)$/;
  const TIME_ONLY = /^(\d{1,2}:\d{2}(?::\d{2})?)$/;
  /*
   * Строка, начинающаяся с даты, но не открывающая запись: отметка о
   * публикации («29.06.2026 10:11:12 MSK») или продолжение предыдущей строки
   * («05.08.2026, 10:30, зал 3010» после «Дата и время судебного заседания»).
   */
  const NOT_A_RECORD = /^(?::\d{2}\b|[,;:)]|.*\b(?:MSK|МСК)\b)/i;

  /*
   * Тип документа без содержания: «Определение», «Заявление». Картотека
   * пишет тип и содержание («Об оставлении заявления без движения») разными
   * строками, и для опознания нужны обе.
   */
  const BARE_TYPE = /^(?:заявлени[а-яё]*|определени[а-яё]*|решени[а-яё]*|постановлени[а-яё]*|ходатайств[а-яё]*|отзыв[а-яё]*|жалоб[а-яё]*|апелляционн[а-яё]*\s+жалоб[а-яё]*|кассационн[а-яё]*\s+жалоб[а-яё]*|протокол[а-яё]*|возражени[а-яё]*|дополнени[а-яё]*|дополнительные\s+документы|пояснени[а-яё]*|письменные\s+пояснения|иные\s+документы|документ|уведомлени[а-яё]*|письм[а-яё]*|мнени[а-яё]*|исполнительный\s+лист|заявление\s*\(ходатайство\)|заявление\s*\/\s*ходатайство)$/i;

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
   * Ссылки на PDF судебных актов сохраняются отдельной строкой «PDF: …» —
   * по ним сервер умеет достать текст определения.
   */
  function htmlToText(html) {
    if (typeof DOMParser === 'undefined') {
      return html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<a\b[^>]*href="([^"]*\/(?:Document\/Pdf|Kad\/PdfDocument)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
          (_, href, inner) => `${inner}\nPDF: ${absolute(href)}\n`)
        .replace(/<br\s*\/?>|<\/(p|div|li|tr|td|th|h\d|section|article|dt|dd)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c));
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const el of doc.querySelectorAll('script,style,noscript,svg')) el.remove();
    for (const a of doc.querySelectorAll('a[href*="/Document/Pdf/"], a[href*="/PdfDocument/"]'))
      a.after(`\nPDF: ${absolute(a.getAttribute('href'))}\n`);
    for (const el of doc.querySelectorAll('br')) el.replaceWith('\n');
    for (const el of doc.querySelectorAll('p,div,li,tr,td,th,h1,h2,h3,h4,section,article,dt,dd'))
      el.append('\n');
    return doc.body ? doc.body.textContent : '';
  }

  const absolute = (href) => /^https?:/i.test(href) ? href : 'https://kad.arbitr.ru' + (href.startsWith('/') ? '' : '/') + href;

  /** Текст → массив содержательных строк. */
  function lines(raw) {
    return String(raw)
      .replace(/ /g, ' ')
      .replace(/\r/g, '')
      .split('\n')
      // «[Подписано]» — отметка картотеки об электронной подписи, не название.
      .map((l) => l.replace(/[\t ]+/g, ' ').trim().replace(/^\[подписано\]\s*/i, ''))
      .filter((l) => l && l !== '·' && l !== '—' && l !== '-' && !NOISE.some((re) => re.test(l)));
  }

  /** Номер дела, суд, ссылка на карточку и участники «шапки». */
  function meta(all) {
    const D = globalThis.KadDates;
    const head = all.slice(0, 60);
    const text = all.join('\n');

    const no = ((text.match(CASE_NO) || [])[1] || '').replace(/\s+/g, '').replace(/^A/, 'А');
    const url = (text.match(/https?:\/\/kad\.arbitr\.ru\/Card\/[^\s"'<>]+/i) || [''])[0];
    const guid = (url.match(new RegExp(GUID, 'i')) || [''])[0];

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
    // «Судья: …» в начале строки; «Суды и судьи» — заголовок вкладки картотеки.
    const jm = text.match(/^судья[:\s]+([^\n]{3,80})$/im);
    if (jm) judge = jm[1].trim();

    const filed = (() => {
      const m = text.match(/(?:дата\s+регистрации|поступило|дата\s+поступления)[:\s]+([^\n]+)/i);
      return m ? D.find(m[1]) : null;
    })();

    return { caseNo: no, court, judge, debtor, url, guid, filed };
  }

  const hasPending = (rec) => FIELDS.some((f) => rec[f.key + 'Pending']);

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
      // Заголовок инстанции («07.07.2026 · А60-3212/2025 АС Свердловской
      // области») тоже начинается с даты, но это не документ.
      if (cur.title && !(CASE_NO.test(' ' + cur.title) && cur.title.length < 90)) out.push(cur);
      cur = null;
    };

    for (let i = 0; i < all.length; i++) {
      const line = all[i];

      if (line.length < 100 && !DATE_AT_START.test(line)) {
        const inst = INSTANCES.find((x) => x.re.test(line));
        if (inst) { push(); instance = inst.name; continue; }
      }

      const dm = line.match(DATE_AT_START);
      if (dm && D.parse(dm[1]) && !(cur && hasPending(cur))) {
        const rest = (dm[3] || '').trim();
        if (cur && NOT_A_RECORD.test(rest)) {
          if (/\b(?:MSK|МСК)\b/i.test(rest) && !cur.published) cur.published = line;
          else absorb(cur, line);
          continue;
        }
        push();
        cur = {
          date: D.parse(dm[1]),
          time: dm[2] || '',
          title: '',
          content: '',
          instance,
          extra: [],
          line: i
        };
        if (rest) absorb(cur, rest);
        continue;
      }

      if (!cur) continue;

      if (TIME_ONLY.test(line)) { cur.time = cur.time || line; continue; }
      absorb(cur, line);
    }
    push();

    for (const r of out) {
      for (const f of FIELDS) delete r[f.key + 'Pending'];
      r.title = r.title.replace(/\s*[·|]\s*$/, '').trim();
      if (r.appealUntil) r.appealUntil = D.find(r.appealUntil);
      if (r.hearingInfo) {
        const hd = D.find(r.hearingInfo);
        if (hd) r.hearing = { date: hd, time: (r.hearingInfo.match(/\b(\d{1,2}[:.]\d{2})\b(?![.\d])/) || ['', ''])[1].replace('.', ':'), text: r.hearingInfo };
      }
      r.id = r.docId || `${r.date}|${norm(r.title + ' ' + r.content).slice(0, 100)}|${norm(r.from || r.applicant || '').slice(0, 40)}`;
    }

    // Один и тот же документ попадает и в хронологию, и в судебные акты.
    const seen = new Map();
    for (const r of out) {
      const prev = seen.get(r.id);
      if (!prev) { seen.set(r.id, r); continue; }
      // Сливаем: у одной копии может быть «В ответ на», у другой — участники.
      for (const k of ['responseTo', 'responseToId', 'applicant', 'respondent', 'thirdParty', 'judge', 'from', 'published', 'time', 'pdf', 'hearing', 'hearingInfo', 'appealUntil'])
        if (!prev[k] && r[k]) prev[k] = r[k];
      prev.extra.push(...r.extra.filter((x) => !prev.extra.includes(x)));
    }

    return [...seen.values()].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : a.line - b.line);
  }

  /** Распределяет строку записи: поле, название документа или подробность. */
  function absorb(rec, line) {
    const cut = line.match(INLINE);
    if (cut && cut.index > 0) {
      absorb(rec, line.slice(0, cut.index).trim());
      absorb(rec, line.slice(cut.index).trim());
      return;
    }
    for (const f of FIELDS) {
      const m = line.match(f.re);
      if (m) {
        const v = (m[1] || '').trim();
        if (!v) { rec[f.key + 'Pending'] = true; return; }
        rec[f.key] = rec[f.key] && rec[f.key] !== v ? rec[f.key] + '; ' + v : v;
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
    if (!rec.content && BARE_TYPE.test(rec.title) && !BARE_TYPE.test(line)) { rec.content = line; return; }
    if (!rec.extra.includes(line)) rec.extra.push(line);
  }

  const ORG = /(ООО|ОАО|ЗАО|ПАО|АО|НАО|ИП|ГУП|МУП|АНО|НКО|Банк|банк|фонд|ФНС|УФНС|МИФНС|инспекция|управление|служба)/;
  const FIO = /^[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?\s+[А-ЯЁ][а-яё.]*\.?(?:\s*[А-ЯЁ][а-яё.]*)?$/;
  /* «Финансовый управляющий Сидоров П.П.» — участник, а не подробность:
     от того, кто подал заявление, зависит весь состав обязанностей ФУ. */
  const MANAGER = /^(?:финансов|арбитражн|конкурсн|внешн|временн)[а-яё]*\s+управляющ/i;

  function looksLikeParty(line) {
    if (line.length > 140) return false;
    if (MANAGER.test(line)) return true;
    // «О признании сделки недействительной», «Об отложении…» — содержание,
    // даже если в нём названа организация («О включении требования ПАО…»).
    if (/^(?:о|об|по|в|во|на|с|к|за)\s/i.test(line)) return false;
    if (/^[а-яё]/.test(line) && !ORG.test(line)) return false;
    if (BARE_TYPE.test(line)) return false;
    return ORG.test(line) || FIO.test(line) || /^["«][^»"]{2,80}["»]$/.test(line);
  }

  /** Название документа для показа: тип и содержание вместе. */
  function title(rec) {
    if (!rec) return '';
    if (rec.content) return `${rec.title}: ${rec.content}`;
    return rec.title;
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
        withResponseTo: recs.filter((r) => r.responseTo || r.responseToId).length,
        withPdf: recs.filter((r) => r.pdf).length
      }
    };
  }

  globalThis.KadCard = { parse, lines, htmlToText, records, meta, norm, title, looksLikeParty, CASE_NO, GUID };
})();
