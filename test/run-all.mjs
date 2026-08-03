#!/usr/bin/env node
/*
 * gov-a11y - Accessibility (WCAG) scanner for Link.it web consoles
 * https://github.com/link-it/gov-a11y
 *
 * Copyright (c) 2025-2026 Link.it srl (https://link.it).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3, as published by
 * the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

// Runner della suite: esegue in sequenza le suite di test e riepiloga. Exit != 0 se una fallisce.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const SUITES = [
  ['unit',        'unit.test.mjs'],         // funzioni pure + reporter + gate
  ['detection',   'detection.test.mjs'],    // livelli 2/3 (accessibility tree + screen reader)
  ['integration', 'integration.test.mjs'],  // motore end-to-end su mock server
];

let failed = 0;
for (const [label, file] of SUITES) {
  console.log(`\n═══ ${label} (${file}) ═══`);
  const r = spawnSync(process.execPath, [join(dir, file)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log(`   ↳ ${label}: FALLITA (exit ${r.status})`); }
}
console.log(failed ? `\n❌ ${failed}/${SUITES.length} suite fallite` : `\n✅ tutte le ${SUITES.length} suite superate`);
process.exit(failed ? 1 : 0);
