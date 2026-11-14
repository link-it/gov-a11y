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

/* Passi 'script' del target GovCat.

   toccaCampi: porta un form nello stato di ERRORE di validazione senza inviarlo. GovCat mostra i
   messaggi ("Campo richiesto") sui campi toccati: si porta il focus su ogni campo visibile, uno
   dopo l'altro, e poi fuori dal form, cosi' che anche l'ultimo risulti toccato. Nessun valore
   scritto, nessun invio: il pulsante Salva resta disabilitato. Il focus si toglie dall'ultimo campo
   con blur(), non con Esc o con un clic: in alcuni form Esc chiude la vista, e un clic puo' cadere
   su un comando. Le tendine (ng-select) che il focus apre si chiudono quando il campo lo perde. */

const CAMPI = 'main input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]):visible, main textarea:visible';

export async function toccaCampi({ page, args }) {
  const campi = page.locator(args.selector || CAMPI);
  const n = Math.min(await campi.count(), Number(args.max) || 30);
  if (!n) throw new Error(`nessun campo da toccare (${args.selector || CAMPI})`);
  for (let i = 0; i < n; i++) await campi.nth(i).focus().catch(() => {});
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.waitForTimeout(Number(args.delayMs) || 1000);
}
