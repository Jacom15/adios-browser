#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Publica una versión nueva de AdiOS Browser: todos los AdiOS instalados la
# reciben desde el menú ☰ («Reiniciar para actualizar»).
#
# Uso (consola de MozillaBuild): browser/branding/adios/publicar.sh [--sin-descargar]
#   --sin-descargar  publica sin traer antes la última versión estable de
#                    Firefox ni de uBlock Origin (los cambios de AdiOS en GitHub
#                    sí se traen siempre).

set -euo pipefail

cd "$(dirname "$0")/../../.."
export PATH="$HOME/.cargo/bin:$HOME/.mozbuild/bin:/c/Program Files/GitHub CLI:$PATH"
OBJ=obj-x86_64-pc-windows-msvc

paso() { echo; echo "==> $*"; }

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Hay cambios sin guardar en git; guárdalos (commit) antes de publicar."
  exit 1
fi
if [ ! -f "$HOME/.adios-firma/key4.db" ]; then
  echo "No están las claves de firma en ~/.adios-firma; sin ellas no se puede publicar."
  exit 1
fi

# Se combina con merge (sin reescribir la historia): la rama adios también
# recibe cambios desde otros equipos.
paso "Trayendo los cambios de AdiOS de GitHub"
git fetch adios adios
if ! git merge --no-edit adios/adios; then
  git merge --abort
  echo "Los cambios de GitHub chocan con los de este equipo: hay que resolverlo a mano."
  exit 1
fi

if [ "${1:-}" != "--sin-descargar" ]; then
  paso "Trayendo la última versión estable de Firefox"
  git fetch origin release
  if ! git merge --no-edit origin/release; then
    git merge --abort
    echo "Los cambios de Mozilla chocan con los de AdiOS: hay que resolverlo a mano."
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

paso "Compilando"
# Cargo creates its target directory with an atomic rename, which fails with
# "Acceso denegado" while an antivirus scans the temporary directory.
mkdir -p "$OBJ/x86_64-pc-windows-msvc"
MOZ_BUILD_DATE=$(date +%Y%m%d%H%M%S)
export MOZ_BUILD_DATE
./mach build
mkdir -p "$OBJ/dist/bin/distribution"
cp browser/branding/adios/distribution.ini "$OBJ/dist/bin/distribution/"
python3 browser/extensions/adios-vpn/install_wireproxy.py "$OBJ/dist/bin"
python3 browser/extensions/adios-movil/install_movil.py "$OBJ/dist/bin"

paso "Comprobando que el bloqueador funciona"
python3 browser/extensions/ublock/verify_ublock.py

paso "Empaquetando (inglés y español) y creando el instalador"
./mach package-multi-locale --locales en-US es-ES

paso "Subiendo el código a GitHub"
git push adios HEAD:adios

paso "Firmando y publicando la actualización"
python3 browser/branding/adios/publicar.py
