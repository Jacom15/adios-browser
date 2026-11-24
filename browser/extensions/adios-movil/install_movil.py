# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Put the AdiOS Móvil helpers next to firefox.exe.

Usage: python install_movil.py <dir containing firefox.exe>

- distribution/scrcpy/: adb.exe and scrcpy-server from scrcpy (Apache 2.0),
  which show and control the Android phone. The release is pinned and
  checked against its SHA-256 before use; downloads are cached in
  ~/.mozbuild/adios-movil.
- distribution/movil-puente.exe: the bridge between the Móvil panel and the
  phone, compiled from puente/movil-puente.cs with the C# compiler that ships
  with Windows (.NET Framework 4.x).

Files in distribution/ are included in the packages, the installer and the
updates.
"""

import hashlib
import io
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

VERSION = "v5.0.1"
URL = (
    "https://github.com/Genymobile/scrcpy/releases/download/"
    f"{VERSION}/scrcpy-win64-{VERSION}.zip"
)
SHA256 = "b12a2c4ee8be317422451fc7dcf8ee20a71b5ea7ef9ad73ddd825a25316227a5"
CACHE = Path.home() / ".mozbuild" / "adios-movil" / f"scrcpy-win64-{VERSION}.zip"

# Only what the bridge uses: adb and the scrcpy server it pushes to the phone.
KEEP = {"adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll", "scrcpy-server", "LICENSE.txt"}

SOURCE = Path(__file__).resolve().parent / "puente" / "movil-puente.cs"
CSC = (
    Path(os.environ.get("WINDIR", r"C:\Windows"))
    / "Microsoft.NET"
    / "Framework64"
    / "v4.0.30319"
    / "csc.exe"
)


def cached_archive():
    if CACHE.exists():
        data = CACHE.read_bytes()
        if hashlib.sha256(data).hexdigest() == SHA256:
            return data
    print(f"Descargando scrcpy {VERSION}...")
    request = urllib.request.Request(URL, headers={"User-Agent": "adios-build"})
    with urllib.request.urlopen(request) as response:
        data = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != SHA256:
        sys.exit(f"La huella de scrcpy no coincide ({digest}); no se instala.")
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_bytes(data)
    return data


def install_scrcpy(target):
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    with zipfile.ZipFile(io.BytesIO(cached_archive())) as archive:
        for info in archive.infolist():
            # The release zip keeps everything under one "scrcpy-win64-vX/" folder.
            name = Path(info.filename).name
            if not info.is_dir() and name in KEEP:
                (target / name).write_bytes(archive.read(info))
    missing = KEEP - {p.name for p in target.iterdir()}
    if missing:
        sys.exit(f"Faltan archivos en el paquete de scrcpy: {', '.join(sorted(missing))}")
    print(f"scrcpy {VERSION} (adb y servidor) instalado en {target}")


def build_bridge(target):
    if not CSC.exists():
        sys.exit(f"No se encuentra el compilador de C# de Windows en {CSC}")
    subprocess.run(
        [
            str(CSC),
            "/nologo",
            "/codepage:65001",
            "/target:winexe",
            "/optimize+",
            f"/out:{target}",
            str(SOURCE),
        ],
        check=True,
    )
    print(f"Puente de Móvil compilado en {target}")


def main(install_dir):
    dist = Path(install_dir) / "distribution"
    dist.mkdir(exist_ok=True)
    install_scrcpy(dist / "scrcpy")
    build_bridge(dist / "movil-puente.exe")


if __name__ == "__main__":
    main(sys.argv[1])
