/* Модули страницы в Node: они выставляют себя в globalThis. */
import '../src/dates.js';
import '../src/kad.js';
import '../src/rules.js';
import '../src/dispute.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const { KadDates: D, KadCard: C, KadRules: R, KadDispute: X } = globalThis;

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');
