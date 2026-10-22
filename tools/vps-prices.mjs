/*
 * Цены дешёвых VPS у российских хостингов: страницы тарифов в настоящем
 * браузере (таблицы цен рисуются скриптом), в журнал — строки с ценой и
 * объёмом памяти.
 */
import { chromium } from 'playwright-core';

const PAGES = [
  'https://ruvds.com/ru-rub/pricing',
  'https://hostkey.ru/vps/',
  'https://timeweb.cloud/services/cloud-servers',
  'https://vdsina.ru/',
  'https://firstvds.ru/',
  'https://aeza.net/ru',
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
    for (let i = 0; i < lines.length && out.length < 12; i++) {
      if (!/₽|руб/i.test(lines[i])) continue;
      const win = lines.slice(Math.max(0, i - 10), i + 3).join(' | ');
      out.push(win.slice(0, 420));
    }
    console.log(out.length ? [...new Set(out)].join('\n') : `(цен не найдено; заголовок: ${await page.title()})`);
    // Бесплатный уровень и бонусы — отдельной строкой, если упомянуты.
    const free = lines.filter((l) => /free tier|бесплатн|бонус/i.test(l)).slice(0, 6);
    if (free.length) console.log('— про бесплатное:', free.join(' | ').slice(0, 500));
  } catch (e) {
    console.log('ошибка:', e.message.split('\n')[0]);
  } finally {
    await page.close();
  }
}
await browser.close();
