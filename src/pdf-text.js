/*
 * Текст из PDF судебного акта. Наружу — globalThis.KadPdf. Общий для
 * сервера (pdf.js из node_modules) и расширения (pdf.js в его папке):
 * библиотеку передаёт вызывающий код.
 *
 * Акты картотеки — PDF с текстовым слоем, поэтому хватает извлечения
 * текста, без распознавания. Строки собираются по вертикальной координате:
 * pdf.js отдаёт текст кусками, и без этого «О П Р Е Д Е Л И Л:» и даты
 * рвутся посередине.
 */
(function () {
  'use strict';

  async function text(getDocument, bytes) {
    const task = getDocument({
      data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0
    });
    const doc = await task.promise;
    const out = [];
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        let line = '';
        let lastY = null;
        for (const it of tc.items) {
          if (typeof it.str !== 'string') continue;
          const y = it.transform ? it.transform[5] : lastY;
          if (lastY !== null && y !== null && Math.abs(y - lastY) > 2.5) {
            out.push(line);
            line = '';
          }
          line += it.str;
          lastY = y;
          if (it.hasEOL) { out.push(line); line = ''; lastY = null; }
        }
        if (line) out.push(line);
        page.cleanup();
      }
    } finally {
      await task.destroy();
    }
    return out.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  }

  const isPdf = (b) => !!b && b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

  globalThis.KadPdf = { text, isPdf };
})();
