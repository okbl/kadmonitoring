/*
 * Текст из PDF судебного акта. Акты картотеки — PDF с текстовым слоем,
 * поэтому хватает извлечения текста, без распознавания. Строки собираются
 * по вертикальной координате: pdf.js отдаёт текст кусками, и без этого
 * «О П Р Е Д Е Л И Л:» и даты рвутся посередине.
 */
let pdfjs = null;

async function lib() {
  if (pdfjs) return pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (_) {
    throw new Error('не установлен пакет pdfjs-dist — выполните npm install');
  }
  return pdfjs;
}

export async function pdfText(buf) {
  const { getDocument } = await lib();
  const task = getDocument({
    data: new Uint8Array(buf),
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
