/*
 * Проба: как устроен вход на kad.arbitr — куда ведёт кнопка входа, какие
 * поля и запросы, какие cookies ставит картотека (имена, httpOnly, срок).
 * Вход не выполняется; печатается только устройство страниц, без данных дел.
 *
 * node tools/login-probe.mjs <ссылка на карточку>
 */
import { chromium } from 'playwright-core';

const [card] = process.argv.slice(2);
const anon = (s) => String(s || '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<id>').replace(/([?&](?:[a-z_]*token|code|state|nonce|sid|session)[a-z_]*=)[^&#]+/gi, '$1<…>');
const log = (k, v) => console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

const browser = await chromium.launch({ headless: true, channel: 'chromium', ignoreDefaultArgs: ['--enable-automation'], args: ['--disable-blink-features=AutomationControlled'] });
const tmp = await browser.newPage();
const ua = (await tmp.evaluate(() => navigator.userAgent)).replace(/HeadlessChrome/g, 'Chrome');
await tmp.close();
const ctx = await browser.newContext({ userAgent: ua, locale: 'ru-RU' });
const cookies = async () => (await ctx.cookies()).map((c) => `${c.domain} ${c.name}${c.httpOnly ? ' httpOnly' : ''}${c.expires > 0 ? ` ${Math.round((c.expires * 1000 - Date.now()) / 86400000)}д` : ' сессия'}`);

try {
  const page = await ctx.newPage();
  const reqs = [];
  page.on('request', (r) => { if (!/\.(css|png|jpg|gif|svg|woff2?|ico)(\?|$)/i.test(r.url()) && !/google|yandex|metrika|gtm|analytics/i.test(r.url())) reqs.push(`${r.method()} ${anon(r.url())}`); });
  await page.goto(card, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('input.js-instanceId', { state: 'attached', timeout: 60000 }).catch(() => null);
  log('cookies до входа', await cookies());

  // Кнопки и ссылки входа, подписки на дело.
  const found = await page.evaluate(() => [...document.querySelectorAll('a,button,span,div')]
    .filter((e) => e.children.length === 0 && /^(вход|войти|авториз|личный кабинет|подпис|отслеж|мой арбитр|госуслуг)/i.test((e.innerText || '').trim()))
    .slice(0, 15)
    .map((e) => ({ tag: e.tagName, text: e.innerText.trim().slice(0, 40), cls: e.className && String(e.className).slice(0, 80), href: e.getAttribute('href'), onclick: (e.getAttribute('onclick') || '').slice(0, 80), visible: !!(e.offsetWidth || e.offsetHeight) })));
  log('элементы входа и подписки', found.map((x) => ({ ...x, href: x.href && x.href.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<id>') })));

  // Нажать «Вход» и посмотреть, что открывается: окно, переход, поля.
  const login = page.locator('a,button,span').filter({ hasText: /^\s*(Вход|Войти)\s*$/i }).first();
  if (await login.count()) {
    const before = reqs.length;
    const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null), login.click({ timeout: 8000 }).catch((e) => log('нажатие', e.message.split('\n')[0]))]);
    await page.waitForTimeout(4000);
    const target = popup || page;
    if (popup) await popup.waitForLoadState('domcontentloaded').catch(() => null);
    log('после нажатия «Вход»: окно', popup ? 'новое' : 'то же');
    log('адрес', anon(target.url()));
    log('запросы после нажатия', reqs.slice(before, before + 25));
    const form = await target.evaluate(() => ({
      title: document.title,
      inputs: [...document.querySelectorAll('input,select,textarea')].filter((i) => i.type !== 'hidden' && (i.offsetWidth || i.offsetHeight)).map((i) => `${i.name || i.id}:${i.type}:${(i.placeholder || '').slice(0, 30)}`),
      buttons: [...document.querySelectorAll('button,a,input[type=submit]')].filter((b) => (b.offsetWidth || b.offsetHeight) && /вход|войти|госуслуг|есиа|esia|логин|продолж|получить код/i.test(b.innerText || b.value || '')).map((b) => `${(b.innerText || b.value).trim().slice(0, 40)} → ${(b.getAttribute('href') || '').slice(0, 100)}`),
      frames: [...document.querySelectorAll('iframe')].map((f) => (f.src || '').replace(/[?#].*/, ''))
    })).catch((e) => ({ error: e.message.split('\n')[0] }));
    log('форма входа', form);
    // Кнопка «Госуслуги», если есть: куда ведёт (без входа).
    const esia = target.locator('a,button').filter({ hasText: /госуслуг/i }).first();
    if (await esia.count()) {
      const r0 = reqs.length;
      await esia.click({ timeout: 8000 }).catch(() => null);
      await target.waitForTimeout(5000);
      log('после «Госуслуги»: адрес', anon(target.url()).replace(/\?.*/, '?…'));
      log('запросы', reqs.slice(r0, r0 + 10).map((u) => u.replace(/\?.*/, '?…')));
    }
  } else {
    log('кнопка «Вход»', 'не найдена');
  }
  log('cookies после', await cookies());
} catch (e) {
  console.log('ОШИБКА:', e.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
