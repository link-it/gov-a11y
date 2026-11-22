#!/usr/bin/env node
/*
 * Ricompone targets.govway.json, il config con le due console in un solo file, come somma dei due
 * config separati: targets.govway_monitor.json e targets.govway_console.json. Si modificano solo
 * i file separati e poi si lancia:
 *
 *   node targets/govway/componi-targets.mjs
 *
 * I 'defaults' dei due file devono coincidere, perche' nel file combinato sono uno solo: se
 * divergono lo script si ferma e dice quali chiavi. Con '--verifica' non scrive nulla e termina
 * con errore se il file combinato non e' aggiornato.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const DIR = dirname(fileURLToPath(import.meta.url));
const leggi = (nome) => JSON.parse(readFileSync(join(DIR, nome), 'utf8'));

const monitor = leggi('targets.govway_monitor.json');
const console_ = leggi('targets.govway_console.json');

const diverse = [...new Set([...Object.keys(monitor.defaults), ...Object.keys(console_.defaults)])]
  .filter(k => !isDeepStrictEqual(monitor.defaults[k], console_.defaults[k]));
if (diverse.length) {
  console.error(`I 'defaults' dei due file separati sono diversi (${diverse.join(', ')}): allineali prima di comporre.`);
  process.exit(1);
}

const composto = {
  $app: monitor.$app,
  $generato: "File generato da componi-targets.mjs come somma di targets.govway_monitor.json e targets.govway_console.json: non modificarlo a mano, modifica i file separati e rilancia lo script.",
  $defaultsNote: "Parametri dichiarativi validi per entrambi i target, identici nei due file separati. La CLI ha sempre la precedenza (CLI > target > defaults > built-in).",
  defaults: monitor.defaults,
  $comment: monitor.$comment,
  monitor: monitor.monitor,
  console: console_.console,
};
const testo = JSON.stringify(composto, null, 2) + '\n';
const destinazione = join(DIR, 'targets.govway.json');

if (process.argv.includes('--verifica')) {
  const attuale = readFileSync(destinazione, 'utf8');
  if (attuale !== testo) {
    console.error('targets.govway.json non e\' aggiornato: lancia node targets/govway/componi-targets.mjs');
    process.exit(1);
  }
  console.log('targets.govway.json aggiornato');
} else {
  writeFileSync(destinazione, testo);
  console.log(`targets.govway.json ricomposto: monitor (${(composto.monitor.pages || []).length} pagine, ${(composto.monitor.flows || []).length} flow), console (${(composto.console.pages || []).length} pagine, ${(composto.console.flows || []).length} flow)`);
}
