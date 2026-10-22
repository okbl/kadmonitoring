/*
 * Цены дешёвых VPS у российских хостингов: страницы тарифов в настоящем
 * браузере (таблицы цен рисуются скриптом), в журнал — строки с ценой и
 * объёмом памяти.
 */
import { chromium } from 'playwright-core';

const PAGES = [
  'https://timeweb.cloud/services/cloud-servers',
  'https://timeweb.cloud/price',
  'https://beget.com/ru/vps',
  'https://vdsina.com/ru/cloud-servers',
  'https://firstvds.ru/products/vds_vps',
  'https://aeza.net/ru/virtual-servers',
  'https://ruvds.com/ru-rub/pricing',
  'https://www.reg.ru/vps/',
  'https://selectel.ru/prices/',
  'https://hostkey.ru/vps/',
  'https://sprinthost.ru/vps.html',
  'https://cloud.ru/products/evolution-compute'
];

const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1400, height: 2200 } });
for (const url of PAGES) {
  console.log(`=================== ${url}`);
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(6000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(2000);
    const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    // Карточки тарифов: соседние строки с памятью, процессором, диском и ценой — склеиваем окном.
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i < lines.length && out.length < 25; i++) {
      if (!/₽|руб/i.test(lines[i])) continue;
      const win = lines.slice(Math.max(0, i - 6), i + 2).join(' | ');
      if (/(ГБ|GB|Гб)\s*(RAM|ОЗУ|памят)|RAM|ОЗУ|памят/i.test(win) || /\b\d+\s*(ГБ|GB)\b/.test(win)) out.push(win.slice(0, 300));
    }
    console.log(out.length ? [...new Set(out)].join('\n') : `(цен не найдено; заголовок: ${await page.title()})`);
  } catch (e) {
    console.log('ошибка:', e.message.split('\n')[0]);
  } finally {
    await page.close();
  }
}
await browser.close();
