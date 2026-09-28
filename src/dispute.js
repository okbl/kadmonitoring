/*
 * Выделение обособленного спора из карточки дела и сборка его движения.
 * Наружу — globalThis.KadDispute.
 *
 * В карточке банкротного дела сотни документов: требования кредиторов,
 * отчёты, жалобы, другие оспаривания. К нашему спору относятся те, у
 * которых в поле «В ответ на» стоит наше заявление. Сцепление
 * транзитивное: документ может отвечать не самому заявлению, а
 * промежуточному определению по нему.
 *
 * Документы без «В ответ на» не приписываются к спору молча. Они уходят
 * в отдельный список «возможно относится» с указанием причины — программа
 * не имеет права выдать догадку за факт, когда от этого зависят сроки.
 * Последнее слово за пользователем: документ можно включить в спор или
 * исключить из него вручную, и это сохраняется вместе со спором.
 */
(function () {
  'use strict';

  const norm = (s) => globalThis.KadCard.norm(s);
  const WORD = /[^a-zа-яё0-9]+/;

  /* Слова, по которым нельзя опознать документ: они есть почти в каждом. */
  const STOP = new Set(['заявление', 'заявлению', 'заявления', 'определение', 'определению', 'определения',
    'о', 'об', 'по', 'на', 'в', 'и', 'к', 'с', 'от', 'дело', 'делу', 'суда', 'суд',
    'арбитражного', 'производству', 'производства', 'рассмотрении', 'рассмотрение', 'рассмотрения']);

  const tokens = (s) => norm(s).split(WORD).filter((w) => w.length > 3 && !STOP.has(w));

  /*
   * Слова, не отличающие одну организацию от другой. Сравнивать приходится
   * по словам, а не регулярным выражением с \b: для \b кириллица не буква.
   */
  const PARTY_STOP = new Set(['ооо', 'оао', 'зао', 'пао', 'ао', 'нао', 'ип', 'гуп', 'муп', 'ано', 'нко',
    'банк', 'россии', 'российской', 'федерации', 'город', 'общество', 'ограниченной', 'ответственностью',
    'акционерное', 'публичное', 'непубличное', 'компания', 'группа']);

  /** Ядро названия организации или ФИО — для сверки участников. */
  function partyKey(s) {
    const t = norm(s).split(WORD)
      .filter((w) => w.length > 3 && !PARTY_STOP.has(w))
      .sort((a, b) => b.length - a.length);
    return t[0] || '';
  }

  /* Первое слово — тип документа: «Определение от …», «Заявление от …». */
  const typeOf = (s) => (norm(s).match(/^([а-я]{5,})/) || ['', ''])[1].slice(0, 7);

  /**
   * Указывает ли «В ответ на» записи r на запись rec.
   * Возвращает { confidence, reasons, strength } или null.
   * exact — сошлись дата и название либо участник; likely — что-то одно.
   */
  function pointsTo(r, rec, sameDateCount) {
    const D = globalThis.KadDates;
    if (r.responseToId && rec.docId) {
      return r.responseToId === rec.docId
        ? { confidence: 'exact', reasons: ['ссылка на документ картотеки'], strength: 9 }
        : null;
    }
    const ref = norm(r.responseTo);
    if (!ref) return null;

    // «В ответ на Определение от …» не может указывать на заявление.
    const rt = typeOf(ref);
    const tt0 = typeOf(rec.title);
    if (rt && tt0 && rt !== tt0 && /^(?:определ|заявле|ходата|жалоба|апелля|кассац|постан|решени|отзыв)/.test(rt)) return null;

    // «В ответ на Заявление О включении в реестр от (23.06.2026)» — предмет
    // назван, и он не наш: одной даты и заявителя мало, у банка в один день
    // бывает несколько заявлений.
    const refSubject = (ref.match(/^[а-я]+\s+((?:о|об)\s.+?)\s+от\s/) || ['', ''])[1];
    const recWords = tokens(globalThis.KadCard.title(rec));
    if (refSubject && recWords.length && rec.content) {
      const sw = tokens(refSubject);
      if (sw.length && !sw.some((w) => recWords.some((x) => x.slice(0, 6) === w.slice(0, 6)))) return null;
    }

    const refDate = D.find(r.responseTo);
    const dateMatch = !!refDate && refDate === rec.date;

    const tt = tokens(globalThis.KadCard.title(rec));
    const hit = tt.filter((w) => ref.includes(w)).length;
    const titleMatch = tt.length ? hit / tt.length >= 0.6 : false;

    const pk = partyKey(rec.from || rec.applicant || '');
    const partyMatch = pk ? ref.includes(pk) : false;

    const reasons = [];
    if (dateMatch) reasons.push(`дата ${D.fmt(rec.date)}`);
    if (titleMatch) reasons.push('название документа');
    if (partyMatch) reasons.push('участник');
    const strength = (dateMatch ? 2 : 0) + (titleMatch ? 1 : 0) + (partyMatch ? 1 : 0);

    // Дата расходится явно — это ответ на другой документ, даже если
    // название похоже: заявлений «о признании сделки недействительной» в
    // банкротном деле бывает десяток.
    if (refDate && !dateMatch) return null;

    if (dateMatch && (titleMatch || partyMatch)) return { confidence: 'exact', reasons, strength };
    // Дата без названия годится, только если на эту дату запись одна:
    // иначе «в ответ на заявление от 23.06.2026» указывает неизвестно на что.
    if (dateMatch && sameDateCount === 1) return { confidence: 'exact', reasons, strength };
    if (titleMatch && partyMatch) return { confidence: 'likely', reasons, strength };
    if (dateMatch) return { confidence: 'likely', reasons, strength };
    return null;
  }

  /**
   * Корневое заявление спора. Ищется по дате подачи, которую ввёл
   * пользователь; допуск в несколько дней — потому что датой подачи считают
   * и дату отправки, а карточка показывает дату регистрации судом.
   */
  function rootCandidates(records, spec) {
    const R = globalThis.KadRules;
    const D = globalThis.KadDates;
    const filed = spec.filedDate;
    const wanted = partyKey(spec.applicant || '');

    return records.map((r) => {
      const cls = R.classify(r);
      // Судебный акт или ответ стороны заявлением спора быть не может, даже
      // если датирован днём подачи: «Перерыв в заседании» от 23.06 — не корень.
      if (/^(?:ruling|decision|appealRuling|protocol|response|motion|complaint)$/.test(cls.nature || '')) return null;
      let score = 0;
      const gap = filed ? D.diff(filed, r.date) : 99;
      const agap = Math.abs(gap);
      // Дальше двух недель от даты подачи — другое заявление, даже того же лица.
      if (filed && agap > 14) return null;
      if (agap === 0) score += 100;
      else if (agap <= 3) score += 70 - agap * 5;
      else if (agap <= 14) score += 20 - agap;
      // Раньше даты подачи суд зарегистрировать заявление не мог.
      if (gap < -3) score -= 30;
      if (cls.kind === 'application') score += 40;
      else if (cls.nature === 'application') score += 20;
      else score -= 40;
      if (/недействительн|оспаривани|сделк/.test(norm(globalThis.KadCard.title(r) + ' ' + r.extra.join(' ')))) score += 25;
      if (wanted && partyKey(r.from || r.applicant || '') === wanted) score += 25;
      return { r, cls, score, gap };
    }).filter((x) => x && x.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  function findRoot(records, spec) {
    if (spec.rootId) {
      const r = records.find((x) => x.id === spec.rootId);
      if (r) return { r, cls: globalThis.KadRules.classify(r), score: 999, manual: true };
    }
    const c = rootCandidates(records, spec);
    return c.length ? c[0] : null;
  }

  /**
   * Заявитель по ссылкам «В ответ на Заявление (дата подачи) от …». Если
   * на эту дату ссылаются заявления разных лиц, выбирается указанное
   * пользователем, иначе — то, на которое ссылаются чаще.
   */
  function inferRoot(records, spec) {
    const D = globalThis.KadDates;
    const groups = new Map();
    for (const r of records) {
      const ref = String(r.responseTo || '');
      if (typeOf(ref) !== typeOf('Заявление') || D.find(ref) !== spec.filedDate) continue;
      const m = ref.match(/\d{4}\)?\s*от\s+(.+)$/i);
      if (!m) continue;
      const from = m[1].replace(/[,;]\s*$/, '').trim();
      const key = partyKey(from);
      if (!key) continue;
      const g = groups.get(key) || { from, n: 0, ids: new Map() };
      g.n++;
      if (r.responseToId) g.ids.set(r.responseToId, (g.ids.get(r.responseToId) || 0) + 1);
      groups.set(key, g);
    }
    if (!groups.size) return null;
    const wanted = partyKey(spec.applicant || '');
    const g = wanted && groups.has(wanted) ? groups.get(wanted) : [...groups.values()].sort((a, b) => b.n - a.n)[0];
    // Картотека даёт и идентификатор документа, на который отвечают, — им
    // корень и опознаётся, даже если самого заявления в хронологии нет.
    const docId = [...g.ids.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0])[0] || null;
    return { from: g.from, n: g.n, docId, rivals: groups.size - 1 };
  }

  /** Признаки предмета спора — по корневому заявлению. */
  function subjectKeys(root, spec) {
    const keys = new Set(tokens(root ? globalThis.KadCard.title(root) : '')
      .filter((w) => /недействительн|оспаривани|сделк|договор|плат|перечислен|дарени|купл|прода|займ|залог|зачет|цесси|уступк/.test(w)));
    for (const w of tokens(spec.subject || '')) keys.add(w);
    const pk = partyKey((root && (root.from || root.applicant)) || spec.applicant || '');
    return { words: [...keys], party: pk };
  }

  const byEventOrder = (a, b) => a.rec.date < b.rec.date ? -1 : a.rec.date > b.rec.date ? 1 : (a.rec.line || 0) - (b.rec.line || 0);

  /**
   * Собирает спор: корень, достоверно связанные документы и отдельно —
   * возможно связанные.
   *
   * spec: filedDate, applicant, role, hearing, subject — ввод пользователя;
   *   texts {id: текст определения}; rootId, include [id], exclude [id] —
   *   ручные исправления; known [id] — события, которые пользователь уже
   *   видел (остальные помечаются как новые).
   */
  function build(card, spec) {
    const R = globalThis.KadRules;
    const D = globalThis.KadDates;
    const records = card.records || [];
    const s = spec || {};
    const exclude = new Set(s.exclude || []);
    const include = new Set(s.include || []);

    const byDate = new Map();
    for (const r of records) byDate.set(r.date, (byDate.get(r.date) || 0) + 1);

    let rootHit = findRoot(records, s);
    // Ссылки «В ответ на Заявление (дата подачи) от …» точнее догадки по дате:
    // если они указывают на другой документ, корень — тот, на который ссылаются.
    const refRoot = s.filedDate ? inferRoot(records, s) : null;
    if (rootHit && !rootHit.manual && refRoot) {
      if (refRoot.docId && rootHit.r.docId !== refRoot.docId) {
        const byId = records.find((r) => r.docId === refRoot.docId);
        rootHit = byId ? { r: byId, cls: R.classify(byId), score: 500 } : null;
      } else if (!refRoot.docId && (rootHit.cls.kind !== 'application' || rootHit.r.date !== s.filedDate ||
          partyKey(rootHit.r.from || rootHit.r.applicant || '') !== partyKey(refRoot.from))) {
        // Ссылаются на заявление от даты подачи, а найдено заявление другого
        // дня или другого лица — это не оно.
        rootHit = null;
      }
    }
    const root = rootHit ? rootHit.r : null;

    // Заявления в карточке может не быть: публикация отстаёт, а в хронологии
    // картотеки входящие документы бывают не все. Но дату подачи пользователь
    // знает, а другие документы на заявление ссылаются: «В ответ на
    // Заявление (23.06.2026) от ПАО "СБЕРБАНК РОССИИ"». По этим ссылкам
    // восстанавливается и заявитель.
    const inferred = !root ? refRoot : null;
    const syntheticRoot = !root && s.filedDate ? {
      date: s.filedDate,
      title: 'Заявление',
      content: s.subject || (inferred ? '' : 'об оспаривании сделки должника'),
      from: s.applicant || (inferred && inferred.from) || '',
      synthetic: true,
      inferred: !!inferred,
      docId: (inferred && inferred.docId) || undefined,
      extra: [],
      id: (inferred && inferred.docId) || 'synthetic-root',
      instance: 'Первая инстанция'
    } : null;

    const member = new Map();          // id → {rec, confidence, reasons, via}
    const rootRec = root || syntheticRoot;
    if (rootRec) member.set(rootRec.id, { rec: rootRec, confidence: 'root', reasons: [rootHit && rootHit.manual ? 'выбрано вручную' : 'корневое заявление'], via: null });

    // Транзитивное сцепление по «В ответ на»: каждой записи — лучшее из
    // совпадений с уже собранными документами спора.
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of records) {
        if (member.has(r.id) || exclude.has(r.id) || !(r.responseTo || r.responseToId)) continue;
        let best = null;
        for (const m of member.values()) {
          const hit = pointsTo(r, m.rec, byDate.get(m.rec.date) || 1);
          if (hit && (!best || hit.strength > best.hit.strength)) best = { hit, m };
        }
        if (!best) continue;
        let { confidence, reasons } = best.hit;
        // Тот же ответ подходит и к чужому документу. Подходит к нему лучше —
        // это движение другого спора; так же хорошо — связь не достоверна.
        if (best.hit.strength < 9) {
          let rival = null;
          for (const x of records) {
            if (x === best.m.rec || member.has(x.id) || x.id === r.id || x.date !== best.m.rec.date) continue;
            const h = pointsTo(r, x, 1);
            if (h && (!rival || h.strength > rival.h.strength)) rival = { x, h };
          }
          if (rival && rival.h.strength > best.hit.strength) continue;
          if (rival && rival.h.strength === best.hit.strength) {
            confidence = 'likely';
            reasons = [...reasons, `подходит и к другому документу: ${globalThis.KadCard.title(rival.x).slice(0, 80)}`];
          }
        }
        member.set(r.id, { rec: r, confidence, reasons, via: best.m.rec.id });
        grew = true;
      }
    }

    for (const id of include) {
      const r = records.find((x) => x.id === id);
      if (r && !member.has(id)) member.set(id, { rec: r, confidence: 'manual', reasons: ['включено вручную'], via: null });
    }

    // Возможно относится: без действующей «В ответ на», но по предмету похоже.
    const keys = subjectKeys(rootRec, s);
    const maybe = [];
    for (const r of records) {
      if (member.has(r.id) || (rootRec && r.id === rootRec.id)) continue;
      if (!rootRec || r.date < rootRec.date) continue;
      const t = norm(globalThis.KadCard.title(r) + ' ' + r.extra.join(' '));
      if (!keys.words.some((w) => t.includes(w))) continue;
      // Отвечает документу, который в карточке есть, но к спору не относится, —
      // значит, это движение другого спора.
      if ((r.responseTo || r.responseToId) && records.some((x) => x !== r && !member.has(x.id) && pointsTo(r, x, byDate.get(x.date) || 1))) continue;
      const why = ['предмет спора в названии'];
      if (keys.party && partyKey(r.from || r.applicant || '') === keys.party) why.push('тот же участник');
      if (r.responseTo) why.push('«в ответ на» не указывает ни на один документ спора');
      else why.push('нет поля «В ответ на»');
      if (exclude.has(r.id)) why.unshift('исключено вручную');
      maybe.push({ rec: r, cls: R.classify(r), reasons: why, excluded: exclude.has(r.id) });
    }

    /* ---------- движение ---------- */

    const known = s.known ? new Set(s.known) : null;
    const events = [...member.values()]
      .sort(byEventOrder)
      .map((m) => {
        const text = s.texts && s.texts[m.rec.id];
        const ruling = text ? R.parseRuling(text) : null;
        // Название в карточке бывает обрезано до «Определение» — тогда тип
        // берётся из резолютивной части вставленного текста.
        const cls = R.classify(m.rec, ruling && ruling.hasResolution ? ruling.resolution : null);
        let stage = cls.stage || null;
        // «Заявление» в середине спора — уточнение или повторная подача, а не начало.
        if (stage === 'filed' && m.confidence !== 'root') stage = null;
        return { ...m, cls, stage, ruling, isNew: !!known && !known.has(m.rec.id) };
      });

    // Роль управляющего: заявитель он или участник. Определяется по корню,
    // с возможностью задать вручную — в карточке заявитель бывает не указан.
    const rootFrom = norm(rootRec
      ? (rootRec.from || rootRec.applicant ||
         (rootRec.extra || []).find((l) => /управляющ/i.test(l)) || '')
      : s.applicant || '');
    const role = s.role || (/управляющ/.test(rootFrom) ? 'applicant' : (rootFrom ? 'participant' : 'unknown'));

    // Текущая стадия — последнее событие, которое её меняет.
    let stage = null, stageEvent = null;
    for (const e of events) if (e.stage) { stage = e.stage; stageEvent = e; }
    if (!stage && rootRec) { stage = 'filed'; stageEvent = events[0] || null; }

    // Ближайшее заседание: вручную > текст определения > строка карточки
    // «Дата и время судебного заседания». Из событий берётся последнее.
    let hearing = null;
    for (const e of events) {
      if (e.ruling && e.ruling.hearing) hearing = { ...e.ruling.hearing, source: `текст определения от ${D.fmt(e.rec.date)}` };
      else if (e.rec.hearing) hearing = { ...e.rec.hearing, source: `карточка, запись от ${D.fmt(e.rec.date)}` };
    }
    if (s.hearing) hearing = { date: s.hearing, time: '', source: 'указано вручную' };

    const tasks = buildTasks(events, { role, hearing, stage });

    return {
      root: rootRec,
      rootFound: !!root,
      rootManual: !!(rootHit && rootHit.manual),
      candidates: rootCandidates(records, s).slice(0, 6).map((x) => ({ id: x.r.id, date: x.r.date, title: globalThis.KadCard.title(x.r), from: x.r.from || '', score: x.score })),
      role,
      stage,
      stageEvent,
      hearing,
      events,
      maybe,
      tasks,
      caseMeta: card.meta,
      unrelated: records.length - member.size - maybe.length
    };
  }

  /**
   * Что требуется от управляющего. Берутся требования последнего события,
   * меняющего стадию, плюс незакрытые сроки более ранних событий: суд может
   * истребовать документы и потом отложить заседание — обязанность
   * представить документы от этого не исчезает.
   */
  function buildTasks(events, ctx) {
    const R = globalThis.KadRules;
    const D = globalThis.KadDates;
    const out = [];
    const seen = new Set();

    /*
     * Какие события ещё «живые». Отложение заседания не отменяет обязанность
     * представить отзыв и документы, возникшую при принятии заявления, —
     * поэтому берётся не последнее событие, а всё от опорного:
     *   спор завершён (отказ, удовлетворение, прекращение) → от него,
     *   спор рассматривается                                → от принятия,
     *   иначе                                               → от последней стадии.
     */
    const TERMINAL = new Set(['decided', 'granted', 'partly', 'denied', 'terminated', 'unconsidered', 'returned', 'refused',
      'appeal', 'appealDone', 'cassation', 'cassationDone']);
    let anchor = 0;
    let lastStage = 0;
    let lastAccepted = -1;
    let lastTerminal = -1;
    events.forEach((e, i) => {
      if (!e.stage) return;
      lastStage = i;
      if (e.stage === 'accepted') lastAccepted = i;
      if (TERMINAL.has(e.stage)) lastTerminal = i;
    });
    if (lastTerminal >= 0) anchor = lastTerminal;
    else if (lastAccepted >= 0) anchor = lastAccepted;
    else anchor = lastStage;

    const relevant = events.slice(anchor);
    const role = ctx.role === 'unknown' ? 'participant' : ctx.role;

    const fromDays = (e, days, calendar) => calendar
      ? { date: D.nextWorkday(D.shift(e.rec.date, days)), approximate: false }
      : D.addWorkdays(e.rec.date, days);

    for (const e of relevant) {
      const src = { id: e.rec.id, date: e.rec.date, title: e.cls.doc };
      for (const req of R.requirements(e.cls.kind, role)) {
        const key = req.what.slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);

        let due = null;
        let dueNote = '';
        if (req.due && req.due.kind === 'inRuling') {
          const fromText = e.ruling && e.ruling.deadlines.length ? e.ruling.deadlines[0] : null;
          if (fromText && fromText.date) {
            due = { date: fromText.date, text: 'срок из текста определения', norm: req.norm, quote: fromText.quote };
          } else if (fromText && fromText.days) {
            const r = fromDays(e, fromText.days, fromText.calendar);
            due = { date: r.date, approximate: r.approximate,
              text: `${fromText.days} ${fromText.calendar ? 'календарных' : 'рабочих'} дн. по тексту определения`,
              norm: req.norm, quote: fromText.quote };
          } else if (ctx.hearing && ctx.hearing.date >= e.rec.date) {
            due = { date: ctx.hearing.date, text: 'не позднее заседания — точный срок в тексте определения', norm: req.norm };
            dueNote = 'срок установлен судом в тексте определения — загрузите или вставьте текст, чтобы дата попала в расчёт';
          } else {
            dueNote = 'срок установлен судом в тексте определения — загрузите или вставьте текст, чтобы дата попала в расчёт';
          }
        } else if (req.due && req.due.kind === 'beforeHearing') {
          if (ctx.hearing && ctx.hearing.date >= e.rec.date) due = { date: ctx.hearing.date, text: 'к судебному заседанию', norm: req.norm };
          else dueNote = 'дата заседания неизвестна — укажите её или загрузите текст определения';
        } else if (req.due) {
          due = R.deadline(req.due, e.rec.date);
          // Картотека сама считает срок обжалования акта. Если её срок позже
          // десяти дней по ч. 3 ст. 223 АПК, показываем оба: ранний — как срок.
          if (req.due === R.APPEAL_10 && e.rec.appealUntil && due && e.rec.appealUntil !== due.date) {
            dueNote = `Картотека указывает срок обжалования до ${D.fmt(e.rec.appealUntil)}. ` +
              (e.rec.appealUntil > due.date
                ? `Здесь показан более ранний срок — десять рабочих дней по ч. 3 ст. 223 АПК РФ; какой срок применим к этому определению, проверьте по его тексту («может быть обжаловано в течение…»).`
                : 'Проверьте срок по тексту определения.');
          }
        }

        out.push({ what: req.what, norm: req.norm, due, dueNote, from: src, done: doneBy(req, e, events, ctx.role) });
      }

      // Прямые поручения из текста определения: они точнее любого правила.
      if (e.ruling) {
        for (const d of e.ruling.demands) {
          // Поручение «заявителю» — это поручение управляющему только тогда,
          // когда заявление подавал он сам.
          const mine = d.toFinancialManager || d.toAll || (ctx.role === 'applicant' && d.toApplicant);
          if (!mine) continue;
          const key = 'text:' + d.text.slice(0, 60);
          if (seen.has(key)) continue;
          seen.add(key);
          let due = null;
          if (d.date) due = { date: d.date, text: 'срок из этой же фразы' };
          else if (d.days) {
            const r = fromDays(e, d.days, d.calendar);
            due = { date: r.date, approximate: r.approximate, text: `${d.days} ${d.calendar ? 'календарных' : 'рабочих'} дн. из этой же фразы` };
          } else if (ctx.hearing && ctx.hearing.date >= e.rec.date) due = { date: ctx.hearing.date, text: 'к судебному заседанию' };
          out.push({ what: d.text, norm: 'поручение суда', fromText: true, due, dueNote: '', from: src });
        }
      }
    }

    // Сначала то, у чего срок ближе; без срока и выполненное — в конец.
    return out.sort((a, b) => {
      if (!!a.done !== !!b.done) return a.done ? 1 : -1;
      const ad = a.due && a.due.date, bd = b.due && b.due.date;
      if (ad && bd) return ad < bd ? -1 : ad > bd ? 1 : 0;
      return ad ? -1 : bd ? 1 : 0;
    });
  }

  /**
   * Похоже ли, что требование уже исполнено: после события в споре есть
   * документ нужного вида от управляющего (или, если заявитель он, — от
   * него же). Это подсказка, а не отметка о выполнении: отзыв мог быть
   * подан по другому вопросу, поэтому в интерфейсе он показан как «похоже».
   */
  function doneBy(req, e, events, role) {
    if (!req.doneBy) return null;
    const mine = (x) => /управляющ/i.test(x.rec.from || '') || (role === 'applicant' && x.confidence !== 'root' && !/^(?:ruling|decision|appealRuling|protocol|courtDoc)$/.test(x.cls.nature || ''));
    const hit = events.find((x) => x.rec.date >= e.rec.date && x !== e && req.doneBy.includes(x.cls.kind) && mine(x));
    return hit ? { date: hit.rec.date, doc: globalThis.KadCard.title(hit.rec) } : null;
  }

  /**
   * Короткая сводка для списка споров и для сервера: стадия, ближайший срок,
   * новые события. Считается тем же кодом, что и страница спора.
   */
  function summary(d) {
    const R = globalThis.KadRules;
    const today = globalThis.KadDates.today();
    const open = d.tasks.filter((t) => !t.done);
    const next = open.find((t) => t.due && t.due.date >= today) || null;
    const late = open.filter((t) => t.due && t.due.date < today).length;
    return {
      stage: d.stage,
      stageLabel: d.stage ? R.STAGES[d.stage].label : 'Нет данных',
      tone: d.stage ? R.STAGES[d.stage].tone : 'neutral',
      lastEvent: d.stageEvent ? { date: d.stageEvent.rec.date, doc: d.stageEvent.cls.doc } : null,
      hearing: d.hearing,
      nextDue: next ? { date: next.due.date, what: next.what.slice(0, 140) } : null,
      overdue: late,
      events: d.events.length,
      newEvents: d.events.filter((e) => e.isNew).length,
      caseNo: d.caseMeta && d.caseMeta.caseNo || ''
    };
  }

  globalThis.KadDispute = { build, summary, pointsTo, findRoot, rootCandidates, tokens, partyKey };
})();
