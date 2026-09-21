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
 */
(function () {
  'use strict';

  const N = () => globalThis.KadCard.norm;

  /* Слова, по которым нельзя опознать документ: они есть почти в каждом. */
  const STOP = new Set(['заявление', 'заявлению', 'заявления', 'определение', 'определению',
    'о', 'об', 'по', 'на', 'в', 'и', 'к', 'с', 'от', 'дело', 'делу', 'суда', 'суд',
    'арбитражного', 'производству', 'производства', 'рассмотрении', 'рассмотрение']);

  const tokens = (s) => globalThis.KadCard.norm(s)
    .split(/[^a-zа-яё0-9]+/)
    .filter((w) => w.length > 3 && !STOP.has(w));

  /** Ядро названия организации или ФИО — для сверки участников. */
  function partyKey(s) {
    const t = globalThis.KadCard.norm(s)
      .replace(/\b(ооо|оао|зао|пао|ао|нао|ип|гуп|муп|ано|нко|банк|россии|российской|федерации|г|город)\b/g, ' ')
      .split(/[^a-zа-яё0-9]+/)
      .filter((w) => w.length > 3)
      .sort((a, b) => b.length - a.length);
    return t[0] || '';
  }

  /**
   * Указывает ли «В ответ на» на эту запись.
   * exact — сошлись дата и название; likely — что-то одно, но однозначно.
   */
  function pointsTo(responseTo, rec, sameDateCount) {
    const D = globalThis.KadDates;
    const ref = globalThis.KadCard.norm(responseTo);
    if (!ref) return null;

    const refDate = D.find(responseTo);
    const dateMatch = refDate && refDate === rec.date;

    const tt = tokens(rec.title);
    const hit = tt.filter((w) => ref.includes(w)).length;
    const titleMatch = tt.length ? hit / tt.length >= 0.6 : false;

    const pk = partyKey(rec.from || rec.applicant || '');
    const partyMatch = pk ? ref.includes(pk) : false;

    const reasons = [];
    if (dateMatch) reasons.push(`дата ${D.fmt(rec.date)}`);
    if (titleMatch) reasons.push('название документа');
    if (partyMatch) reasons.push('участник');

    if (dateMatch && titleMatch) return { confidence: 'exact', reasons };
    if (dateMatch && partyMatch) return { confidence: 'exact', reasons };
    // Дата без названия годится, только если на эту дату запись одна:
    // иначе «в ответ на заявление от 23.06.2026» указывает неизвестно на что.
    if (dateMatch && sameDateCount === 1) return { confidence: 'exact', reasons };
    if (titleMatch && partyMatch) return { confidence: 'likely', reasons };
    if (dateMatch) return { confidence: 'likely', reasons };
    return null;
  }

  /**
   * Корневое заявление спора. Ищется по дате подачи, которую ввёл
   * пользователь; допуск в несколько дней — потому что датой подачи считают
   * и дату отправки, а карточка показывает дату регистрации судом.
   */
  function findRoot(records, spec) {
    const R = globalThis.KadRules;
    const D = globalThis.KadDates;
    const filed = spec.filedDate;
    const wanted = partyKey(spec.applicant || '');

    const scored = records.map((r) => {
      const cls = R.classify(r);
      let score = 0;
      const gap = filed ? Math.abs(D.diff(filed, r.date)) : 99;
      if (gap === 0) score += 100; else if (gap <= 3) score += 70 - gap * 5;
      else if (gap <= 14) score += 20 - gap;
      if (cls.kind === 'application') score += 40;
      else if (cls.nature === 'application') score += 20;
      else score -= 40;
      if (/недействительн|оспаривани|сделк/.test(globalThis.KadCard.norm(r.title))) score += 25;
      if (wanted && partyKey(r.from || r.applicant || '') === wanted) score += 25;
      return { r, cls, score, gap };
    }).filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.length ? scored[0] : null;
  }

  /** Признаки предмета спора — по корневому заявлению. */
  function subjectKeys(root, spec) {
    const keys = new Set(tokens(root ? root.title : '').filter((w) => /недействительн|оспаривани|сделк|договор|плат|перечислен|дарени|купл|прода/.test(w)));
    for (const w of tokens(spec.subject || '')) keys.add(w);
    const pk = partyKey((root && (root.from || root.applicant)) || spec.applicant || '');
    return { words: [...keys], party: pk };
  }

  /**
   * Собирает спор: корень, достоверно связанные документы и отдельно —
   * возможно связанные.
   */
  function build(card, spec) {
    const R = globalThis.KadRules;
    const D = globalThis.KadDates;
    const records = card.records || [];
    const spec2 = spec || {};

    const byDate = new Map();
    for (const r of records) byDate.set(r.date, (byDate.get(r.date) || 0) + 1);

    const rootHit = findRoot(records, spec2);
    const root = rootHit ? rootHit.r : null;

    // Заявления в карточке может ещё не быть (публикация отстаёт), но дату
    // подачи пользователь знает. Тогда корень — синтетический.
    const syntheticRoot = !root && spec2.filedDate ? {
      date: spec2.filedDate,
      title: spec2.subject || 'Заявление об оспаривании сделки',
      from: spec2.applicant || '',
      synthetic: true,
      extra: [],
      id: 'synthetic-root',
      instance: 'Первая инстанция'
    } : null;

    const member = new Map();          // id → {rec, confidence, reasons, via}
    const rootRec = root || syntheticRoot;
    if (rootRec) member.set(rootRec.id, { rec: rootRec, confidence: 'root', reasons: ['корневое заявление'], via: null });

    // Транзитивное сцепление по «В ответ на».
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of records) {
        if (member.has(r.id) || !r.responseTo) continue;
        for (const m of member.values()) {
          const hit = pointsTo(r.responseTo, m.rec, byDate.get(m.rec.date) || 1);
          if (!hit) continue;
          member.set(r.id, { rec: r, confidence: hit.confidence, reasons: hit.reasons, via: m.rec.id });
          grew = true;
          break;
        }
      }
    }

    // Возможно относится: без «В ответ на», но по предмету и времени похоже.
    const keys = subjectKeys(rootRec, spec2);
    const maybe = [];
    for (const r of records) {
      if (member.has(r.id)) continue;
      if (!rootRec || r.date < rootRec.date) continue;
      const t = globalThis.KadCard.norm(r.title);
      const why = [];
      if (keys.words.some((w) => t.includes(w))) why.push('предмет спора в названии');
      if (keys.party && partyKey(r.from || r.applicant || '') === keys.party) why.push('тот же участник');
      if (r.responseTo) why.push('«в ответ на» указывает на другой документ');
      if (!why.length || (why.length === 1 && why[0].startsWith('«в ответ'))) continue;
      maybe.push({ rec: r, cls: R.classify(r), reasons: why });
    }

    /* ---------- движение ---------- */

    const events = [...member.values()]
      .sort((a, b) => a.rec.date < b.rec.date ? -1 : a.rec.date > b.rec.date ? 1 : (a.rec.line || 0) - (b.rec.line || 0))
      .map((m) => {
        const cls = R.classify(m.rec);
        const ruling = spec2.texts && spec2.texts[m.rec.id] ? R.parseRuling(spec2.texts[m.rec.id]) : null;
        // Название в карточке бывает обрезано до «Определение» — тогда тип
        // берётся из резолютивной части вставленного текста.
        const kind = (cls.kind === 'ruling' && ruling && ruling.kindHint) ? ruling.kindHint : cls.kind;
        const stageFromHint = kind !== cls.kind
          ? (R.RULING_KINDS.find((k) => k.kind === kind) || {}).stage
          : cls.stage;
        return { ...m, cls: { ...cls, kind }, stage: stageFromHint || null, ruling };
      });

    // Роль управляющего: заявитель он или участник. Определяется по корню,
    // с возможностью задать вручную — в карточке заявитель бывает не указан.
    const rootFrom = globalThis.KadCard.norm(rootRec
      ? (rootRec.from || rootRec.applicant ||
         (rootRec.extra || []).find((l) => /управляющ/i.test(l)) || '')
      : '');
    const role = spec2.role || (/управляющ/.test(rootFrom) ? 'applicant' : (rootFrom ? 'participant' : 'unknown'));

    // Текущая стадия — последнее событие, которое её меняет.
    let stage = null, stageEvent = null;
    for (const e of events) if (e.stage) { stage = e.stage; stageEvent = e; }
    if (!stage && rootRec) { stage = 'filed'; stageEvent = events[0] || null; }

    // Ближайшее заседание: из текста определения либо задано вручную.
    let hearing = spec2.hearing ? { date: spec2.hearing, source: 'указано вручную' } : null;
    for (const e of events) {
      if (e.ruling && e.ruling.hearing) hearing = { ...e.ruling.hearing, source: `из текста от ${D.fmt(e.rec.date)}` };
    }

    const tasks = buildTasks(events, { role, hearing, stage });

    return {
      root: rootRec,
      rootFound: !!root,
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
    const TERMINAL = new Set(['granted', 'partly', 'denied', 'terminated', 'unconsidered', 'returned', 'refused']);
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

    for (const e of relevant) {
      for (const req of R.requirements(e.cls.kind, ctx.role === 'unknown' ? 'participant' : ctx.role)) {
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
            const r = fromText.calendar
              ? { date: D.nextWorkday(D.shift(e.rec.date, fromText.days)), approximate: false }
              : D.addWorkdays(e.rec.date, fromText.days);
            due = { date: r.date, approximate: r.approximate,
              text: `${fromText.days} ${fromText.calendar ? 'календарных' : 'рабочих'} дн. по тексту определения`,
              norm: req.norm, quote: fromText.quote };
          } else {
            dueNote = 'срок установлен судом в тексте определения — вставьте текст, чтобы дата попала в расчёт';
          }
        } else if (req.due && req.due.kind === 'beforeHearing') {
          if (ctx.hearing) due = { date: ctx.hearing.date, text: 'к судебному заседанию', norm: req.norm };
          else dueNote = 'дата заседания неизвестна — укажите её или вставьте текст определения';
        } else if (req.due) {
          due = R.deadline(req.due, e.rec.date);
        }

        out.push({ what: req.what, norm: req.norm, due, dueNote,
          from: { id: e.rec.id, date: e.rec.date, title: e.cls.doc } });
      }

      // Прямые поручения из текста определения: они точнее любого правила.
      if (e.ruling) {
        for (const d of e.ruling.demands) {
          // Поручение «заявителю» — это поручение управляющему только тогда,
          // когда заявление подавал он сам.
          const mine = d.toFinancialManager || (ctx.role === 'applicant' && d.toApplicant);
          if (!mine) continue;
          const key = 'text:' + d.text.slice(0, 60);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            what: d.text,
            norm: 'из текста определения',
            fromText: true,
            due: d.date ? { date: d.date, text: 'срок из этой же фразы' } : null,
            dueNote: d.date ? '' : '',
            from: { id: e.rec.id, date: e.rec.date, title: e.cls.doc }
          });
        }
      }
    }

    // Сначала то, у чего срок ближе; без срока — в конец.
    return out.sort((a, b) => {
      const ad = a.due && a.due.date, bd = b.due && b.due.date;
      if (ad && bd) return ad < bd ? -1 : ad > bd ? 1 : 0;
      return ad ? -1 : bd ? 1 : 0;
    });
  }

  globalThis.KadDispute = { build, pointsTo, findRoot, tokens, partyKey };
})();
