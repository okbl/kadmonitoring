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
import './kad-page.js';
import './pdf-text.js';
import './tracker.js';
// pdf.js без отдельного потока: в фоновой части расширения нет Worker,
// а модуль обработчика, загруженный заранее, pdf.js находит сам.
import './pdf.worker.min.mjs';
import { getDocument } from './pdf.min.mjs';

const { KadCard: C, KadDates: D, KadItems: I, KadPdf: P, KadPage: K, KadTracker: T } = globalThis;

const KAD = 'https://kad.arbitr.ru';
// Адрес картотеки подменяется только в тестовой сборке — на макет.
const BASE = (globalThis.KAD_CONFIG && globalThis.KAD_CONFIG.base) || KAD;
const toBase = (u) => BASE === KAD ? u : u.replace(/^https?:\/\/(?:www\.)?kad\.arbitr\.ru/i, BASE);
const KAD_CARD = new RegExp(`^https?://(?:www\\.)?kad\\.arbitr\\.ru/Card/(${C.GUID})`, 'i');
const KAD_PDF = /^https?:\/\/(?:www\.)?kad\.arbitr\.ru\/(?:Document\/Pdf|Kad\/PdfDocument)\//i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- споры: общий код с сайтом (src/tracker.js), хранилище — этого браузера ---------- */

const store = {
  get: async (k) => (await chrome.storage.local.get(k))[k],
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
  remove: (k) => chrome.storage.local.remove(k)
};
const tracker = T.create({ store, card: (url) => cardText(url), pdf: (url) => pdfText(url) });

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

/* Выполняется во вкладке картотеки: текст страницы, ссылки на PDF — отдельными строками. */
function pageTextInTab() {
  for (const a of document.querySelectorAll('a[href*="/PdfDocument/"], a[href*="/Document/Pdf/"]')) {
    const div = document.createElement('div');
    div.textContent = 'PDF: ' + a.href;
    a.after(div);
  }
  return document.body ? document.body.innerText : '';
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
  const instances = K.instancesIn(html);
  trace('direct', { status: r.status, htmlLen: html.length, instances: instances.length });
  if (!instances.length) return null;
  // Без Referer карточки API отвечает запросу расширения 403 (проверено на kad).
  const rule = await pageHeaders(toBase(url), caseId);
  let got;
  try {
    got = await K.chronology(caseId, instances, BASE);
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
    const r = await inTab(tab.id, K.chronology, [caseId, state.instances], 180000);
    trace('tab-api', { items: r && r.items ? r.items.length : 0, pages: r && r.pages, fails: r && r.fails });
    let pageText = (await inTab(tab.id, pageTextInTab).catch(() => '')) || '';
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
  return I.cardFrom(await collect(url), url.match(KAD_CARD)[0]);
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
  const s = await tracker.settings();
  const r = await tracker.check(id);
  if (r.fresh.length && s.notify && why === 'plan') notify(r.st, r.a, r.fresh);
  await badge();
  return { summary: r.a.summary, fresh: r.fresh.length, note: r.st.note };
}

let running = false;
async function checkAll(why) {
  if (running) return { n: 0 };
  running = true;
  let n = 0;
  try {
    for (const id of await tracker.ids()) {
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
  const n = await tracker.withNew();
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

chrome.runtime.onInstalled.addListener(async () => { await arm(await tracker.settings()); await badge(); });
chrome.runtime.onStartup.addListener(async () => {
  if (!(await chrome.alarms.get('check'))) await arm(await tracker.settings());
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
      if (!msg.set) return tracker.settings();
      const s = await tracker.settings(msg.set);
      await arm(s);
      return s;
    }
    case 'list': return { items: await tracker.list() };
    case 'get': {
      const st = await tracker.load(msg.id);
      if (!st) throw new Error('нет такого спора');
      return { state: st };
    }
    case 'save': { const id = await tracker.save(msg.state); await badge(); return { id }; }
    case 'remove': await tracker.remove(msg.id); await badge(); return { ok: true };
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
