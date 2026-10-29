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

/* Passi 'script' del target GovHub: le viste del Modello AI che dipendono dai dati dell'utente.

   Le citazioni ci sono solo nelle risposte che hanno usato uno strumento: quale conversazione le
   abbia non si sa a priori (le conversazioni sono dell'utente e cambiano). Lo script apre le
   conversazioni della sidebar, dalla piu' recente, finche' ne trova una con almeno un segno di
   citazione nel testo. Li' il clic sul segno apre un popover accanto al testo (banca dati di
   provenienza), e il suo rimando apre il pannello laterale sulla citazione: si scansionano
   tutti e due gli stati. Solo lettura:
   nessun messaggio inviato, nessuna conversazione modificata. */

const pausa = ms => new Promise(r => setTimeout(r, ms));

/** Voci della sidebar (elenco esteso, non quello compresso a icone). */
const CONVERSAZIONI = "lnk-ai-model-sidebar button:has(ng-icon[name='lucideMessageSquare']) >> visible=true";

/** Segno di citazione nella risposta (vedi CITE_CLASS in services/citation-marks.ts). */
const CITAZIONE = 'button.lnk-cite';

export async function citazioneAperta({ page, scan, args }) {
  const massimo = Number(args.massimo) || 15;
  await page.waitForSelector(CONVERSAZIONI, { timeout: 15000 });
  const totale = Math.min(await page.locator(CONVERSAZIONI).count(), massimo);

  for (let i = 0; i < totale; i++) {
    await page.locator(CONVERSAZIONI).nth(i).click();
    // Lo storico arriva dopo il click: si aspetta che lo spinner sparisca e il testo si assesti
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await pausa(1500);
    if ((await page.locator(CITAZIONE).count()) === 0) continue;

    await page.locator(CITAZIONE).first().click();
    await page.waitForSelector('lnk-citation-popover [role=dialog]', { timeout: 10000 });
    await pausa(500);
    // Il Tab chiuderebbe il popover: lo stato si analizza fermo. Solo il popover: copre il pezzo
    // citato, che con il testo intorno e' analizzato a riposo nella vista 'conversazione'
    await scan('popover-citazione', { keyboard: false, include: 'lnk-citation-popover' });

    await page.locator('lnk-citation-popover button').last().click();
    await page.waitForSelector('lnk-conversation-side-panel', { timeout: 10000 });
    await pausa(1000);
    // Solo il pannello: in modalita' sovrapposta copre i fumetti della conversazione
    await scan('citazione-aperta', { include: 'lnk-conversation-side-panel' });
    return;
  }

  console.log(`    nessuna citazione nelle prime ${totale} conversazioni: vista 'citazione-aperta' non analizzata`);
}

/** Pannello File con un testo nel campo di ricerca: la ricerca la fa il server (GET .../files?name=). */
export async function cercaFile({ page, scan, args }) {
  const campo = page.locator('lnk-conversation-side-panel input[type=search]');
  if ((await campo.count()) === 0) {
    console.log('    nessun file nella conversazione: campo di ricerca assente, vista non analizzata');
    return;
  }
  await campo.fill(args.testo || 'pdf');
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await pausa(800);
  await scan('pannello-file-ricerca', { include: 'lnk-conversation-side-panel' });
  await campo.fill('');
  await pausa(500);
}
