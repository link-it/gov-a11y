#!/usr/bin/env bash
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
# Scansione di accessibilita' della sola govwayMonitor: richiama scan.sh con '--only monitor'.
# Accetta le stesse opzioni di scan.sh (--full, --base, --out, --product-version);
# credenziali da A11Y_MONITOR_USER (default operatore), A11Y_MONITOR_PASS.
#
exec "$(dirname "${BASH_SOURCE[0]}")/scan.sh" --only monitor "$@"
