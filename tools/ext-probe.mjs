/*
 * Проба расширения на настоящей картотеке: Chromium с загруженным
 * расширением открывает страницу расширения, вводит дату и ссылку — и
 * ждёт, что карточка загрузится (все страницы хронологии), спор встанет на
 * отслеживание, а проверка загрузит тексты определений, — так, как это
 * увидит пользователь. KAD_SITE — адрес сайта программы: проверить, что
 * страница на сайте работает через расширение.
 *
 * Печатает только сводные числа и стадию: журнал проб может быть открытым,
 * а в карточке — персональные данные участников дела.
 *
 * node tools/ext-probe.mjs <ссылка на карточку> <дата подачи дд.мм.гггг>
 * Нужен Chromium с поддержкой расширений: KAD_CHROMIUM или playwright.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright-core';
import { extensionFiles, writeDir } from '../build.mjs';

const [url, filed] = process.argv.slice(2);
if (!url || !filed) { console.error('нужны ссылка на карточку и дата подачи'); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kad-ext-probe-'));
const dir = path.join(tmp, 'ext');
writeDir(dir, extensionFiles());

const t0 = Date.now();
const sec = () => `${((Date.now() - t0) / 1000).toFixed(0)} с`;
// Облегчённый Chromium Headless Shell расширений не умеет — нужен полный Chromium.
const exe = process.env.KAD_CHROMIUM ? { executablePath: process.env.KAD_CHROMIUM } : { channel: 'chromium' };
const opts = (extra = []) => ({
  headless: true,
  ...exe,
  // Как у обычного пользователя: без признаков автоматизации.
  ignoreDefaultArgs: ['--enable-automation'],
  args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, '--disable-blink-features=AutomationControlled', ...extra]
});
// Без окна браузер называет себя HeadlessChrome — такую подпись картотека
// встречает проверкой, а у пользователя браузер обычный. Перезапуск с обычной.
let ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), opts());
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const ua = await sw.evaluate(() => navigator.userAgent);
if (/Headless/.test(ua)) {
  await ctx.close();
  ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), opts([`--user-agent=${ua.replace(/HeadlessChrome/g, 'Chrome')}`]));
  sw = null;
}

/* Путь загрузки: шаги, числа, устройство страницы; текст — только у страницы проверки. */
async function printTrace() {
  const tr = await sw.evaluate(() => globalThis.kadTrace || []).catch(() => []);
  for (const x of tr) console.log('  путь:', JSON.stringify(x));
}

let failed = false;
try {
  if (!sw) sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  console.log(`браузер: ${/Headless/.test(await sw.evaluate(() => navigator.userAgent)) ? 'HeadlessChrome' : 'Chrome'}; расширение ${id}`);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${id}/app.html`);
  await page.waitForSelector('body.ext');
  console.log(`страница расширения открыта · ${sec()}`);

  // Как пользователь: дата и ссылка, больше ничего.
  await page.click('#btnNew');
  await page.fill('#dateInput', filed);
  await page.dispatchEvent('#dateInput', 'change');
  await page.fill('#urlInput', url);
  await page.waitForFunction(() => {
    const t = document.getElementById('pasteEcho').textContent;
    return /к спору относятся|не удалось/i.test(t) && !document.getElementById('btnFetch').disabled;
  }, null, { timeout: 240000 });
  const echo = await page.textContent('#pasteEcho');
  const counts = echo.match(/В карточке (\d+) .*?относятся (\d+)/);
  console.log(`загрузка карточки: ${counts ? `документов ${counts[1]}, в споре ${counts[2]}` : 'не удалась — ' + echo.slice(0, 200)} · ${sec()}`);
  await printTrace();
  if (!counts) throw new Error('карточка не загружена');
  console.log(`стадия: ${await page.textContent('#tiles .big')}`);

  // Спор встаёт на отслеживание сам.
  await page.waitForFunction(() => /^#d=/.test(location.hash), null, { timeout: 30000 });
  await page.click('#btnList');
  await page.waitForSelector('.drow');

  await page.click('[data-check]');
  await page.waitForFunction(() => !document.querySelector('[data-check][disabled]') && /проверено/.test(document.getElementById('list').textContent), null, { timeout: 600000 });
  const all = await sw.evaluate(() => chrome.storage.local.get(null));
  const st = all[`d:${all.ids[0]}`];
  console.log(`проверка: ошибка ${st.error ? '«' + st.error + '»' : 'нет'}; текстов определений ${Object.keys(st.texts || {}).length}; стадия «${st.summary && st.summary.stageLabel}»; ближайший срок ${st.summary && st.summary.nextDue ? st.summary.nextDue.date : '—'} · ${sec()}`);
  console.log(`заметка проверки: ${st.note || '—'}`);
  await printTrace();
  console.log(`ключи хранилища: ${Object.keys(all).map((k) => k.replace(/^d:.*/, 'd:<спор>')).join(', ')}`);

  // Сайт программы видит расширение (страница на Pages, если опубликована).
  if (process.env.KAD_SITE) {
    const site = await ctx.newPage();
    site.on('pageerror', (e) => errors.push(e.message));
    await site.goto(process.env.KAD_SITE);
    const ok = await site.waitForSelector('body.ext', { timeout: 20000 }).then(() => true, () => false);
    const rows = ok ? await site.waitForSelector('.drow', { timeout: 20000 }).then(() => site.$$eval('.drow', (x) => x.length), () => 0) : 0;
    console.log(`сайт ${process.env.KAD_SITE}: ${ok ? `работает через расширение, споров в списке ${rows}` : 'расширения не видит'}`);
    if (!ok) failed = true;
  }
  console.log(`ошибок страницы: ${errors.length}`);
  if (st.error || errors.length) failed = true;
} catch (e) {
  failed = true;
  console.log('ОШИБКА:', e.message.split('\n')[0]);
} finally {
  await ctx.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
