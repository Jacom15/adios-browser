# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Publish the packaged AdiOS build: signed update + installer + update.xml.

Run by publicar.sh after `mach package-multi-locale` and `mach build installer`.
The private signing keys live in ~/.adios-firma (never in the repository).
"""

import configparser
import hashlib
import html
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = "Jacom15/adios-browser"
PAGES_URL = "https://jacom15.github.io/adios-browser/"
CHANNEL = "adios"
SIGNING_KEY = "adios-primary"
KEYS_DIR = Path.home() / ".adios-firma"

TOPSRCDIR = Path(__file__).resolve().parents[3]
OBJDIR = TOPSRCDIR / "obj-x86_64-pc-windows-msvc"
DIST = OBJDIR / "dist"
GH = shutil.which("gh") or r"C:\Program Files\GitHub CLI\gh.exe"


def run(*args, **kwargs):
    print("  $", " ".join(str(a) for a in args), flush=True)
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def build_info():
    ini = configparser.ConfigParser()
    ini.read(DIST / "firefox" / "application.ini", encoding="utf-8")
    return ini["App"]["Version"], ini["App"]["BuildID"]


def make_signed_mar(version, build_id, out_dir):
    unsigned = out_dir / "unsigned.mar"
    signed = out_dir / f"AdiOS-{version}-{build_id}.complete.mar"
    env = {
        **os.environ,
        "MAR": str(DIST / "host" / "bin" / "mar.exe"),
        "MOZ_PRODUCT_VERSION": version,
        "MAR_CHANNEL_ID": CHANNEL,
        "XZ": str(Path.home() / ".mozbuild" / "xz" / "xz.exe"),
    }
    run(
        "bash",
        TOPSRCDIR / "tools" / "update-packaging" / "make_full_update.sh",
        "-q",
        unsigned,
        DIST / "firefox",
        "firefox",
        env=env,
    )
    keys = f"sql:{KEYS_DIR}"
    signmar = DIST / "bin" / "signmar.exe"
    run(signmar, "-d", keys, "-n", SIGNING_KEY, "-s", unsigned, signed, cwd=DIST / "bin")
    run(
        signmar,
        "-D",
        TOPSRCDIR / "browser" / "branding" / "adios" / "mar-primary.der",
        "-v",
        signed,
        cwd=DIST / "bin",
    )
    unsigned.unlink()
    return signed


def update_xml(version, build_id, mar, mar_url):
    data = mar.read_bytes()
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<updates>
  <update type="minor" displayVersion="{version}" appVersion="{version}"
          platformVersion="{version}" buildID="{build_id}"
          detailsURL="https://github.com/{REPO}/releases">
    <patch type="complete" URL="{mar_url}" hashFunction="sha512"
           hashValue="{hashlib.sha512(data).hexdigest()}" size="{len(data)}"/>
  </update>
</updates>
"""


def index_html(version, setup_url, setup_size):
    megabytes = round(setup_size / 1_000_000)
    return f"""<!doctype html>
<html lang="es">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AdiOS Browser</title>
<meta name="description" content="Firefox sin anuncios y con VPN integrada. Se actualiza solo.">
<link rel="icon" type="image/png" href="buho.png">
<style>
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; min-height: 100vh; font: 16px/1.55 "Segoe UI", system-ui, sans-serif;
         color: #fbfbfe; background: radial-gradient(circle at 20% 10%, #2a2f8f 0, transparent 45%),
         linear-gradient(135deg, #0d1440, #2c1563) fixed; }}
  main {{ max-width: 640px; margin: 0 auto; padding: 56px 16px 40px; }}
  header {{ text-align: center; }}
  header img {{ width: 112px; height: 112px; }}
  h1 {{ font-size: clamp(34px, 8vw, 48px); line-height: 1.1; margin: 14px 0 8px; letter-spacing: -.02em; }}
  .tag {{ font-size: 19px; color: #d9d6ff; margin: 0; }}
  .download {{ display: inline-block; margin: 28px 0 8px; padding: 15px 30px; border-radius: 12px;
              background: #8f7bff; color: #fff; font-weight: 600; font-size: 18px; text-decoration: none; }}
  .download:hover {{ background: #a191ff; }}
  .meta {{ color: #bfbaf0; font-size: 14px; margin: 0; }}
  ul {{ list-style: none; padding: 0; margin: 40px 0 0; display: grid; gap: 12px; }}
  li {{ padding: 14px 16px; border-radius: 12px; background: rgba(255, 255, 255, .07);
       border: 1px solid rgba(255, 255, 255, .12); }}
  li b {{ display: block; }}
  li span {{ color: #d0cdf2; font-size: 15px; }}
  .note {{ margin-top: 28px; padding: 14px 16px; border-radius: 12px; background: rgba(255, 210, 122, .1);
          border: 1px solid rgba(255, 210, 122, .3); font-size: 15px; color: #f3e6c8; }}
  footer {{ margin-top: 32px; text-align: center; font-size: 13px; color: #a9a4d6; }}
  footer a {{ color: #c9bfff; }}
</style>
<main>
  <header>
    <img src="buho.png" alt="">
    <h1>AdiOS Browser</h1>
    <p class="tag">Firefox sin anuncios y con VPN integrada.</p>
    <a class="download" href="{html.escape(setup_url)}">Descargar para Windows</a>
    <p class="meta">Versión {html.escape(version)} · {megabytes} MB · Windows 10 y 11 (64 bits)</p>
  </header>
  <ul>
    <li><b>Sin anuncios</b><span>El bloqueador viene dentro del navegador: no hay extensiones que instalar ni configurar.</span></li>
    <li><b>VPN a elegir</b><span>La VPN gratuita de Firefox o la tuya: Proton VPN, NordVPN o cualquier WireGuard.
      Con webs que puedes dejar fuera de la VPN.</span></li>
    <li><b>Se actualiza solo</b><span>Cuando hay versión nueva aparece en el menú ☰; un clic y listo.</span></li>
    <li><b>Es Firefox por dentro</b><span>Las extensiones de Firefox funcionan igual, y con tu cuenta de Firefox
      te traes los marcadores y las contraseñas.</span></li>
  </ul>
  <p class="note">Al abrir el instalador, Windows puede avisar de que es una aplicación no reconocida porque
    no está firmada por Microsoft. Pulsa «Más información» y luego «Ejecutar de todas formas».</p>
  <footer><a href="https://github.com/{REPO}">Código fuente</a> · MPL 2.0 (uBlock Origin, GPLv3) ·
    basado en Mozilla Firefox; no es un producto de Mozilla.</footer>
</main>
</html>
"""


def publish_pages(files):
    with tempfile.TemporaryDirectory(prefix="adios-pages-") as tmp:
        tmp = Path(tmp)
        for name, content in files.items():
            if isinstance(content, bytes):
                (tmp / name).write_bytes(content)
            else:
                (tmp / name).write_text(content, encoding="utf-8", newline="\n")
        name = subprocess.check_output(["git", "config", "user.name"], cwd=TOPSRCDIR, text=True).strip()
        email = subprocess.check_output(["git", "config", "user.email"], cwd=TOPSRCDIR, text=True).strip()
        run("git", "init", "-q", "-b", "gh-pages", cwd=tmp)
        run("git", "add", "-A", cwd=tmp)
        run("git", "-c", f"user.name={name}", "-c", f"user.email={email}",
            "commit", "-q", "-m", "Publicar actualización", cwd=tmp)
        run("git", "push", "-q", "--force", f"https://github.com/{REPO}.git", "gh-pages", cwd=tmp)
    pages = subprocess.run([GH, "api", f"repos/{REPO}/pages"], capture_output=True)
    if pages.returncode != 0:
        run(GH, "api", "-X", "POST", f"repos/{REPO}/pages",
            "-f", "source[branch]=gh-pages", "-f", "source[path]=/")


def main():
    version, build_id = build_info()
    tag = f"v{version}-{build_id}"
    print(f"AdiOS {version} (compilación {build_id})")
    installers = sorted((DIST / "install" / "sea").glob("*.installer.exe"))
    if not installers:
        sys.exit("No se encuentra el instalador; ejecuta antes `mach build installer`.")

    out_dir = DIST / "adios-release"
    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir()
    mar = make_signed_mar(version, build_id, out_dir)
    setup = out_dir / "AdiOS-Setup.exe"
    shutil.copy2(installers[-1], setup)

    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=TOPSRCDIR, text=True).strip()
    run(GH, "release", "create", tag, mar, setup, "--repo", REPO, "--target", commit,
        "--title", f"AdiOS {version} ({build_id[:8]})",
        "--notes", f"AdiOS Browser {version}, compilación {build_id}.\n\n"
                   f"Instala con AdiOS-Setup.exe; las instalaciones existentes se actualizan solas.")

    base = f"https://github.com/{REPO}/releases/download/{tag}"
    publish_pages({
        "update.xml": update_xml(version, build_id, mar, f"{base}/{mar.name}"),
        "index.html": index_html(version, f"{base}/AdiOS-Setup.exe", setup.stat().st_size),
        "buho.png": (TOPSRCDIR / "browser" / "branding" / "adios" / "default256.png").read_bytes(),
        ".nojekyll": "",
    })
    print(f"\nPublicado: {PAGES_URL}  ({tag})")


if __name__ == "__main__":
    main()
