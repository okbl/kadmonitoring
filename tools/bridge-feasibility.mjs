/*
 * Проба на настоящей картотеке: возможен ли мост «сайт ↔ вкладка kad»
 * через закладку. Печатает только заголовки безопасности kad, да/нет и
 * числа — без содержания карточки.
 *
 * node tools/bridge-feasibility.mjs <ссылка на карточку> <адрес сайта>
 */
import { chromium } from 'playwright-core';

const [card, site] = process.argv.slice(2);
const exe = process.env.KAD_CHROMIUM ? { executablePath: process.env.KAD_CHROMIUM } : { channel: 'chromium' };
let browser = await chromium.launch({ headless: true, ...exe, ignoreDefaultArgs: ['--enable-automation'], args: ['--disable-blink-features=AutomationControlled'] });
const ua = (await browser.version()) && await (async () => { const p = await browser.newPage(); const u = await p.evaluate(() => navigator.userAgent); await p.close(); return u; })();
const ctx = await browser.newContext({ userAgent: ua.replace(/HeadlessChrome/g, 'Chrome'), locale: 'ru-RU' });
const log = (k, v) => console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

try {
  // 1. Заголовки карточки.
  const kad = await ctx.newPage();
  const res = await kad.goto(card, { waitUntil: 'domcontentloaded' });
  const h = res.headers();
  log('первый ответ карточки', { status: res.status(), csp: h['content-security-policy'] || null, coop: h['cross-origin-opener-policy'] || null, xfo: h['x-frame-options'] || null });
  await kad.waitForSelector('input.js-instanceId', { state: 'attached', timeout: 40000 }).catch(() => null);
  const last = await kad.evaluate(() => performance.getEntriesByType('navigation').map((n) => n.name.replace(/[0-9a-f-]{36}/g, '<id>')));
  log('навигация', last);
  const hh = await kad.evaluate(async () => {
    const r = await fetch(location.href, { credentials: 'include' });
    return { csp: r.headers.get('content-security-policy'), coop: r.headers.get('cross-origin-opener-policy'), xfo: r.headers.get('x-frame-options') };
  });
  log('заголовки карточки после проверки', hh);
  await kad.close();

  // 2. Сайт открывает kad: связь окон и сообщения.
  const sp = await ctx.newPage();
  await sp.goto(site);
  await sp.evaluate(() => { window.__got = []; addEventListener('message', (e) => window.__got.push(e.origin)); });
  const [pop] = await Promise.all([ctx.waitForEvent('page'), sp.evaluate((u) => { window.__w = window.open(u, 'kadbridge'); }, card)]);
  await pop.waitForLoadState('domcontentloaded');
  await pop.waitForSelector('input.js-instanceId', { state: 'attached', timeout: 40000 }).catch(() => null);
  const siteOrigin = new URL(site).origin;
  log('kad видит окно сайта (opener)', await pop.evaluate(() => !!window.opener));
  await pop.evaluate((o) => { try { window.opener.postMessage({ t: 1 }, o); } catch (e) { window.__err = e.message; } }, siteOrigin);
  await sp.waitForTimeout(500);
  log('сообщение kad → сайт дошло', await sp.evaluate(() => window.__got));
  log('сайт видит окно kad', await sp.evaluate(() => !!window.__w && !window.__w.closed));
  await pop.evaluate(() => { window.__got = []; addEventListener('message', (e) => window.__got.push(e.origin)); });
  await sp.evaluate(() => window.__w.postMessage({ t: 2 }, 'https://kad.arbitr.ru'));
  await pop.waitForTimeout(500);
  log('сообщение сайт → kad дошло', await pop.evaluate(() => window.__got));

  // 3. Со страницы kad: карточка, API, PDF — обычными запросами страницы.
  const caseId = card.match(/[0-9a-f-]{36}/i)[0];
  const r = await pop.evaluate(async (caseId) => {
    const out = {};
    const html = await (await fetch('/Card/' + caseId, { credentials: 'include' })).text();
    const ids = [...html.matchAll(/<input\b[^>]*\bjs-instanceId\b[^>]*>/gi)].map((m) => (m[0].match(/value="([^"]+)"/) || [])[1]).filter(Boolean);
    out.cardHtml = html.length; out.instances = ids.length;
    const api = async (referrer) => {
      const u = `/Kad/InstanceDocumentsPage?_=${Date.now()}&id=${ids[0]}&caseId=${caseId}&perPage=30&page=1`;
      const x = await fetch(u, { credentials: 'include', referrer, headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01' } });
      const t = await x.text();
      let j = null; try { j = JSON.parse(t); } catch (_) {}
      return { status: x.status, items: j && j.Result && j.Result.Items ? j.Result.Items.length : -1, pages: j && j.Result ? j.Result.PagesCount : null, list: j && j.Result ? j.Result.Items : [] };
    };
    const a1 = await api(location.href);
    out.apiFromCard = { status: a1.status, items: a1.items, pages: a1.pages };
    const a2 = await api(location.origin + '/');
    out.apiRefRoot = { status: a2.status, items: a2.items };
    const withFile = a1.list.filter((x) => x.FileName).slice(0, 1);
    out.pdfs = [];
    const isPdf = (b) => b.byteLength > 4 && new TextDecoder().decode(new Uint8Array(b.slice(0, 5))) === '%PDF-';
    const anon = (u) => String(u || '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<id>').replace(/[^/?=&]+\.pdf/gi, '<файл>.pdf').replace(/(\?|&)(_|t|ts)=\d+/g, '$1$2=<n>');
    for (const it of withFile) {
      const url = `/Kad/PdfDocument/${caseId}/${it.Id}/${it.FileName}`;
      const res = {};
      // Что за HTML приходит вместо файла: устройство страницы без содержания.
      const f1 = await fetch(url, { credentials: 'include' });
      const t1 = await f1.text();
      const d1 = new DOMParser().parseFromString(t1, 'text/html');
      res.page = {
        url: anon(f1.url), title: d1.title, len: t1.length,
        scripts: [...d1.scripts].map((x) => x.src ? anon(new URL(x.src, location.href).pathname) : `inline:${x.textContent.length}`),
        embeds: [...d1.querySelectorAll('embed,object,iframe')].map((x) => `${x.tagName}:${anon(x.getAttribute('src') || x.getAttribute('data'))}`),
        forms: [...d1.forms].map((x) => `${x.method}:${anon(x.action)}`),
        urls: [...new Set((t1.match(/["'](\/[^"'\s]*(?:pdf|Pdf|PDF|Document)[^"'\s]*)["']/g) || []).map(anon))].slice(0, 15),
        words: [...new Set((t1.match(/\b(?:salto|wasm|challenge|captcha|token|hash|pow|cookie|fetch|XMLHttpRequest|blob|atob|location)\b/gi) || []).map((w) => w.toLowerCase()))],
        // Скрипт проверки и поля формы: длинные значения скрыты, имена и длины — видны.
        script: [...d1.scripts].map((x) => anon(x.textContent).replace(/[A-Za-z0-9+/=_-]{24,}/g, (m) => `<${m.length}>`)).join('\n---\n'),
        inputs: [...d1.querySelectorAll('input,textarea,select')].map((x) => `${x.name || x.id}:${x.type}:${(x.value || '').length}`),
        formAttrs: [...d1.forms].map((x) => [...x.attributes].map((a) => `${a.name}=${anon(a.value)}`).join(' ')),
        bodyTags: [...new Set([...d1.body.querySelectorAll('*')].map((x) => x.tagName))].slice(0, 20)
      };
      out.challengeHtml = t1.replace(/<input id="datat"[^>]*>/, '<datat>').replace(/[A-Za-z0-9+/=_-]{24,}/g, (m) => `<${m.length}>`).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<id>').replace(/\s+/g, ' ').slice(0, 3000);
      // Раскодированный скрипт проверки (код картотеки, без данных дела).
      const datat = (d1.getElementById('datat') || {}).value || '';
      const code = datat.split('\n').map((l) => String.fromCharCode(parseInt([...l].map((c) => (c === '\t' ? '1' : '0')).join(''), 2))).join('');
      res.decoded = anon(code.slice(0, -1)).replace(/[A-Za-z0-9+/=_-]{24,}/g, (m) => `<${m.length}>`).slice(0, 4000);
      // Проверка в своей рамке: отправку формы перехватываем, запрос делаем сами.
      try {
        const fr0 = document.createElement('iframe');
        fr0.style.cssText = 'position:fixed;left:-50px;top:0;width:10px;height:10px;opacity:0';
        document.body.append(fr0);
        const w = fr0.contentWindow;
        const how = [];
        const cap = new Promise((resolve) => {
          const grab = (form, via) => { how.push(via); resolve(new URLSearchParams(new w.FormData(form)).toString()); };
          w.HTMLFormElement.prototype.submit = function () { grab(this, 'submit()'); };
          w.HTMLFormElement.prototype.requestSubmit = function () { grab(this, 'requestSubmit()'); };
          w.addEventListener('submit', (e) => { e.preventDefault(); grab(e.target, 'событие submit'); }, true);
          setTimeout(() => resolve(null), 20000);
        });
        w.document.open();
        try { w.history.replaceState(null, '', f1.url); } catch (e) { how.push('replaceState: ' + e.message); }
        w.document.write(t1);
        w.document.close();
        const t0 = Date.now();
        const body = await cap;
        res.own = { captured: !!body, via: how, ms: Date.now() - t0, fields: body ? [...new URLSearchParams(body).keys()] : [], frameUrl: anon(w.location.href) };
        if (body) {
          const pr = await fetch(f1.url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
          const pb = await pr.arrayBuffer();
          res.own.post = { status: pr.status, type: pr.headers.get('content-type'), pdf: isPdf(pb), len: pb.byteLength };
          // Второй раз — уже с cookies проверки: нужен ли новый token для каждого файла?
          const g2 = await fetch(url, { credentials: 'include' });
          const gb = await g2.arrayBuffer();
          res.own.getAfter = { type: g2.headers.get('content-type'), pdf: isPdf(gb), len: gb.byteLength };
        }
        fr0.remove();
      } catch (e) { res.own = { error: e.message }; }
      // Рамка: ждём дольше, смотрим, что она загрузила.
      const fr = document.createElement('iframe');
      fr.style.cssText = 'position:fixed;left:-50px;top:0;width:10px;height:10px;opacity:0';
      fr.src = url;
      document.body.append(fr);
      const seen = [];
      for (let i = 0; i < 50; i++) {
        await new Promise((ok) => setTimeout(ok, 500));
        let st = '';
        try { st = `${anon(fr.contentWindow.location.href)} ${fr.contentDocument && fr.contentDocument.contentType}`; } catch (_) { st = 'нет доступа'; }
        if (seen[seen.length - 1] !== st) seen.push(st);
      }
      res.frame = seen;
      try {
        res.frameResources = fr.contentWindow.performance.getEntriesByType('resource').map((e) => `${e.initiatorType}:${anon(e.name.replace(location.origin, ''))}`).slice(0, 30);
        res.frameEmbeds = [...fr.contentDocument.querySelectorAll('embed,object,iframe')].map((x) => `${x.tagName}:${x.type || ''}:${anon(x.getAttribute('src') || x.getAttribute('data'))}`);
      } catch (e) { res.frameResources = 'нет доступа: ' + e.message; }
      const cur = (() => { try { return fr.contentWindow.location.href; } catch (_) { return null; } })();
      for (const [k, u, o] of [['again', url, {}], ['final', cur, {}], ['finalCache', cur, { cache: 'force-cache' }], ['finalDoc', cur, { headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } }]]) {
        if (!u || !/^http/.test(u)) continue;
        try {
          const f2 = await fetch(u, { credentials: 'include', ...o });
          const b2 = await f2.arrayBuffer();
          res[k] = { status: f2.status, type: f2.headers.get('content-type'), pdf: isPdf(b2), len: b2.byteLength, cc: f2.headers.get('cache-control') };
        } catch (e) { res[k] = e.message; }
      }
      fr.remove();
      out.pdfs.push(res);
    }
    return out;
  }, caseId);
  log('со страницы kad', r);

  // 4. kad открывает сайт: связь в обратную сторону.
  const [sp2] = await Promise.all([ctx.waitForEvent('page'), pop.evaluate((u) => { window.__s = window.open(u + '#kad', '_blank'); }, site)]);
  await sp2.waitForLoadState('domcontentloaded');
  log('сайт, открытый из kad, видит kad (opener)', await sp2.evaluate(() => !!window.opener));
} catch (e) {
  console.log('ОШИБКА:', e.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
