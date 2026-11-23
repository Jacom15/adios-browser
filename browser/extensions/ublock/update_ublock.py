# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Vendor the latest uBlock Origin release as a built-in, hidden add-on.

Usage:
    ./mach python browser/extensions/ublock/update_ublock.py [path/to/ublock.xpi]

Without an argument, the latest Firefox build is downloaded from the official
GitHub releases. The signature files are dropped (built-in add-ons are not
signature-checked) and the add-on is made invisible: it is marked as hidden
(not listed in about:addons or the extensions panel), its toolbar button is
removed, and its page context menu entry is off by default.
"""

import io
import json
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

ADDON_DIR = Path(__file__).resolve().parent / "extension"
RELEASES_API = "https://api.github.com/repos/gorhill/uBlock/releases/latest"
USER_AGENT = "firefox-builtin-ublock-updater"


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request) as response:
        return response.read()


def download_latest_xpi():
    release = json.loads(fetch(RELEASES_API))
    asset = next(
        a for a in release["assets"] if a["name"].endswith(".firefox.signed.xpi")
    )
    print(f"Downloading {asset['name']}...")
    return fetch(asset["browser_download_url"])


def main(argv):
    xpi_bytes = Path(argv[0]).read_bytes() if argv else download_latest_xpi()

    shutil.rmtree(ADDON_DIR, ignore_errors=True)
    with zipfile.ZipFile(io.BytesIO(xpi_bytes)) as xpi:
        for member in xpi.infolist():
            if not member.filename.startswith("META-INF/"):
                xpi.extract(member, ADDON_DIR)

    manifest_path = ADDON_DIR / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["hidden"] = True
    # Hidden add-ons can't have toolbar buttons; drop it and its shortcut.
    manifest.pop("browser_action", None)
    manifest.get("commands", {}).pop("_execute_browser_action", None)
    with open(manifest_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")

    for path, old, new in CODE_PATCHES:
        patch(ADDON_DIR / path, old, new)

    print(f"uBlock Origin {manifest['version']} vendored into {ADDON_DIR}")


# Small, exact edits to uBlock Origin's code. Each one must match exactly once,
# so a new uBlock version that changes this code stops the update instead of
# silently producing a broken build.
CODE_PATCHES = [
    # Don't add "uBlock Origin" entries to the page context menu by default.
    ("js/background.js", "contextMenuEnabled: true,", "contextMenuEnabled: false,"),
    # Without a toolbar button there is no browserAction API: make the code
    # that updates the button's icon, badge and title do nothing.
    (
        "js/vapi-background.js",
        "const browserAction = vAPI.browserAction;",
        "const browserAction = vAPI.browserAction || {};",
    ),
    (
        "js/vapi-background.js",
        "browser.runtime.getManifest().browser_action.default_title",
        "browser.runtime.getManifest().name",
    ),
    (
        "js/vapi-background.js",
        "browser.browserAction.onClicked.addListener(",
        "browser.browserAction?.onClicked.addListener(",
    ),
]


def patch(path, old, new):
    text = path.read_text(encoding="utf-8")
    if text.count(old) != 1:
        sys.exit(f"Unexpected uBlock Origin code in {path.name}: '{old}' not found exactly once")
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text.replace(old, new))


if __name__ == "__main__":
    main(sys.argv[1:])
