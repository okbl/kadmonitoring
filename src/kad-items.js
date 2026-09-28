/*
 * Записи API картотеки → построчный текст, который разбирает src/kad.js.
 * Наружу — globalThis.KadItems. Работает и в Node (сервер), и в браузере
 * (фоновая часть расширения), поэтому без импортов: GUID_RE — свой.
 *
 * Имена полей картотеки документированы только её вёрсткой; поля ищутся
 * по смыслу имени (Date/DisplayDate, DocumentTypeName, ContentTypes…), а
 * связь и заседание — ещё и в строке AdditionalInfo. Устройство ответа
 * проверено на настоящей карточке (tools/kad-probe.mjs).
 */
(function () {
  'use strict';

  const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  const pick = (o, re) => {
    for (const [k, v] of Object.entries(o || {})) if (re.test(k) && v != null && v !== '') return v;
    return null;
  };

  /** «/Date(1719100800000)/», ISO или «23.06.2026» → «23.06.2026». */
  function ruDate(v) {
    if (!v) return '';
    const s = String(v);
    let m = s.match(/^\d{1,2}\.\d{1,2}\.\d{4}/);
    if (m) return m[0];
    m = s.match(/\/Date\((-?\d+)/);
    const d = m ? new Date(+m[1]) : /^\d{4}-\d{2}-\d{2}/.test(s) ? new Date(s) : null;
    if (!d || isNaN(d)) return '';
    const msk = new Date(d.getTime() + 3 * 3600 * 1000);  // даты картотеки — московские
    return `${String(msk.getUTCDate()).padStart(2, '0')}.${String(msk.getUTCMonth() + 1).padStart(2, '0')}.${msk.getUTCFullYear()}`;
  }

  const names = (v) => (Array.isArray(v) ? v : v ? [v] : [])
    .map((x) => typeof x === 'string' ? x : (x && (x.Organization || x.Name || x.Fio || x.FullName || x.ShortName || x.Title)) || '')
    .filter(Boolean);

  /** Любая строка внутри записи, начинающаяся с «В ответ на». */
  function deepFind(o, re, depth = 0) {
    if (depth > 3 || !o) return null;
    if (typeof o === 'string') return re.test(o) ? o : null;
    if (typeof o !== 'object') return null;
    for (const v of Object.values(o)) {
      const hit = deepFind(v, re, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Записи API → построчный текст с явными метками. Имена полей картотеки
   * документированы только её вёрсткой, поэтому поля ищутся по смыслу имени,
   * а не по точному совпадению: Date/DisplayDate, DocumentTypeName, ContentTypes…
   */
  function itemsToText(items, caseId, base = 'https://kad.arbitr.ru') {
    const byId = new Map(items.map((it) => [String(it.Id || it.id || ''), it]));
    const blocks = [];
    const sorted = [...items].sort((a, b) => {
      const da = ruDate(pick(a, /^(?:DisplayDate|Date|RegDate|DocumentDate)$/i)).split('.').reverse().join('');
      const db = ruDate(pick(b, /^(?:DisplayDate|Date|RegDate|DocumentDate)$/i)).split('.').reverse().join('');
      return da < db ? -1 : da > db ? 1 : 0;
    });
    for (const it of sorted) {
      if (it.IsDeleted) continue;
      const date = ruDate(pick(it, /^(?:DisplayDate|Date|RegDate|DocumentDate|RegistrationDate)$/i) || pick(it, /date/i));
      if (!date) continue;
      const type = pick(it, /^(?:DocumentTypeName|DocumentType|TypeName|DocType)$/i) || 'Документ';
      const content = pick(it, /^(?:ContentTypes|ContentTypeName|ContentType|Content|Subject)$/i);
      const contentText = Array.isArray(content) ? content.map((x) => typeof x === 'string' ? x : x && (x.Name || x.Title) || '').filter(Boolean).join('; ') : (typeof content === 'string' ? content : '');
      const lines = [date, String(type)];
      if (contentText) lines.push(contentText);
      const from = names(pick(it, /^(?:Declarers|Declarer|Applicants|Applicant|Participants|Sides)$/i));
      if (from.length) lines.push(`Подал: ${from.join(', ')}`);
      const judges = names(pick(it, /^(?:Judges|Judge|JudgeName)$/i));
      if (judges.length) lines.push(`Судья: ${judges.join(', ')}`);
      const id = String(it.Id || it.id || '');
      if (GUID_RE.test(id)) lines.push(`Документ: ${id.match(GUID_RE)[0]}`);

      // Картотека пишет связь и заседание в AdditionalInfo одной строкой:
      // «Штрихкод: 0031739831 В ответ на Заявление (23.06.2026) от ПАО …,
      // Дата и время судебного заседания 15.09.2026, 10:00, зал № 602».
      let info = String(pick(it, /^AdditionalInfo$/i) || '').replace(/штрихкод:?\s*\d+/i, '').trim();
      let hearingText = '';
      const hm = info.match(/,?\s*дата\s+и\s+время\s+(?:судебного\s+)?заседания[:\s]*(.+)$/i);
      if (hm) { hearingText = hm[1].trim(); info = info.slice(0, hm.index).trim(); }
      let reasonText = '';
      const rm = info.match(/в\s+ответ\s+на[:\s]*(.+)$/i);
      if (rm) { reasonText = rm[1].replace(/[,;]\s*$/, '').trim(); info = info.slice(0, rm.index).trim(); }
      if (!reasonText) {
        const deep = deepFind(it, /в\s+ответ\s+на/i);
        if (deep) reasonText = deep.replace(/^[\s\S]*?в\s+ответ\s+на[:\s]*/i, '').trim();
      }

      // Ссылка на документ точнее любого сравнения по дате, а текст нужен
      // человеку и тем записям, у которых ссылки нет.
      const reasonId = pick(it, /(?:Reason|Parent|Answer|Response|Basis)(?:Document)?Id$/i);
      if (reasonText) {
        lines.push(`В ответ на: ${reasonText}`);
      } else if (reasonId && byId.has(String(reasonId))) {
        const ref = byId.get(String(reasonId));
        const rType = pick(ref, /^(?:DocumentTypeName|DocumentType|TypeName)$/i) || 'Документ';
        const rFrom = names(pick(ref, /^(?:Declarers|Declarer|Applicants)$/i)).join(', ');
        lines.push(`В ответ на: ${rType} (${ruDate(pick(ref, /^(?:DisplayDate|Date)$/i))})${rFrom ? ` от ${rFrom}` : ''}`);
      }
      if (reasonId && GUID_RE.test(String(reasonId))) lines.push(`Ответ на документ: ${String(reasonId).match(GUID_RE)[0]}`);

      const hearing = pick(it, /^(?:HearingDate|HearingDateTime|SessionDate)$/i);
      if (hearingText) {
        lines.push(`Дата и время судебного заседания: ${hearingText}`);
      } else if (hearing) {
        const place = pick(it, /^(?:HearingPlace|SessionPlace|Place)$/i);
        const t = String(hearing).match(/\/Date\((-?\d+)/)
          ? (() => { const d = new Date(+String(hearing).match(/\/Date\((-?\d+)/)[1] + 3 * 3600 * 1000); return `${ruDate(hearing)}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; })()
          : String(hearing);
        lines.push(`Дата и время судебного заседания: ${t}${place ? `, ${place}` : ''}`);
      }
      const comment = pick(it, /^(?:Comment|Description|Note)$/i);
      for (const extra of [info, typeof comment === 'string' ? comment : '']) {
        if (extra && extra.trim()) lines.push(extra.trim().replace(/\s+/g, ' '));
      }
      const pub = pick(it, /^(?:PublishDisplayDate|PublishDate|PublicationDate)$/i);
      if (pub) lines.push(`Публикация: ${/\/Date\(/.test(pub) ? ruDate(pub) : pub}`);
      // Срок обжалования, который считает сама картотека.
      const appeal = pick(it, /^AppealDate$/i);
      if (appeal) lines.push(`Обжалование до: ${ruDate(appeal)}`);

      const file = pick(it, /^(?:FileName|File)$/i);
      const docCase = String(it.CaseId || caseId || '');
      if (file && id && docCase) lines.push(`PDF: ${base}/Kad/PdfDocument/${docCase}/${id}/${encodeURIComponent(String(file))}`);
      blocks.push(lines.join('\n'));
    }
    return blocks.join('\n');
  }

  /**
   * Из двух текстов — страницы и API картотеки — берётся тот, где больше
   * записей. К тексту API приписывается шапка дела со страницы: номер, суд,
   * должник в записях API не повторяются.
   */
  function chooseText(r, url) {
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
    const e = new Error('в загруженной карточке не найдено ни одного документа — возможно, картотека изменила устройство страницы. Вставьте страницу вручную (Ctrl+A, Ctrl+C)');
    e.status = 502;
    throw e;
  }

  globalThis.KadItems = { itemsToText, chooseText, ruDate };
})();
