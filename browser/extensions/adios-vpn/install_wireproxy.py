# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Put wireproxy (userspace WireGuard client, ISC license) next to firefox.exe.

Usage: python install_wireproxy.py <dir containing firefox.exe>

AdiOS VPN runs <install dir>/distribution/wireproxy.exe for WireGuard
connections; files in distribution/ are included in the packages, the
installer and the updates. The release is pinned and checked against its
SHA-256 before use; downloads are cached in ~/.mozbuild/adios-vpn.
"""

import hashlib
import io
import shutil
import sys
import tarfile
import urllib.request
from pathlib import Path

VERSION = "v1.1.3"
URL = (
    "https://github.com/pufferffish/wireproxy/releases/download/"
    f"{VERSION}/wireproxy_windows_amd64.tar.gz"
)
SHA256 = "bce041ea9fe0f8a3351301dcbe29cdf6a523bb25cf9c62f17ebb5699a8051d0f"
CACHE = Path.home() / ".mozbuild" / "adios-vpn" / f"wireproxy-{VERSION}.exe"


def cached_wireproxy():
    if CACHE.exists():
        return CACHE
    print(f"Descargando wireproxy {VERSION}...")
    request = urllib.request.Request(URL, headers={"User-Agent": "adios-build"})
    with urllib.request.urlopen(request) as response:
        archive = response.read()
    digest = hashlib.sha256(archive).hexdigest()
    if digest != SHA256:
        sys.exit(f"La huella de wireproxy no coincide ({digest}); no se instala.")
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        exe = tar.extractfile("wireproxy.exe").read()
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_bytes(exe)
    return CACHE


def main(install_dir):
    target = Path(install_dir) / "distribution" / "wireproxy.exe"
    target.parent.mkdir(exist_ok=True)
    shutil.copy2(cached_wireproxy(), target)
    print(f"wireproxy {VERSION} instalado en {target}")


if __name__ == "__main__":
    main(sys.argv[1])
