# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Publish the packaged AdiOS build: signed update + installer + update.xml.

Run by publicar.sh after `mach package-multi-locale`, which also builds the installer.
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
WEB = TOPSRCDIR / "browser" / "branding" / "adios" / "web"
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


def index_html(version=None, setup_url=None, setup_size=None):
    """The download page; without a version it says the first one is on its way."""
    if version:
        download = (
            f'<a class="download" href="{html.escape(setup_url)}">'
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" '
            'stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/>'
            '<path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>Descargar para Windows</a>'
        )
        meta = (
            f"Versión {html.escape(version)} · {round(setup_size / 1_000_000)} MB · "
            "Windows 10 y 11 (64 bits)"
        )
    else:
        download = '<span class="download soon">Disponible muy pronto</span>'
        meta = "Primera versión en preparación · Windows 10 y 11 (64 bits)"
    page = (WEB / "index.html").read_text(encoding="utf-8")
    return (
        page.replace("@DOWNLOAD@", download)
        .replace("@META@", meta)
        .replace("@PAGES_URL@", PAGES_URL)
    )


def site_files(page):
    return {
        "index.html": page,
        "buho.png": (TOPSRCDIR / "browser" / "branding" / "adios" / "default256.png").read_bytes(),
        "vista-previa.png": (WEB / "vista-previa.png").read_bytes(),
        ".nojekyll": "",
    }


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


def main(argv):
    if argv == ["--provisional"]:
        # Only the download page, before the first version is published.
        publish_pages(site_files(index_html()))
        return
    version, build_id = build_info()
    tag = f"v{version}-{build_id}"
    print(f"AdiOS {version} (compilación {build_id})")
    installers = sorted(DIST.glob(f"firefox-{version}.*.installer.exe"))
    if not installers:
        sys.exit("No se encuentra el instalador; ejecuta antes `mach package-multi-locale`.")
    if not (DIST / "firefox" / "distribution" / "wireproxy.exe").exists():
        sys.exit("Falta distribution/wireproxy.exe en el paquete.")

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
        **site_files(index_html(version, f"{base}/AdiOS-Setup.exe", setup.stat().st_size)),
        "update.xml": update_xml(version, build_id, mar, f"{base}/{mar.name}"),
    })
    print(f"\nPublicado: {PAGES_URL}  ({tag})")


if __name__ == "__main__":
    main(sys.argv[1:])
