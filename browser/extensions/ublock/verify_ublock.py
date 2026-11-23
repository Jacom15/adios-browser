# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Smoke-test the built-in uBlock Origin in a local Firefox build.

Usage:
    python browser/extensions/ublock/verify_ublock.py [path/to/firefox.exe]

Starts the build headless with a throwaway profile, drives it over Marionette
and checks that the content blocker is built in, hidden, cannot be removed,
has its toolbar button and actually blocks ads on the live web. Needs network
access. Exits with a non-zero status if any check fails.
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ADDON_ID = "uBlock0@raymondhill.net"
WIDGET_ID = "ublock0_raymondhill_net-browser-action"
# Requests uBlock blocks outright. (Some Google ad scripts are let through or
# neutered on purpose to avoid anti-adblock breakage, so they are not probed.)
AD_URLS = [
    "https://c.amazon-adsystem.com/aax2/apstag.js",
    "https://fastlane.rubiconproject.com/a/api/fastlane.json",
]
CONTROL_URL = "https://www.mozilla.org/favicon.ico"
PREFS = {
    "browser.aboutwelcome.enabled": "false",
    "browser.shell.checkDefaultBrowser": "false",
    "browser.startup.homepage_override.mstone": '"ignore"',
    # Keep the start pages blank: the privileged about:home process is shut
    # down shortly after startup and can take the tab under test with it.
    "browser.startup.page": "0",
    "browser.newtabpage.enabled": "false",
    "datareporting.policy.dataSubmissionEnabled": "false",
}
TEST_PAGE = "https://example.com/"
TOPSRCDIR = Path(__file__).resolve().parents[3]


class Marionette:
    def __init__(self, port, timeout=60):
        deadline = time.time() + timeout
        while True:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
                self.sock.settimeout(180)
                self._read()  # Server hello.
                break
            except OSError:
                # Not listening yet, or the connection was reset during startup.
                if time.time() > deadline:
                    raise
                time.sleep(0.5)
        self.msg_id = 0

    def _read(self):
        length = b""
        while not length.endswith(b":"):
            chunk = self.sock.recv(1)
            if not chunk:
                raise ConnectionError("Marionette connection closed")
            length += chunk
        size = int(length[:-1])
        data = b""
        while len(data) < size:
            data += self.sock.recv(size - len(data))
        return json.loads(data)

    def send(self, command, params=None):
        self.msg_id += 1
        payload = json.dumps([0, self.msg_id, command, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        _, _, error, result = self._read()
        if error:
            raise RuntimeError(f"{command} failed: {error}")
        return result

    def script(self, body):
        return self.send(
            "WebDriver:ExecuteScript",
            {"script": f"return (async () => {{ {body} }})();", "args": []},
        )["value"]


CHROME_CHECKS = f"""
  const id = {json.dumps(ADDON_ID)};
  const addon = await AddonManager.getAddonByID(id);
  if (!addon) {{
    return {{ installed: false }};
  }}
  const policy = WebExtensionPolicy.getByID(id);
  return {{
    installed: true,
    active: addon.isActive,
    builtin: addon.isBuiltin,
    hidden: addon.hidden,
    removable: !!(addon.permissions & AddonManager.PERM_CAN_UNINSTALL),
    privateBrowsing: !!policy?.privateBrowsingAllowed,
    inExtensionsPanel: gUnifiedExtensions.getActivePolicies().some(p => p.id == id),
    toolbarArea: CustomizableUI.getPlacementOfWidget({json.dumps(WIDGET_ID)})?.area ?? null,
    locale: Services.locale.appLocaleAsBCP47,
  }};
"""

PAGE_CONTEXT_MENU_CHECK = f"""
  // Right-click the page and list the menu items added by the content blocker.
  const popup = document.getElementById("contentAreaContextMenu");
  const shown = new Promise(r => popup.addEventListener("popupshown", r, {{ once: true }}));
  const rect = gBrowser.selectedBrowser.getBoundingClientRect();
  window.synthesizeMouseEvent(
    "contextmenu", rect.left + 50, rect.top + 50, {{ button: 2, clickCount: 1 }}
  );
  await shown;
  await new Promise(r => setTimeout(r, 1000));
  const items = [...popup.querySelectorAll("[id^='{WIDGET_ID.removesuffix("-browser-action")}']")]
    .filter(item => !item.hidden)
    .map(item => item.label || item.id);
  popup.hidePopup();
  return items;
"""

PROBE_REQUESTS = f"""
  const probe = async url => {{
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    try {{
      await fetch(url, {{ mode: "no-cors", cache: "no-store", signal: controller.signal }});
      return "loaded";
    }} catch (e) {{
      // A blocked request fails with a network error (TypeError).
      return e.name == "AbortError" ? "timeout" : "blocked";
    }}
  }};
  const urls = [{json.dumps(CONTROL_URL)}, ...{json.dumps(AD_URLS)}];
  return Object.fromEntries(await Promise.all(urls.map(async u => [u, await probe(u)])));
"""

PROBE_COSMETIC = """
  const div = document.createElement("div");
  div.className = "ad_banner";
  div.textContent = "ad";
  document.body.append(div);
  // Generic cosmetic filters can take a while right after a fresh install.
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (getComputedStyle(div).display == "none") {
      return "hidden";
    }
  }
  return "visible";
"""


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def find_firefox():
    for objdir in sorted(TOPSRCDIR.glob("obj-*")):
        candidate = objdir / "dist" / "bin" / "firefox.exe"
        if candidate.exists():
            return candidate
    raise SystemExit("No local build found; run ./mach build first.")


def open_test_page(client, attempts=3):
    """Navigate to the test page, recovering if the tab gets discarded."""
    for attempt in range(attempts):
        try:
            client.send("WebDriver:Navigate", {"url": TEST_PAGE})
            return
        except RuntimeError as e:
            if attempt == attempts - 1 or "no such window" not in str(e):
                raise
            handle = client.send("WebDriver:NewWindow", {"type": "tab"})["handle"]
            client.send("WebDriver:SwitchToWindow", {"handle": handle})


def main(argv):
    firefox = Path(argv[0]) if argv else find_firefox()
    profile = Path(tempfile.mkdtemp(prefix="ublock-verify-"))
    port = free_port()
    prefs = {"marionette.port": str(port), **PREFS}
    (profile / "user.js").write_text(
        "".join(f'user_pref("{name}", {value});\n' for name, value in prefs.items()),
        encoding="utf-8",
    )
    proc = subprocess.Popen(
        [str(firefox), "--headless", "--marionette", "--no-remote", "-profile", str(profile)],
        # Needed to inspect the browser UI (chrome context) over Marionette.
        env={**os.environ, "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1"},
    )
    failures = []

    def check(name, ok, detail):
        print(f"[{'OK' if ok else 'FALLO'}] {name}: {detail}")
        if not ok:
            failures.append(name)

    try:
        client = Marionette(port)
        client.send("WebDriver:NewSession", {"capabilities": {}})

        client.send("Marionette:SetContext", {"value": "chrome"})
        # Built-in add-ons start asynchronously after the first window opens.
        deadline = time.time() + 30
        while True:
            state = client.script(CHROME_CHECKS)
            if (state.get("installed") and state.get("active")) or time.time() > deadline:
                break
            time.sleep(1)

        check("Integrado en Firefox", state.get("installed") and state.get("builtin"), state)
        if not state.get("installed"):
            return 1
        check("Activo", state["active"], state["active"])
        check("Oculto de la lista de extensiones", state["hidden"], state["hidden"])
        check("No se puede desinstalar", not state["removable"], state["removable"])
        check("Funciona en ventanas privadas", state["privateBrowsing"], state["privateBrowsing"])
        check("Fuera del panel de extensiones", not state["inExtensionsPanel"], state["inExtensionsPanel"])
        check("Sin boton en la barra", state["toolbarArea"] is None, state["toolbarArea"])

        client.send("Marionette:SetContext", {"value": "content"})
        client.send("WebDriver:SetTimeouts", {"script": 30000, "pageLoad": 60000})
        open_test_page(client)
        # uBlock compiles its filter lists on first run; retry for a while.
        deadline = time.time() + 120
        while True:
            requests = client.script(PROBE_REQUESTS)
            all_blocked = all(requests[url] == "blocked" for url in AD_URLS)
            if all_blocked or time.time() > deadline:
                break
            time.sleep(3)
        check("Hay conexion a internet (control)", requests[CONTROL_URL] == "loaded", requests[CONTROL_URL])
        for url in AD_URLS:
            check(f"Bloquea {url.split('/')[2]}", requests[url] == "blocked", requests[url])
        check("Oculta banners de anuncios", client.script(PROBE_COSMETIC) == "hidden", "")

        # Last: a context menu left behind by a failure here can block content.
        client.send("Marionette:SetContext", {"value": "chrome"})
        try:
            items = client.script(PAGE_CONTEXT_MENU_CHECK)
            check("Clic derecho en la pagina sin opciones de uBlock", not items, items)
        except RuntimeError as e:
            check("Clic derecho en la pagina sin opciones de uBlock", False, e)

        try:
            client.send("Marionette:Quit", {"flags": ["eForceQuit"]})
        except (ConnectionError, OSError):
            pass  # Firefox may drop the connection while quitting.
    finally:
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)

    print("\nTODO CORRECTO" if not failures else f"\nFALLOS: {', '.join(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
