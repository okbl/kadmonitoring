/*
 * Текст из PDF судебного акта на сервере: pdf.js из node_modules и общий
 * с расширением разбор строк (src/pdf-text.js).
 */
import '../src/pdf-text.js';

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
  return globalThis.KadPdf.text(getDocument, new Uint8Array(buf));
}
