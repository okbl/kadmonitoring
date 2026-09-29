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
    const withFile = a1.list.filter((x) => x.FileName).slice(0, 2);
    out.pdfs = [];
    const isPdf = (b) => b.byteLength > 4 && new TextDecoder().decode(new Uint8Array(b.slice(0, 5))) === '%PDF-';
    for (const it of withFile) {
      const url = `/Kad/PdfDocument/${caseId}/${it.Id}/${it.FileName}`;
      const f1 = await fetch(url, { credentials: 'include' });
      const b1 = await f1.arrayBuffer();
      const res = { direct: { status: f1.status, type: f1.headers.get('content-type'), pdf: isPdf(b1), len: b1.byteLength, redirected: f1.redirected } };
      // Невидимая рамка проходит проверку, как вкладка; потом — снова запрос.
      const fr = document.createElement('iframe');
      fr.style.cssText = 'position:fixed;left:-50px;top:0;width:10px;height:10px;opacity:0';
      fr.src = url;
      document.body.append(fr);
      let finalUrl = null;
      for (let i = 0; i < 40; i++) {
        await new Promise((ok) => setTimeout(ok, 500));
        try { finalUrl = fr.contentWindow.location.href; } catch (_) { finalUrl = 'cross'; }
        if (/\/Document\/Pdf\//.test(finalUrl || '')) break;
      }
      res.frameUrl = (finalUrl || '').replace(/[0-9a-f-]{36}/g, '<id>').replace(/\/[^/?]+\.pdf/i, '/<файл>.pdf');
      try { res.frameType = fr.contentDocument && fr.contentDocument.contentType; } catch (_) { res.frameType = 'нет доступа'; }
      for (const u of [finalUrl, url]) {
        if (!u || u === 'cross' || u === 'about:blank') continue;
        const f2 = await fetch(u, { credentials: 'include' });
        const b2 = await f2.arrayBuffer();
        res[u === url ? 'afterFrame' : 'afterFrameFinal'] = { status: f2.status, type: f2.headers.get('content-type'), pdf: isPdf(b2), len: b2.byteLength };
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
