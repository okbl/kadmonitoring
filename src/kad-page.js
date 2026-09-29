/*
 * Код для картотеки: инстанции дела и вся хронология через API картотеки —
 * все страницы, все инстанции. Каждая функция самодостаточна (без внешних
 * ссылок): расширение передаёт её во вкладку картотеки, а закладка сайта
 * выполняет на странице картотеки.
 */
(function () {
  /* Инстанции дела в разметке карточки: скрытые поля js-instanceId. */
  function instancesIn(html) {
    const ids = new Set();
    for (const m of html.matchAll(/<input\b[^>]*\bjs-instanceId\b[^>]*>/gi)) {
      const v = m[0].match(/\bvalue\s*=\s*["']([^"']+)["']/i);
      if (v) ids.add(v[1]);
    }
    return [...ids];
  }

  /*
   * Хронология: страница за страницей, пока картотека не скажет, что их
   * больше нет (PagesCount). base — адрес картотеки, если запрос не со её
   * страницы; referrer — страница карточки: без него API отвечает 403.
   * fails — ответы без записей, для разбора неудач (содержания дела в них нет).
   */
  async function chronology(caseId, instances, base = '', referrer = '') {
    const items = [];
    const pages = [];
    const fails = [];
    for (const id of instances) {
      let count = 0;
      for (let page = 1; page <= 200; page++) {
        const url = `${base}/Kad/InstanceDocumentsPage?_=${Date.now()}&id=${encodeURIComponent(id)}&caseId=${encodeURIComponent(caseId)}&perPage=30&page=${page}`;
        const opts = { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01' } };
        if (referrer) opts.referrer = referrer;
        let j = null;
        let why = null;
        try {
          const r = await fetch(url, opts);
          const body = await r.text();
          try { j = JSON.parse(body); } catch (_) { j = null; }
          if (!(j && j.Result && j.Result.Items && j.Result.Items.length)) {
            why = { status: r.status, type: r.headers.get('content-type'), len: body.length,
              sample: j && j.Result && j.Result.Items ? 'пустой список' : body.replace(/\s+/g, ' ').slice(0, 160) };
          }
        } catch (e) { why = { error: String((e && e.message) || e) }; }
        const res = j && j.Result;
        const list = (res && res.Items) || [];
        items.push(...list);
        if (list.length) count = page;
        if (why && page === 1) fails.push(why);
        if (!list.length || page >= ((res && res.PagesCount) || 1)) break;
        await new Promise((ok) => setTimeout(ok, 300));
      }
      pages.push(count);
    }
    return { items, pages, fails };
  }

  globalThis.KadPage = { instancesIn, chronology };
})();
