/*
 * Отслеживаемые споры: хранение, сводка, проверка карточки, новые документы.
 * Один код для сайта (хранилище — IndexedDB этого браузера) и расширения
 * (chrome.storage). Чем загружать карточку и тексты определений, передаёт
 * тот, кто создаёт: сайт — через закладку на странице картотеки, расширение —
 * сам.
 *
 * Хранилище — ключ → значение: ids (порядок споров), d:<id> (спор), settings.
 */
(function () {
  const { KadCard: C, KadDispute: X } = globalThis;

  /* Поля, которые ведёт проверка: страница их не присылает и не затирает. */
  const KEEP = ['createdAt', 'checkedAt', 'error', 'note', 'notified'];
  const DEFAULTS = { checkHours: 4, notify: true, pdfTexts: true };
  const KAD_CARD = /^https?:\/\/(?:www\.)?kad\.arbitr\.ru\/Card\/[0-9a-f-]{36}/i;

  const isAct = (e) => !e.rec.synthetic && /^(?:ruling|decision|appealRuling|protocol|courtDoc)$/.test(e.cls.nature || '');
  const newId = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');

  /* Разбор тем же кодом, что на странице. */
  function analyze(st) {
    const card = st.card && st.card.raw
      ? C.parse(st.card.raw, { html: st.card.html })
      : { meta: {}, records: [], diagnostics: {} };
    const d = X.build(card, {
      filedDate: st.filed, applicant: st.applicant, role: st.role, hearing: st.hearing, subject: st.subject,
      texts: st.texts || {}, rootId: st.rootId, include: st.include, exclude: st.exclude, known: st.known
    });
    return { card, d, summary: { ...X.summary(d), debtor: card.meta.debtor || '' } };
  }

  /**
   * store — { get(key), set(key, value), remove(key) }, всё асинхронно;
   * card(url) → { text, note, at, source }; pdf(url) → текст определения.
   */
  function create({ store, card, pdf }) {
    const ids = async () => { const v = await store.get('ids'); return Array.isArray(v) ? v : []; };
    const load = async (id) => (await store.get(`d:${id}`)) || null;

    async function put(st) {
      await store.set(`d:${st.id}`, st);
      const list = await ids();
      if (!list.includes(st.id)) await store.set('ids', [...list, st.id]);
    }

    async function remove(id) {
      await store.remove(`d:${id}`);
      await store.set('ids', (await ids()).filter((x) => x !== id));
    }

    async function settings(patch) {
      const s = { ...DEFAULTS, ...((await store.get('settings')) || {}) };
      if (!patch) return s;
      const next = { ...s, ...patch };
      await store.set('settings', next);
      return next;
    }

    async function save(state) {
      const prev = state.id ? await load(state.id) : null;
      const st = { ...state, app: 'kadmonitoring' };
      delete st.summary;
      for (const k of KEEP) {
        if (prev && prev[k] !== undefined) st[k] = prev[k];
        else delete st[k];
      }
      const now = new Date().toISOString();
      st.id = prev ? prev.id : (state.id || newId());
      st.createdAt = st.createdAt || now;
      st.savedAt = now;
      // То, что видно при постановке на отслеживание, новым не считается.
      if (!prev) st.notified = [...(st.known || [])];
      st.summary = analyze(st).summary;
      await put(st);
      return st.id;
    }

    async function list() {
      const out = [];
      for (const id of await ids()) {
        const st = await load(id);
        if (!st) continue;
        let summary;
        // Сводка пересчитывается: «осталось N дней» и «истёк срок» зависят от сегодняшней даты.
        try { summary = analyze(st).summary; } catch (e) { summary = { stageLabel: 'ошибка разбора', tone: 'bad' }; }
        out.push({
          id, filed: st.filed, url: st.url, error: st.error || null, savedAt: st.savedAt || null,
          checkedAt: st.checkedAt || (st.card && st.card.source === 'kad.arbitr' && st.card.at) || null,
          summary
        });
      }
      return out.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
    }

    /*
     * Проверка: свежая карточка, тексты новых определений, новые документы.
     * → { st, a, fresh } — fresh: события, о которых ещё не сообщали.
     */
    async function check(id) {
      const st = await load(id);
      if (!st) throw new Error('нет такого спора');
      if (!KAD_CARD.test(st.url || '')) throw new Error('у спора нет ссылки на карточку kad.arbitr');
      const s = await settings();
      try {
        const got = await card(st.url);
        const c = { raw: got.text, html: false, source: got.source || 'kad.arbitr', at: got.at };
        const texts = { ...(st.texts || {}) };
        if (s.pdfTexts && pdf) {
          const a0 = analyze({ ...st, card: c, texts });
          const todo = a0.d.events.filter((e) => isAct(e) && e.rec.pdf && !texts[e.rec.id]).slice(-6);
          for (const e of todo) {
            try { const t = await pdf(e.rec.pdf); if (t) texts[e.rec.id] = t; } catch (_) { /* следующий */ }
          }
        }
        // Пока шла проверка, страница могла сохранить правки — берём свежую копию.
        const cur = (await load(id)) || st;
        cur.card = c;
        cur.texts = { ...texts, ...(cur.texts || {}) };
        cur.checkedAt = new Date().toISOString();
        cur.error = null;
        cur.note = got.note;
        const a = analyze(cur);
        const fresh = a.d.events.filter((e) => e.isNew && !(cur.notified || []).includes(e.rec.id));
        if (fresh.length) cur.notified = [...(cur.notified || []), ...fresh.map((e) => e.rec.id)].slice(-500);
        cur.summary = a.summary;
        await put(cur);
        return { st: cur, a, fresh };
      } catch (err) {
        const cur = (await load(id)) || st;
        cur.checkedAt = new Date().toISOString();
        cur.error = String((err && err.message) || err).slice(0, 300);
        await put(cur);
        throw err;
      }
    }

    /* Споры с новыми документами — для значка и заголовка вкладки. */
    async function withNew() {
      let n = 0;
      for (const id of await ids()) {
        const st = await load(id);
        if (st && st.summary && st.summary.newEvents) n++;
      }
      return n;
    }

    return { ids, load, put, remove, settings, save, list, check, withNew, analyze };
  }

  globalThis.KadTracker = { create, analyze, isAct, DEFAULTS };
})();
