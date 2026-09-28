/*
 * Проба расширения на настоящей картотеке: Chromium с загруженным
 * расширением открывает страницу расширения, загружает карточку по ссылке,
 * ставит спор на отслеживание и проверяет его с загрузкой текстов
 * определений — так, как это сделает пользователь.
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
writeDir(dir, extensionFiles({ debuggerAtInstall: true }));

const t0 = Date.now();
const sec = () => `${((Date.now() - t0) / 1000).toFixed(0)} с`;
// Облегчённый Chromium Headless Shell расширений не умеет — нужен полный Chromium.
const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  headless: true,
  ...(process.env.KAD_CHROMIUM ? { executablePath: process.env.KAD_CHROMIUM } : { channel: 'chromium' }),
  args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`]
});
let failed = false;
try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${id}/app.html`);
  await page.waitForSelector('body.ext');
  console.log(`страница расширения открыта · ${sec()}`);

  await page.click('#btnNew');
  await page.fill('#dateInput', filed);
  await page.dispatchEvent('#dateInput', 'change');
  await page.fill('#urlInput', url);
  await page.dispatchEvent('#urlInput', 'input');
  await page.click('#btnFetch');
  await page.waitForFunction(() => {
    const t = document.getElementById('pasteEcho').textContent;
    return /к спору относятся|не удалось/i.test(t) && !document.getElementById('btnFetch').disabled;
  }, null, { timeout: 180000 });
  const echo = await page.textContent('#pasteEcho');
  const counts = echo.match(/В карточке (\d+) .*?относятся (\d+)/);
  console.log(`загрузка карточки: ${counts ? `документов ${counts[1]}, в споре ${counts[2]}` : 'не удалась — ' + echo.slice(0, 200)} · ${sec()}`);
  if (!counts) throw new Error('карточка не загружена');
  console.log(`стадия: ${await page.textContent('#tiles .big')}`);

  await page.click('#btnSave');
  await page.waitForFunction(() => /^#d=/.test(location.hash));
  await page.click('#btnList');
  await page.waitForSelector('.drow');
  await page.check('#setPdf');
  await page.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings?.pdfTexts === true);

  await page.click('[data-check]');
  await page.waitForFunction(() => !document.querySelector('[data-check][disabled]') && /проверено/.test(document.getElementById('list').textContent), null, { timeout: 600000 });
  const all = await sw.evaluate(() => chrome.storage.local.get(null));
  const st = all[`d:${all.ids[0]}`];
  console.log(`проверка: ошибка ${st.error ? '«' + st.error + '»' : 'нет'}; текстов определений ${Object.keys(st.texts || {}).length}; стадия «${st.summary && st.summary.stageLabel}»; ближайший срок ${st.summary && st.summary.nextDue ? st.summary.nextDue.date : '—'} · ${sec()}`);
  console.log(`ключи хранилища: ${Object.keys(all).map((k) => k.replace(/^d:.*/, 'd:<спор>')).join(', ')}`);
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
