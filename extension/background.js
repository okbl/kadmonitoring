/*
 * Фоновая часть расширения «Обособленный спор». Отвечает только своей
 * странице и странице программы на её сайте.
 *
 * Всё хранится в этом браузере, в chrome.storage.local: список споров,
 * загруженные карточки, тексты определений, настройки. У каждого
 * пользователя свой список; никуда он не отправляется. Расширение обращается
 * только к kad.arbitr.ru: запрашивает карточку и её хронологию через API
 * картотеки — все страницы хронологии, все инстанции, — а если картотека
 * требует проверки, открывает карточку во вкладке, как открыл бы человек,
 * и забирает хронологию оттуда.
 *
 * Страница расширения (app.html) и та же страница на сайте программы шлют
 * сюда сообщения: загрузить карточку, текст определения, сохранить,
 * проверить спор. Здесь же — проверка по будильнику, уведомления о новых
 * документах и счётчик на значке.
 * Разбор и правила — те же модули, что на странице.
 */
import './config.js';
import './dates.js';
import './kad.js';
import './rules.js';
import './dispute.js';
import './kad-items.js';
import './pdf-text.js';
// pdf.js без отдельного потока: в фоновой части расширения нет Worker,
// а модуль обработчика, загруженный заранее, pdf.js находит сам.
import './pdf.worker.min.mjs';
import { getDocument } from './pdf.min.mjs';

const { KadCard: C, KadDispute: X, KadDates: D, KadItems: I, KadPdf: P } = globalThis;

const KAD = 'https://kad.arbitr.ru';
// Адрес картотеки подменяется только в тестовой сборке — на макет.
const BASE = (globalThis.KAD_CONFIG && globalThis.KAD_CONFIG.base) || KAD;
const toBase = (u) => BASE === KAD ? u : u.replace(/^https?:\/\/(?:www\.)?kad\.arbitr\.ru/i, BASE);
const KAD_CARD = new RegExp(`^https?://(?:www\\.)?kad\\.arbitr\\.ru/Card/(${C.GUID})`, 'i');
const KAD_PDF = /^https?:\/\/(?:www\.)?kad\.arbitr\.ru\/(?:Document\/Pdf|Kad\/PdfDocument)\//i;

const DEFAULTS = { checkHours: 4, notify: true, pdfTexts: true };
/* Поля, которые ведёт фоновая часть: страница их не присылает и не затирает. */
const KEEP = ['createdAt', 'checkedAt', 'error', 'note', 'notified'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = chrome.storage.local;
const isAct = (e) => !e.rec.synthetic && /^(?:ruling|decision|appealRuling|protocol|courtDoc)$/.test(e.cls.nature || '');

/* ---------- хранилище ---------- */

async function settings() {
  const { settings: s } = await store.get('settings');
  return { ...DEFAULTS, ...(s || {}) };
}

async function ids() {
  const { ids: list } = await store.get('ids');
  return Array.isArray(list) ? list : [];
}

async function load(id) {
  const k = `d:${id}`;
  return (await store.get(k))[k] || null;
}

async function put(st) {
  await store.set({ [`d:${st.id}`]: st });
  const list = await ids();
  if (!list.includes(st.id)) await store.set({ ids: [...list, st.id] });
}

async function drop(id) {
  await store.remove(`d:${id}`);
  await store.set({ ids: (await ids()).filter((x) => x !== id) });
}

const newId = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');

/* ---------- анализ тем же кодом, что на странице ---------- */

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

async function save(state) {
  const prev = state.id ? await load(state.id) : null;
  const st = { ...state, app: 'kadmonitoring' };
  delete st.summary;
  for (const k of KEEP) {
    if (prev && prev[k] !== undefined) st[k] = prev[k];
    else delete st[k];
  }
  const now = new Date().toISOString();
  st.id = prev ? prev.id : newId();
  st.createdAt = st.createdAt || now;
  st.savedAt = now;
  // То, что видно при постановке на отслеживание, новым не считается.
  if (!prev) st.notified = [...(st.known || [])];
  st.summary = analyze(st).summary;
  await put(st);
  await badge();
  return st.id;
}

async function listItems() {
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

/* ---------- карточка: вкладка картотеки и её API ---------- */

function tabLoaded(tabId, ms) {
  return new Promise((resolve) => {
    let timer = 0;
    const done = () => { chrome.tabs.onUpdated.removeListener(on); clearTimeout(timer); resolve(); };
    const on = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    timer = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') done(); }, done);
  });
}

async function inTab(tabId, func, args = [], ms = 30000) {
  const run = chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  const res = await Promise.race([run, sleep(ms).then(() => { throw new Error('страница картотеки не ответила вовремя'); })]);
  return res && res[0] ? res[0].result : null;
}

/* Инстанции дела в разметке карточки: скрытые поля js-instanceId. */
function instancesIn(html) {
  const ids = new Set();
  for (const m of html.matchAll(/<input\b[^>]*\bjs-instanceId\b[^>]*>/gi)) {
    const v = m[0].match(/\bvalue\s*=\s*["']([^"']+)["']/i);
    if (v) ids.add(v[1]);
  }
  return [...ids];
}

/*
 * Выполняется во вкладке картотеки: какие инстанции есть и не проверка ли
 * это. diag — для разбора неудач: устройство страницы без её содержания
 * (текст — только если это не карточка, то есть страница проверки).
 */
function pageState() {
  const ids = new Set();
  for (const i of document.querySelectorAll('input.js-instanceId')) if (i.value) ids.add(i.value);
  for (const e of document.querySelectorAll('.js-chrono-item-header[data-id], .b-chrono-item-header[data-id]')) ids.add(e.getAttribute('data-id'));
  const text = document.body ? document.body.innerText : '';
  const card = /[АA]\d{1,3}-\d{1,7}\/\d{4}/.test(text);
  return {
    instances: [...ids].filter(Boolean),
    wall: /робот|captcha|капч|проверк[а-яё]*\s+браузер|подозрительн/i.test(`${text.slice(0, 4000)} ${document.title}`),
    diag: {
      url: location.pathname.replace(/[0-9a-f-]{36}/gi, '<id>'),
      ready: document.readyState,
      visible: document.visibilityState,
      card,
      textLen: text.length,
      htmlLen: document.documentElement ? document.documentElement.outerHTML.length : 0,
      chrono: document.querySelectorAll('[class*="chrono"]').length,
      scripts: [...document.scripts].map((x) => x.src ? new URL(x.src).pathname : 'inline').slice(0, 15),
      sample: card ? '' : text.replace(/\s+/g, ' ').trim().slice(0, 300)
    }
  };
}

/*
 * Все страницы хронологии каждой инстанции — через тот же API, которым
 * пользуется сама карточка. Выполняется во вкладке картотеки (base пустой)
 * либо в фоновой части (base — адрес картотеки); во вкладке заодно отдаёт
 * текст страницы — на случай, если API ответит не так, как ожидается.
 */
async function collectInPage(caseId, instances, base = '') {
  const items = [];
  const pages = [];
  const fails = [];
  for (const id of instances) {
    let count = 0;
    for (let page = 1; page <= 200; page++) {
      const url = `${base}/Kad/InstanceDocumentsPage?_=${Date.now()}&id=${encodeURIComponent(id)}&caseId=${encodeURIComponent(caseId)}&perPage=30&page=${page}`;
      let j = null;
      let why = null;
      try {
        const r = await fetch(url, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01' } });
        const body = await r.text();
        try { j = JSON.parse(body); } catch (_) { j = null; }
        if (!(j && j.Result && j.Result.Items && j.Result.Items.length)) {
          // Ответ без записей: страница проверки или ошибка — содержания дела в нём нет.
          why = { status: r.status, type: r.headers.get('content-type'), len: body.length,
            sample: j && j.Result && j.Result.Items ? 'пустой список' : body.replace(/\s+/g, ' ').slice(0, 160) };
        }
      } catch (e) { why = { error: String(e && e.message || e) }; }
      const res = j && j.Result;
      const list = (res && res.Items) || [];
      items.push(...list);
      if (why && page === 1) fails.push(why);
      if (list.length) count = page;
      if (!list.length || page >= ((res && res.PagesCount) || 1)) break;
      await new Promise((ok) => setTimeout(ok, 300));
    }
    pages.push(count);
  }
  if (typeof document === 'undefined') return { items, pages, fails, pageText: '' };
  for (const a of document.querySelectorAll('a[href*="/PdfDocument/"], a[href*="/Document/Pdf/"]')) {
    const div = document.createElement('div');
    div.textContent = 'PDF: ' + a.href;
    a.after(div);
  }
  return { items, pages, fails, pageText: document.body ? document.body.innerText : '' };
}

/*
 * Последняя загрузка карточки: каким путём и что пошло не так. Только для
 * пробы (tools/ext-probe.mjs) — наружу не отдаётся и не хранится.
 */
globalThis.kadTrace = [];
const trace = (step, info) => { globalThis.kadTrace.push({ step, ...info }); };

/*
 * Без вкладки: карточка и её API запрашиваются из фоновой части, с cookies
 * этого браузера. Быстро и незаметно; если вместо карточки картотека отдала
 * проверку (cookies ещё нет или устарели), — null, и карточку откроет вкладка.
 */
async function collectDirect(url, caseId) {
  const r = await fetch(toBase(url), { credentials: 'include' });
  const html = r.ok ? await r.text() : '';
  const instances = instancesIn(html);
  trace('direct', { status: r.status, htmlLen: html.length, instances: instances.length });
  if (!instances.length) return null;
  // Без Referer карточки API отвечает запросу расширения 403 (проверено на kad).
  const rule = await pageHeaders(toBase(url), caseId);
  let got;
  try {
    got = await collectInPage(caseId, instances, BASE);
  } finally {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [rule] }).catch(() => {});
  }
  trace('direct-api', { items: got.items.length, pages: got.pages, fails: got.fails });
  if (!got.items.length) return null;
  let pageText = C.htmlToText(html);
  if (BASE !== KAD) pageText = pageText.split(BASE).join(KAD);
  return { pageText, apiText: I.itemsToText(got.items, caseId), apiItems: got.items.length, pages: got.pages };
}

/*
 * Запросам расширения к API хронологии дела — заголовки страницы карточки:
 * Referer — сама карточка, без Origin. Правило сессии — на запросы этого
 * дела и не из вкладок, то есть самого расширения; своё у каждой загрузки,
 * чтобы одновременные загрузки не мешали друг другу. Возвращает номер правила.
 */
let ruleNo = 0;
async function pageHeaders(cardUrl, caseId) {
  const id = 1 + (ruleNo++ % 1000);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: cardUrl },
          { header: 'Origin', operation: 'remove' }
        ]
      },
      condition: { urlFilter: `|${BASE}/Kad/InstanceDocumentsPage?*caseId=${caseId}`, tabIds: [chrome.tabs.TAB_ID_NONE] }
    }]
  });
  return id;
}

/* Вкладка: карточку открывает браузер, как открыл бы человек, — со всеми проверками картотеки. */
async function collectInTab(url, caseId) {
  const tab = await chrome.tabs.create({ url: toBase(url), active: false });
  let keep = false;
  try {
    await tabLoaded(tab.id, 60000);
    // Проверка картотеки может перезагрузить страницу — ждём саму карточку.
    let state = null;
    for (let i = 0; i < 40; i++) {
      state = await inTab(tab.id, pageState).catch(() => null);
      if (state && state.instances.length) break;
      await sleep(1000);
    }
    trace('tab', { instances: state ? state.instances.length : 0, wall: !!(state && state.wall), page: state ? state.diag : null });
    if (!state || !state.instances.length) {
      if (state && state.wall) {
        // Проверку «вы не робот» проходит человек: показываем ему вкладку.
        keep = true;
        await chrome.tabs.update(tab.id, { active: true });
        throw new Error('kad.arbitr просит пройти проверку «вы не робот» — вкладка открыта; пройдите проверку и загрузите карточку ещё раз');
      }
      throw new Error(state
        ? 'страница карточки открылась, но хронологии дела на ней нет — возможно, картотека изменила устройство страницы'
        : 'страница карточки не открылась — kad.arbitr не отвечает или недоступен');
    }
    const r = await inTab(tab.id, collectInPage, [caseId, state.instances], 180000);
    trace('tab-api', { items: r && r.items ? r.items.length : 0, pages: r && r.pages, fails: r && r.fails });
    let pageText = (r && r.pageText) || '';
    if (BASE !== KAD) pageText = pageText.split(BASE).join(KAD);
    const items = (r && r.items) || [];
    return { pageText, apiText: items.length ? I.itemsToText(items, caseId) : '', apiItems: items.length, pages: r && r.pages };
  } finally {
    if (!keep) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function collect(url) {
  const caseId = url.match(KAD_CARD)[1];
  globalThis.kadTrace = [];
  try {
    const r = await collectDirect(url, caseId);
    if (r) return r;
  } catch (e) {
    trace('direct-error', { message: String(e && e.message || e).slice(0, 200) });
  }
  return collectInTab(url, caseId);
}

async function cardText(url) {
  if (!KAD_CARD.test(String(url || ''))) throw new Error('нужна ссылка вида https://kad.arbitr.ru/Card/…');
  const r = await collect(url);
  const got = I.chooseText(r, url.match(KAD_CARD)[0]);
  // Хронология длиннее одной страницы картотеки — сказать, что взяты все.
  const pages = (r.pages || []).reduce((a, b) => a + b, 0);
  const note = pages > 1 && r.apiItems ? `${got.note} (все ${pages} стр. хронологии)` : got.note;
  return { text: got.text, note, at: new Date().toISOString(), source: 'kad.arbitr' };
}

/* ---------- тексты определений ---------- */

const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/*
 * PDF картотека отдаёт не на прямой запрос, а браузеру, прошедшему её
 * проверку во вкладке. Тело ответа такой вкладки видно только отладчику
 * (chrome.debugger) — это отдельное разрешение, его пользователь даёт сам,
 * включая «загружать тексты определений». Прямой запрос пробуется первым.
 */
async function pdfBytes(url) {
  const target = toBase(url);
  try {
    const r = await fetch(target, { credentials: 'include' });
    const b = new Uint8Array(await r.arrayBuffer());
    if (P.isPdf(b)) return b;
  } catch (_) { /* дальше — вкладка */ }
  if (!(await chrome.permissions.contains({ permissions: ['debugger'] })))
    throw new Error('картотека отдаёт PDF только после проверки браузера, а у расширения нет разрешения читать вкладку — переустановите расширение');

  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  const dbg = { tabId: tab.id };
  let listener = null;
  try {
    await chrome.debugger.attach(dbg, '1.3');
    const got = new Promise((resolve) => {
      listener = async (src, method, params) => {
        if (src.tabId !== tab.id || method !== 'Fetch.requestPaused') return;
        try {
          const ct = (params.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type');
          if (params.responseStatusCode === 200 && ct && /pdf/i.test(ct.value)) {
            const body = await chrome.debugger.sendCommand(dbg, 'Fetch.getResponseBody', { requestId: params.requestId });
            const b = body.base64Encoded ? fromB64(body.body) : new TextEncoder().encode(body.body);
            if (P.isPdf(b)) resolve(b);
          }
        } catch (_) { /* ответ без тела */ }
        chrome.debugger.sendCommand(dbg, 'Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      };
      chrome.debugger.onEvent.addListener(listener);
    });
    await chrome.debugger.sendCommand(dbg, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] });
    await chrome.tabs.update(tab.id, { url: target });
    const b = await Promise.race([got, sleep(45000).then(() => null)]);
    if (!b) throw new Error('картотека не отдала PDF за 45 секунд — документ ещё не опубликован или проверка не пройдена');
    return b;
  } finally {
    if (listener) chrome.debugger.onEvent.removeListener(listener);
    await chrome.debugger.detach(dbg).catch(() => {});
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function pdfText(url) {
  if (!KAD_PDF.test(String(url || ''))) throw new Error('нужна ссылка на PDF картотеки');
  return P.text(getDocument, await pdfBytes(url));
}

/* ---------- проверка ---------- */

async function check(id, why) {
  const st = await load(id);
  if (!st) throw new Error('нет такого спора');
  if (!KAD_CARD.test(st.url || '')) throw new Error('у спора нет ссылки на карточку kad.arbitr');
  const s = await settings();
  try {
    const got = await cardText(st.url);
    const card = { raw: got.text, html: false, source: 'kad.arbitr', at: got.at };
    const texts = { ...(st.texts || {}) };
    if (s.pdfTexts) {
      const a0 = analyze({ ...st, card, texts });
      const todo = a0.d.events.filter((e) => isAct(e) && e.rec.pdf && !texts[e.rec.id]).slice(-6);
      for (const e of todo) {
        try { const t = await pdfText(e.rec.pdf); if (t) texts[e.rec.id] = t; } catch (_) { /* следующий */ }
      }
    }
    // Пока шла проверка, страница могла сохранить правки — берём свежую копию.
    const cur = (await load(id)) || st;
    cur.card = card;
    cur.texts = { ...texts, ...(cur.texts || {}) };
    cur.checkedAt = new Date().toISOString();
    cur.error = null;
    cur.note = got.note;
    const a = analyze(cur);
    const fresh = a.d.events.filter((e) => e.isNew && !(cur.notified || []).includes(e.rec.id));
    if (fresh.length) cur.notified = [...(cur.notified || []), ...fresh.map((e) => e.rec.id)].slice(-500);
    cur.summary = a.summary;
    await put(cur);
    if (fresh.length && s.notify && why === 'plan') notify(cur, a, fresh);
    await badge();
    return { summary: a.summary, fresh: fresh.length, note: got.note };
  } catch (err) {
    const cur = (await load(id)) || st;
    cur.checkedAt = new Date().toISOString();
    cur.error = String((err && err.message) || err).slice(0, 300);
    await put(cur);
    throw err;
  }
}

let running = false;
async function checkAll(why) {
  if (running) return { n: 0 };
  running = true;
  let n = 0;
  try {
    for (const id of await ids()) {
      try { await check(id, why); n++; } catch (_) { /* ошибка записана в спор */ }
      // Картотеку не нагружаем: между карточками — пауза.
      await sleep(15000);
    }
  } finally { running = false; }
  return { n };
}

/* ---------- уведомления, значок, будильник ---------- */

function notify(st, a, fresh) {
  const s = a.summary;
  chrome.notifications.create(`d:${st.id}:${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/128.png',
    title: `${s.caseNo || 'Спор'}: ${fresh.length} ${D.plural(fresh.length, 'новый документ', 'новых документа', 'новых документов')}`,
    message: fresh.slice(0, 3).map((e) => `${D.fmt(e.rec.date)} — ${e.cls.doc}`).join('\n'),
    contextMessage: `${s.stageLabel}${s.nextDue ? ` · срок ${D.fmt(s.nextDue.date)}` : ''}`,
    priority: 1
  });
}

async function badge() {
  let n = 0;
  for (const id of await ids()) {
    const st = await load(id);
    if (st && st.summary && st.summary.newEvents) n++;
  }
  await chrome.action.setBadgeBackgroundColor({ color: '#8D321F' });
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
}

async function openApp(hash) {
  const url = chrome.runtime.getURL('app.html') + (hash || '');
  const open = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [chrome.runtime.getURL('app.html')] }).catch(() => []);
  if (open.length && open[0].tabId >= 0) {
    await chrome.tabs.update(open[0].tabId, { active: true, url });
    if (open[0].windowId >= 0) chrome.windows.update(open[0].windowId, { focused: true }).catch(() => {});
  } else {
    await chrome.tabs.create({ url });
  }
}

async function arm(s) {
  await chrome.alarms.clear('check');
  if (s.checkHours > 0) await chrome.alarms.create('check', { periodInMinutes: s.checkHours * 60 });
}

chrome.runtime.onInstalled.addListener(async () => { await arm(await settings()); await badge(); });
chrome.runtime.onStartup.addListener(async () => {
  if (!(await chrome.alarms.get('check'))) await arm(await settings());
  await badge();
});
chrome.alarms.onAlarm.addListener((al) => { if (al.name === 'check') checkAll('plan'); });
chrome.action.onClicked.addListener(() => openApp(''));
chrome.notifications.onClicked.addListener((nid) => {
  const m = nid.match(/^d:([^:]+):/);
  openApp(m ? `#d=${m[1]}` : '');
  chrome.notifications.clear(nid);
});

/* ---------- сообщения страницы ---------- */

async function handle(msg) {
  switch (msg && msg.type) {
    case 'settings': {
      if (msg.set) {
        const s = { ...(await settings()), ...msg.set };
        await store.set({ settings: s });
        await arm(s);
      }
      return settings();
    }
    case 'list': return { items: await listItems() };
    case 'get': {
      const st = await load(msg.id);
      if (!st) throw new Error('нет такого спора');
      return { state: st };
    }
    case 'save': return { id: await save(msg.state) };
    case 'remove': await drop(msg.id); await badge(); return { ok: true };
    case 'card': return cardText(msg.url);
    case 'pdf': return { text: await pdfText(msg.url) };
    case 'check': return check(msg.id, 'button');
    case 'checkAll': return checkAll('button');
    default: throw new Error('неизвестная команда');
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Только страницы самого расширения.
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg).then(reply, (e) => reply({ error: String((e && e.message) || e) }));
  return true;
});

/*
 * Страница программы на сайте (externally_connectable в manifest.json — только
 * она): тот же разговор, что со страницей расширения. Данные при этом не
 * покидают браузер: страница и расширение говорят друг с другом внутри него.
 */
chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  const p = msg && msg.type === 'ping'
    ? Promise.resolve({ ok: true, version: chrome.runtime.getManifest().version })
    : msg && msg.type === 'openApp' ? openApp(msg.hash || '').then(() => ({ ok: true })) : handle(msg);
  p.then(reply, (e) => reply({ error: String((e && e.message) || e) }));
  return true;
});
