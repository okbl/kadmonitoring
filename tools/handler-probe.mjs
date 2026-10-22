/*
 * Проба своего обработчика на настоящей картотеке: обработчик (адрес в
 * KAD_HANDLER, ключ в KAD_KEY — например, запущенный из Docker-образа) и
 * страница программы, подключённая к нему ссылкой #handler=…&key=…. Как у
 * пользователя: дата и ссылка — дальше всё само, без вкладки kad.arbitr.
 * Печатает только числа, стадию и сроки.
 *
 * node tools/handler-probe.mjs <ссылка на карточку> <дата подачи>   (сайт отдаётся здесь же, порт SITE_PORT)
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';
import { assemble } from '../build.mjs';

const [url, filed] = process.argv.slice(2);
const HANDLER = process.env.KAD_HANDLER;
const KEY = process.env.KAD_KEY || '';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = assemble();
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html); }
  if (p === '/pdf.min.mjs' || p === '/pdf.worker.min.mjs') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(path.join(root, 'node_modules/pdfjs-dist/legacy/build', p.slice(1)))); }
  res.writeHead(404); res.end();
});
await new Promise((ok) => server.listen(+(process.env.SITE_PORT || 0), '127.0.0.1', ok));
const site = `http://127.0.0.1:${server.address().port}/`;

const t0 = Date.now();
const sec = () => `${((Date.now() - t0) / 1000).toFixed(0)} с`;
// Страница программы — в любом Chromium: к kad.arbitr она не обращается, это делает обработчик.
const browser = await chromium.launch({ headless: true, ...(process.env.KAD_CHROMIUM ? { executablePath: process.env.KAD_CHROMIUM } : {}) });
const ctx = await browser.newContext();
let failed = false;
try {
  const ping = await (await fetch(`${HANDLER}/ping`)).json();
  console.log(`обработчик: ${ping.ok ? 'отвечает' : 'нет'}, ключ ${ping.key ? 'задан' : 'не задан'}`);
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${site}#handler=${encodeURIComponent(HANDLER)}&key=${encodeURIComponent(KEY)}`);
  await page.waitForSelector('body.local.handler', { timeout: 30000 });
  await page.waitForFunction(() => /работает|не отвечает/.test(document.getElementById('handlerState').textContent), null, { timeout: 30000 });
  console.log(`сайт подключён к обработчику: ${await page.textContent('#handlerState')} · ${sec()}`);

  const pages = ctx.pages().length;
  await page.click('#btnNew');
  await page.fill('#dateInput', filed);
  await page.dispatchEvent('#dateInput', 'change');
  await page.fill('#urlInput', url);
  await page.waitForFunction(() => /к спору относятся|не удалось/i.test(document.getElementById('pasteEcho').textContent), null, { timeout: 240000 });
  const echo = await page.textContent('#pasteEcho');
  const counts = echo.match(/В карточке (\d+) .*?относятся (\d+)/);
  console.log(`загрузка через обработчик: ${counts ? `документов ${counts[1]}, в споре ${counts[2]}` : 'не удалась — ' + echo.slice(0, 200)}; вкладок kad открыто: ${ctx.pages().length - pages} · ${sec()}`);
  if (!counts) throw new Error('карточка не загружена');
  console.log(`стадия: ${await page.textContent('#tiles .big')}`);
  await page.waitForFunction(() => /^#d=/.test(location.hash), null, { timeout: 30000 });

  const read = () => page.evaluate(() => new Promise((ok) => {
    const q = indexedDB.open('kadmonitoring', 1);
    q.onsuccess = () => {
      const tx = q.result.transaction('kv');
      const g = tx.objectStore('kv').get('ids');
      g.onsuccess = () => {
        const ids = g.result || [];
        if (!ids.length) return ok(null);
        const d = tx.objectStore('kv').get(`d:${ids[0]}`);
        d.onsuccess = () => ok(d.result);
      };
    };
  }));
  let st = null;
  for (let i = 0; i < 90; i++) {
    st = await read();
    if (st && Object.keys(st.texts || {}).length) break;
    await page.waitForTimeout(2000);
  }
  console.log(`текстов определений: ${Object.keys((st && st.texts) || {}).length} · ${sec()}`);

  await page.click('#btnList');
  await page.waitForSelector('.drow');
  await page.click('[data-check]');
  await page.waitForFunction(() => !document.querySelector('[data-check][disabled]') && /проверено/.test(document.getElementById('list').textContent), null, { timeout: 300000 });
  st = await read();
  console.log(`проверка: ошибка ${st.error ? '«' + st.error + '»' : 'нет'}; текстов ${Object.keys(st.texts || {}).length}; стадия «${st.summary && st.summary.stageLabel}»; ближайший срок ${st.summary && st.summary.nextDue ? st.summary.nextDue.date : '—'}; ${st.note || ''} · ${sec()}`);
  console.log(`ошибок страницы: ${errors.length}`);
  if (st.error || !Object.keys(st.texts || {}).length || errors.length) failed = true;
} catch (e) {
  failed = true;
  console.log('ОШИБКА:', e.message.split('\n')[0]);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
