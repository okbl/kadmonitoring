/*
 * Закладка «Спор ← kad»: выполняется на странице kad.arbitr.ru, когда её
 * нажимают. Связывает эту вкладку с сайтом программы: сайт присылает
 * запросы — карточку дела, текст определения, — закладка выполняет их
 * обычными запросами страницы картотеки (с её cookies и пройденной
 * проверкой) и отвечает окну сайта. Больше никуда ничего не отправляет.
 *
 * Страница сайта собирает из этого файла адрес закладки (javascript:…):
 * вместо метки подставляется src/kad-page.js, комментарии убираются,
 * SITE — адрес сайта (источник сообщений), APP — страница программы.
 */
(function (SITE, APP) {
  if (window.__kadSpor) { window.__kadSpor.connect(); return; }
  if (!/(^|\.)kad\.arbitr\.ru$/i.test(location.hostname) && !window.__kadSporTest) {
    alert('Эта закладка работает на странице kad.arbitr.ru: откройте картотеку и нажмите закладку там.');
    return;
  }

  /* @@KADPAGE@@ */
  const K = globalThis.KadPage;

  let partner = null;
  let served = 0;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:340px;padding:12px 14px;' +
    'background:#fff;color:#2a211c;border:1px solid #d9cfc7;border-left:4px solid #8d321f;border-radius:10px;' +
    'box-shadow:0 6px 24px rgba(0,0,0,.18);font:13px/1.45 system-ui,sans-serif';
  document.body.append(box);

  function show() {
    const alive = partner && !partner.closed;
    box.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = 'Обособленный спор';
    const p = document.createElement('div');
    p.textContent = alive
      ? `Вкладка связана с сайтом: через неё сайт загружает карточки kad.arbitr. Не закрывайте её.${served ? ` Загружено: ${served}.` : ''}`
      : 'Сайт программы закрыт.';
    box.append(b, p);
    if (!alive) {
      const a = document.createElement('button');
      a.textContent = 'Открыть сайт';
      a.style.cssText = 'margin-top:6px;padding:4px 10px;border:1px solid #8d321f;border-radius:6px;background:#8d321f;color:#fff;cursor:pointer';
      a.onclick = () => { connect(); };
      box.append(a);
    }
  }

  function hello() {
    if (partner && !partner.closed) partner.postMessage({ kadspor: 1, type: 'hello', v: 1 }, SITE);
  }

  /* Окно сайта: то, что открыло эту вкладку, иначе — новое (нажатие закладки разрешает его открыть). */
  function connect() {
    if (window.opener && !window.opener.closed) partner = window.opener;
    if (!partner || partner.closed) partner = window.open(`${APP}#kad`, 'kadspor-site');
    hello();
    try { partner.focus(); } catch (_) { /* браузер не дал переключить вкладку */ }
    show();
  }

  /* Невидимая рамка открывает страницу картотеки — так браузер проходит её проверку, как во вкладке. */
  function inFrame(path, ready, ms) {
    return new Promise((resolve, reject) => {
      const fr = document.createElement('iframe');
      fr.style.cssText = 'position:fixed;left:-40px;top:0;width:10px;height:10px;opacity:0;border:0';
      fr.src = path;
      document.body.append(fr);
      const t0 = Date.now();
      const tick = setInterval(() => {
        let doc = null;
        try { doc = fr.contentDocument; } catch (_) { doc = null; }
        const got = doc && ready(doc, fr);
        if (got || Date.now() - t0 > ms) {
          clearInterval(tick);
          fr.remove();
          if (got) resolve(got);
          else reject(new Error(doc && /робот|captcha|капч/i.test(doc.body ? doc.body.innerText : '')
            ? 'kad.arbitr просит пройти проверку «вы не робот» — пройдите её в этой вкладке и повторите'
            : 'страница картотеки не открылась вовремя'));
        }
      }, 400);
    });
  }

  async function card(caseId) {
    const path = `/Card/${caseId}`;
    // Эта вкладка и есть карточка — её разметка уже здесь.
    const here = location.pathname.toLowerCase() === path.toLowerCase() && document.querySelector('input.js-instanceId');
    let html = here ? document.documentElement.outerHTML : await (await get(path)).text();
    let ids = K.instancesIn(html);
    if (!ids.length) {
      html = await inFrame(path, (d) => d.querySelector('input.js-instanceId') && d.documentElement.outerHTML, 45000);
      ids = K.instancesIn(html);
    }
    if (!ids.length) throw new Error('на странице карточки нет хронологии дела — возможно, картотека изменила устройство страницы');
    const got = await K.chronology(caseId, ids, '', location.origin + path);
    return { html, items: got.items, pages: got.pages, fails: got.fails };
  }

  const isPdf = (b) => b.byteLength > 4 && String.fromCharCode(...new Uint8Array(b.slice(0, 5))) === '%PDF-';

  /*
   * Проверка картотеки перед PDF («salto»): страница с кодом, который
   * вычисляет hash и отправляет форму POST на адрес файла; ответ — сам файл.
   * Код выполняется в своей невидимой рамке, отправку формы рамка не делает —
   * её поля отдаются сюда, и запрос с ними делает эта страница.
   */
  function solve(html, url) {
    return new Promise((resolve, reject) => {
      const fr = document.createElement('iframe');
      fr.style.cssText = 'position:fixed;left:-40px;top:0;width:10px;height:10px;opacity:0;border:0';
      document.body.append(fr);
      const w = fr.contentWindow;
      let done = false;
      const finish = (body, err) => {
        if (done) return;
        done = true;
        setTimeout(() => fr.remove(), 0);
        if (body) resolve(body); else reject(err || new Error('проверка картотеки перед PDF не пройдена'));
      };
      const grab = (form) => finish(new URLSearchParams(new w.FormData(form)).toString());
      w.HTMLFormElement.prototype.submit = function () { grab(this); };
      w.HTMLFormElement.prototype.requestSubmit = function () { grab(this); };
      w.addEventListener('submit', (e) => { e.preventDefault(); grab(e.target); }, true);
      setTimeout(() => finish(null), 20000);
      try {
        w.document.open();
        try { w.history.replaceState(null, '', url); } catch (_) { /* адрес рамки не важен */ }
        w.document.write(html);
        w.document.close();
      } catch (e) { finish(null, e); }
    });
  }

  /* Сервер документов картотеки иногда отвечает 502/503 — повтор через несколько секунд. */
  async function get(path, opts) {
    for (let i = 0; ; i++) {
      const r = await fetch(path, { credentials: 'include', ...opts });
      if (![502, 503, 504].includes(r.status) || i >= 3) return r;
      await new Promise((ok) => setTimeout(ok, 3000 * (i + 1)));
    }
  }

  async function pdf(url) {
    const path = new URL(url, location.origin).pathname;
    const r = await get(path);
    const b = await r.arrayBuffer();
    if (isPdf(b)) return b;
    const html = new TextDecoder().decode(b);
    if (!/<form\b/i.test(html)) throw new Error('картотека вместо PDF отдала страницу без формы проверки');
    const body = await solve(html, r.url);
    const p = await get(r.url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const pb = await p.arrayBuffer();
    if (isPdf(pb)) return pb;
    throw new Error('картотека не отдала PDF и после проверки');
  }

  addEventListener('message', async (e) => {
    const m = e.data;
    if (e.origin !== SITE || !m || m.kadspor !== 1 || !m.id) return;
    if (e.source && e.source !== partner) { partner = e.source; show(); }
    const reply = (x, transfer) => e.source.postMessage({ kadspor: 1, type: 'result', re: m.id, ...x }, SITE, transfer || []);
    try {
      if (m.type === 'card') {
        const data = await card(m.caseId);
        served++;
        show();
        reply({ ok: true, data });
      } else if (m.type === 'pdf') {
        const data = await pdf(m.url);
        reply({ ok: true, data }, [data]);
      } else {
        reply({ ok: true, data: { v: 1 } });
      }
    } catch (err) {
      reply({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // Сайт перезагрузили — он узнает о вкладке по следующему приветствию.
  setInterval(() => { hello(); if (!partner || partner.closed) show(); }, 2000);
  window.__kadSpor = { connect };
  connect();
})
