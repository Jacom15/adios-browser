#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Actualiza AdiOS Browser: trae la ultima version estable de Firefox
# y de uBlock Origin, recompila, comprueba que el bloqueador funciona y lo
# instala en %LOCALAPPDATA%\FirefoxSinAnuncios (la carpeta conserva su nombre
# para que Windows siga asociando el mismo perfil).
#
# Uso (desde la consola de MozillaBuild): browser/extensions/ublock/actualizar.sh
#   --sin-descargar   recompila e instala el codigo actual sin actualizarlo

set -euo pipefail

cd "$(dirname "$0")/../../.."
export PATH="$HOME/.cargo/bin:$HOME/.mozbuild/bin:$PATH"
INSTALL_DIR="$(cygpath -u "$LOCALAPPDATA")/FirefoxSinAnuncios"

paso() { echo; echo "==> $*"; }

if [ "${1:-}" != "--sin-descargar" ]; then
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "Hay cambios sin guardar en el codigo; no actualizo para no perderlos."
    exit 1
  fi

  paso "Descargando la ultima version estable de Firefox"
  git fetch origin release
  if ! git rebase origin/release; then
    git rebase --abort
    echo "Los cambios de Mozilla chocan con el bloqueador."
    echo "No se ha tocado nada: tu Firefox instalado sigue igual. Hay que resolverlo a mano."
    exit 1
  fi

  paso "Actualizando uBlock Origin"
  python3 browser/extensions/ublock/update_ublock.py
  if [ -n "$(git status --porcelain browser/extensions/ublock/extension)" ]; then
    version=$(python3 -c "import json; print(json.load(open('browser/extensions/ublock/extension/manifest.json'))['version'])")
    git add -A browser/extensions/ublock/extension
    git commit -q -m "Actualizar uBlock Origin a $version"
  fi
fi

paso "Compilando (unos minutos)"
# Cargo creates its target directory with an atomic rename, which fails with
# "Acceso denegado" while the antivirus is scanning the temporary directory.
# If the directory already exists, Cargo skips that step.
mkdir -p obj-x86_64-pc-windows-msvc/x86_64-pc-windows-msvc
./mach build

paso "Comprobando que el bloqueador funciona"
python3 browser/extensions/ublock/verify_ublock.py

paso "Empaquetando con el idioma espanol"
./mach package-multi-locale --locales en-US es-ES
package=$(ls -t obj-*/dist/firefox-*.zip | head -1)

paso "Instalando en $INSTALL_DIR"
if powershell.exe -NoProfile -Command \
    "if (Get-Process firefox -ErrorAction SilentlyContinue | Where-Object { \$_.Path -like '*FirefoxSinAnuncios*' }) { exit 0 } else { exit 1 }"; then
  echo "Cierra AdiOS Browser y vuelve a ejecutar: $0 --sin-descargar"
  exit 1
fi
python3 - "$package" "$INSTALL_DIR" <<'EOF'
import shutil, sys, zipfile
from pathlib import Path

package, install_dir = sys.argv[1], Path(sys.argv[2])
staging = install_dir.with_name(install_dir.name + ".nuevo")
shutil.rmtree(staging, ignore_errors=True)
with zipfile.ZipFile(package) as z:
    z.extractall(staging)
# The zip contains a top-level firefox/ directory.
new_build = staging / "firefox"
distribution = new_build / "distribution"
distribution.mkdir(exist_ok=True)
(distribution / "distribution.ini").write_text(
    "[Global]\n"
    "id=adios-browser\n"
    "version=1.0\n"
    "about=AdiOS Browser\n"
    "\n"
    "[Preferences]\n"
    "# Vacio = usar el idioma de Windows.\n"
    'intl.locale.requested=""\n',
    encoding="utf-8",
)
shutil.rmtree(install_dir, ignore_errors=True)
new_build.rename(install_dir)
shutil.rmtree(staging, ignore_errors=True)
print(f"Instalado: {install_dir}")
EOF
python3 browser/extensions/adios-vpn/install_wireproxy.py "$INSTALL_DIR"

paso "Listo"
