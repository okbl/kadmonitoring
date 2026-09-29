/*
 * Проба сайта без расширения на настоящей картотеке: страница программы
 * (собранная, отдаётся здесь же) и вкладка kad.arbitr, в которой «нажата»
 * закладка «Спор ← kad», — как у пользователя на рабочем компьютере: дата
 * и ссылка, дальше всё само. Печатает только числа, стадию и сроки — без
 * имён и текстов.
 *
 * node tools/site-probe.mjs <ссылка на карточку> <дата подачи дд.мм.гггг>
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';
import { assemble } from '../build.mjs';

const [url, filed] = process.argv.slice(2);
if (!url || !filed) { console.error('нужны ссылка на карточку и дата подачи'); process.exit(2); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pdfjs = (f) => fs.readFileSync(path.join(root, 'node_modules', 'pdfjs-dist', 'build', f));

// Сайт — как на Pages: страница и pdf.js рядом.
const html = assemble();
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html); }
  if (p === '/pdf.min.mjs' || p === '/pdf.worker.min.mjs') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(pdfjs(p.slice(1))); }
  res.writeHead(404); res.end();
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const site = `http://127.0.0.1:${server.address().port}/`;

const t0 = Date.now();
const sec = () => `${((Date.now() - t0) / 1000).toFixed(0)} с`;
// Облегчённый Chromium Headless Shell картотека встречает проверкой «вы не
// робот» — у пользователя обычный браузер, поэтому здесь полный Chromium.
const exe = process.env.KAD_CHROMIUM ? { executablePath: process.env.KAD_CHROMIUM } : { channel: 'chromium' };
const browser = await chromium.launch({ headless: true, ...exe, ignoreDefaultArgs: ['--enable-automation'], args: ['--disable-blink-features=AutomationControlled'] });
const tmp = await browser.newPage();
const ua = (await tmp.evaluate(() => navigator.userAgent)).replace(/HeadlessChrome/g, 'Chrome');
await tmp.close();
// Без окна браузер называет себя HeadlessChrome — у пользователя браузер обычный.
const ctx = await browser.newContext({ userAgent: ua, locale: 'ru-RU' });

const stored = () => new Promise((resolve) => {
  const q = indexedDB.open('kadmonitoring', 1);
  q.onsuccess = () => {
    const db = q.result;
    const get = (k) => new Promise((ok) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => ok(r.result); });
    get('ids').then(async (ids) => resolve({ ids: ids || [], first: ids && ids.length ? await get(`d:${ids[0]}`) : null }));
  };
});
const readStore = (page) => page.evaluate(async (fn) => (0, eval)(fn)(), stored.toString());

let failed = false;
try {
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(site);
  await page.waitForSelector('body.local');
  const bookmark = decodeURIComponent((await page.getAttribute('#bookmarklet', 'href')).slice('javascript:'.length));
  console.log(`сайт открыт, закладка ${bookmark.length} символов · ${sec()}`);

  await page.click('#btnNew');
  await page.fill('#dateInput', filed);
  await page.dispatchEvent('#dateInput', 'change');
  const [kad] = await Promise.all([ctx.waitForEvent('page'), page.fill('#urlInput', url)]);
  kad.on('pageerror', (e) => errors.push(`kad: ${e.message}`));
  await kad.waitForLoadState('domcontentloaded');
  const ready = await kad.waitForSelector('input.js-instanceId', { state: 'attached', timeout: 60000 }).then(() => true, () => false);
  console.log(`вкладка карточки открыта сайтом: ${ready ? 'карточка' : 'не карточка (проверка?)'} · ${sec()}`);

  // «Нажать закладку» во вкладке картотеки.
  await kad.evaluate(bookmark);
  await page.waitForFunction(() => /к спору относятся|не удалось/i.test(document.getElementById('pasteEcho').textContent), null, { timeout: 180000 });
  const echo = await page.textContent('#pasteEcho');
  const counts = echo.match(/В карточке (\d+) .*?относятся (\d+)/);
  console.log(`загрузка через закладку: ${counts ? `документов ${counts[1]}, в споре ${counts[2]}` : 'не удалась — ' + echo.slice(0, 200)} · ${sec()}`);
  if (!counts) throw new Error('карточка не загружена');
  console.log(`стадия: ${await page.textContent('#tiles .big')}; связь: ${await page.textContent('#kadState')}`);

  // Спор встал на отслеживание; тексты определений — через проверку картотеки перед PDF.
  await page.waitForFunction(() => /^#d=/.test(location.hash), null, { timeout: 30000 });
  const texts = await page.waitForFunction(async (fn) => {
    const s = await (0, eval)(fn)();
    const n = s.first ? Object.keys(s.first.texts || {}).length : 0;
    return n > 0 && n;
  }, stored.toString(), { timeout: 180000 }).then((h) => h.jsonValue(), () => 0);
  console.log(`текстов определений: ${texts} · ${sec()}`);

  // Проверка по кнопке — через ту же вкладку.
  await page.click('#btnList');
  await page.waitForSelector('.drow');
  await page.click('[data-check]');
  await page.waitForFunction(() => !document.querySelector('[data-check][disabled]') && /проверено/.test(document.getElementById('list').textContent), null, { timeout: 300000 });
  const st = (await readStore(page)).first;
  console.log(`проверка: ошибка ${st.error ? '«' + st.error + '»' : 'нет'}; текстов ${Object.keys(st.texts || {}).length}; стадия «${st.summary && st.summary.stageLabel}»; ближайший срок ${st.summary && st.summary.nextDue ? st.summary.nextDue.date : '—'}; ${st.note || ''} · ${sec()}`);

  // Сайт перезагрузили — связь восстанавливается.
  await page.reload();
  const back = await page.waitForFunction(() => /связь есть/.test(document.getElementById('kadState').textContent), null, { timeout: 15000 }).then(() => true, () => false);
  console.log(`после перезагрузки сайта связь: ${back ? 'есть' : 'нет'}`);
  console.log(`ошибок страниц: ${errors.length}${errors.length ? ' — ' + errors.map((e) => e.slice(0, 120)).join(' | ') : ''}`);
  if (st.error || !texts || !back || errors.length) failed = true;
} catch (e) {
  failed = true;
  console.log('ОШИБКА:', e.message.split('\n')[0]);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
