# Licenze di terze parti

`gov-a11y` usa a runtime le seguenti librerie di terze parti (installate via `npm`, non
ridistribuite nei sorgenti di questo repository). Tutte hanno licenze **compatibili con la GPLv3**
sotto cui è rilasciato `gov-a11y`. Per ciascuna sono riportati versione, licenza (SPDX) e il testo
della licenza nella rispettiva cartella.

| Libreria | Versione | Licenza (SPDX) | Uso | Cartella |
|---|---|---|---|---|
| playwright (+ playwright-core) | 1.62.0 | Apache-2.0 | pilotaggio browser (navigazione, login) | [`playwright-1.62.0/`](playwright-1.62.0/LICENSE) |
| axe-core | 4.12.1 | MPL-2.0 | motore regole WCAG | [`axe-core-4.12.1/`](axe-core-4.12.1/LICENSE) |
| @axe-core/playwright | 4.12.1 | MPL-2.0 | integrazione axe-core ↔ Playwright | [`axe-core-playwright-4.12.1/`](axe-core-playwright-4.12.1/LICENSE) |
| lighthouse | 12.8.2 | Apache-2.0 | punteggio accessibilità (opzionale) | [`lighthouse-12.8.2/`](lighthouse-12.8.2/LICENSE) |
| @guidepup/virtual-screen-reader | 0.30.1 | MIT | virtual screen reader (opzionale) | [`guidepup-virtual-screen-reader-0.30.1/`](guidepup-virtual-screen-reader-0.30.1/LICENSE) |
| jsdom | 25.0.1 | MIT | supporto DOM per lo screen reader (opzionale) | [`jsdom-25.0.1/`](jsdom-25.0.1/LICENSE) |

Note di compatibilità:
- **MIT** → permissiva, includibile in un'opera GPLv3.
- **Apache-2.0** → compatibile con **GPLv3** (la clausola brevetti è gestita da GPLv3).
- **MPL-2.0** → ha una clausola esplicita di compatibilità GPL (§3.3).

Le dipendenze **transitive** (non elencate qui) mantengono le proprie licenze, consultabili nei
rispettivi pacchetti sotto `node_modules/` dopo `npm install`.
