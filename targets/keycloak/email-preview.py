#
# gov-a11y - Accessibility (WCAG) scanner for Link.it web consoles
# https://github.com/link-it/gov-a11y
#
# Copyright (c) 2025-2026 Link.it srl (https://link.it).
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License version 3, as published by
# the Free Software Foundation.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.
#
"""Anteprima statica delle email dei temi Keycloak (govdesk, govdesk-noviservice), senza Keycloak.

Riproduce a mano quello che fa FreeMarker: template.ftl del tema + corpo del messaggio italiano
con parametri di esempio. Le immagini del tema vengono copiate accanto alle pagine (il basePath
punta alla produzione). E' un'anteprima della grafica, non l'email reale inviata da Keycloak.

Uso: python3 targets/keycloak/email-preview.py <repo dei temi> [cartella di uscita]
     (default report-keycloak-email, poi aprire index.html)
"""
import html
import pathlib
import re
import shutil
import sys

if len(sys.argv) < 2:
    sys.exit(__doc__)
TEMI_DIR = pathlib.Path(sys.argv[1]).expanduser()
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "report-keycloak-email")
OUT.mkdir(parents=True, exist_ok=True)


def leggi_properties(path):
    props = {}
    if not path.exists():
        return props
    righe = path.read_text(encoding="utf-8").splitlines()
    buf = ""
    for r in righe:
        if not buf and (not r.strip() or r.lstrip().startswith(("#", "!"))):
            continue
        if r.endswith("\\") and not r.endswith("\\\\"):
            buf += r[:-1].lstrip() if buf else r[:-1]
            continue
        r = (buf + r.lstrip()) if buf else r
        buf = ""
        m = re.match(r"\s*([^=:\s]+)\s*[=:]\s*(.*)", r)
        if m:
            props[m.group(1)] = re.sub(r"\\u([0-9a-fA-F]{4})", lambda x: chr(int(x.group(1), 16)), m.group(2))
    return props


def message_format(testo, params):
    # Java MessageFormat semplificato: '' -> ', {n} -> parametro
    testo = re.sub(r"\{(\d+)\}", lambda m: str(params[int(m.group(1))]) if int(m.group(1)) < len(params) else m.group(0), testo)
    return testo.replace("''", "'")


LINK = "https://govdesk.example.it/realms/ente/login-actions/action-token?key=esempio"
EMAIL = {
    "password-reset": ("passwordResetBodyHtml", [LINK, 720, "GovDesk", "12 ore"]),
    "email-verification": ("emailVerificationBodyHtml", [LINK, 720, "GovDesk", "12 ore"]),
    "executeActions": ("executeActionsBodyHtml", [LINK, 720, "ente", "Aggiornamento password, Verifica dell'indirizzo email", "12 ore", "https://govdesk.example.it"]),
}

voci = []
for tema in ("govdesk", "govdesk-noviservice"):
    msg = leggi_properties(TEMI_DIR / "govdesk/email/messages/messages_it.properties")
    msg.update(leggi_properties(TEMI_DIR / tema / "email/messages/messages_it.properties"))
    tpl = (TEMI_DIR / tema / "email/html/template.ftl").read_text(encoding="utf-8")
    corpo_tpl = re.search(r"<#macro emailLayout>\n?(.*)</#macro>", tpl, re.S).group(1)
    risorse = OUT / "risorse" / tema
    shutil.rmtree(risorse, ignore_errors=True)
    shutil.copytree(TEMI_DIR / tema / "email/resources", risorse)
    img_dir = f"risorse/{tema}"
    for nome, (chiave, params) in EMAIL.items():
        corpo = message_format(msg[chiave], params)
        pagina = corpo_tpl.replace("<#nested>", corpo)
        pagina = pagina.replace("${locale.language}", "it")
        pagina = pagina.replace("${properties.basePath}${url.resourcesPath}", img_dir)
        assert "${" not in pagina and "<#" not in pagina, (tema, nome, re.findall(r"\$\{[^}]*\}|<#[^>]*>", pagina))
        f = OUT / f"{tema}-{nome}.html"
        f.write_text("<!DOCTYPE html>\n" + pagina, encoding="utf-8")
        voci.append((tema, nome, f.name))

righe = "\n".join(f'<li><a href="{html.escape(f)}">{html.escape(t)} — {html.escape(n)}</a></li>' for t, n, f in voci)
(OUT / "index.html").write_text(f"""<!DOCTYPE html>
<html lang="it"><head><meta charset="utf-8"><title>Anteprima email temi Keycloak</title></head>
<body style="font-family:Arial,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem">
<h1>Anteprima email temi Keycloak</h1>
<p>Generate da template.ftl + messages_it.properties con parametri di esempio. Le immagini sono quelle locali del tema.</p>
<ul>
{righe}
</ul>
</body></html>
""", encoding="utf-8")
print("\n".join(str(OUT / f) for _, _, f in voci))
