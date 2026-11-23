/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* global ExtensionAPI, ExtensionUtils, Services */

// Privileged helpers for the AdiOS VPN built-in add-on:
// - runs wireproxy (a userspace WireGuard client exposing a local SOCKS5
//   proxy) so a WireGuard tunnel only carries the browser's traffic,
// - toggles the prefs that keep DNS, WebRTC and failed-proxy traffic from
//   leaking outside the tunnel,
// - stores credentials and WireGuard configs encrypted with the OS key store,
//   in a profile file that Firefox Sync never uploads.

const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);
const { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  IPPProxyManager:
    "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
  IPProtection: "moz-src:///browser/components/ipprotection/IPProtection.sys.mjs",
  IPProtectionService:
    "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs",
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
  IPPPermissionRules:
    "moz-src:///toolkit/components/ipprotection/IPPSiteRuleManager.sys.mjs",
  IPPPrincipalRules:
    "moz-src:///toolkit/components/ipprotection/IPPSiteRuleManager.sys.mjs",
});
// eslint-disable-next-line mozilla/reject-importGlobalProperties
Cu.importGlobalProperties(["TextEncoder", "TextDecoder", "atob", "btoa"]);
const { ExtensionError } = ExtensionUtils;

const SOCKS_HOST = "127.0.0.1";
const SOCKS_PORT = 25344;
const SECRET_ORIGIN = "chrome://adios-vpn";
const SECRET_REALM = "AdiOS VPN";

// Prefs set while connected. The previous values are restored on disconnect.
const LEAK_PROTECTION_PREFS = {
  // Never fall back to a direct connection when the VPN proxy is unreachable.
  "network.proxy.failover_direct": false,
  // WebRTC may only use the proxy, so it can't reveal the real IP address.
  "media.peerconnection.ice.proxy_only": true,
  // No speculative DNS lookups or connections outside the tunnel. (Proxied
  // requests resolve host names through the proxy itself.)
  "network.dns.disablePrefetch": true,
  "network.http.speculative-parallel-limit": 0,
};

let wireproxy = null;
let savedPrefs = null;

function wireproxyPath() {
  let file = Services.dirsvc.get("GreBinD", Ci.nsIFile);
  file.append("distribution");
  file.append("wireproxy.exe");
  return file;
}

function workDir() {
  return PathUtils.join(PathUtils.profileDir, "adios-vpn");
}

function readPref(name) {
  switch (Services.prefs.getPrefType(name)) {
    case Ci.nsIPrefBranch.PREF_BOOL:
      return Services.prefs.getBoolPref(name);
    case Ci.nsIPrefBranch.PREF_INT:
      return Services.prefs.getIntPref(name);
    case Ci.nsIPrefBranch.PREF_STRING:
      return Services.prefs.getStringPref(name);
  }
  return undefined;
}

function writePref(name, value) {
  if (typeof value == "boolean") {
    Services.prefs.setBoolPref(name, value);
  } else if (typeof value == "number") {
    Services.prefs.setIntPref(name, value);
  } else {
    Services.prefs.setStringPref(name, value);
  }
}

function setLeakProtection(enabled) {
  if (enabled && !savedPrefs) {
    savedPrefs = {};
    for (let [name, value] of Object.entries(LEAK_PROTECTION_PREFS)) {
      savedPrefs[name] = Services.prefs.prefHasUserValue(name)
        ? readPref(name)
        : undefined;
      writePref(name, value);
    }
  } else if (!enabled && savedPrefs) {
    for (let [name, value] of Object.entries(savedPrefs)) {
      if (value === undefined) {
        Services.prefs.clearUserPref(name);
      } else {
        writePref(name, value);
      }
    }
    savedPrefs = null;
  }
}

async function stopWireGuard() {
  let proc = wireproxy;
  wireproxy = null;
  if (proc) {
    await proc.kill();
  }
  // The WireGuard config holds the private key: only keep it on disk while
  // the tunnel is up.
  await IOUtils.remove(workDir(), { recursive: true, ignoreAbsent: true });
}

async function startWireGuard(config) {
  await stopWireGuard();
  let exe = wireproxyPath();
  if (!exe.exists()) {
    throw new ExtensionError(`No se encuentra wireproxy en ${exe.path}`);
  }
  let dir = workDir();
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  let wgConf = PathUtils.join(dir, "wg.conf");
  let proxyConf = PathUtils.join(dir, "wireproxy.conf");
  await IOUtils.writeUTF8(wgConf, config);
  await IOUtils.writeUTF8(
    proxyConf,
    `WGConfig = ${wgConf}\n\n[Socks5]\nBindAddress = ${SOCKS_HOST}:${SOCKS_PORT}\n`
  );

  let check = await Subprocess.call({
    command: exe.path,
    arguments: ["-n", "-c", proxyConf],
    stderr: "stdout",
  });
  let checkOutput = await check.stdout.readString();
  if ((await check.wait()).exitCode != 0) {
    await stopWireGuard();
    throw new ExtensionError(
      `La configuración WireGuard no es válida: ${checkOutput.trim()}`
    );
  }

  let proc = await Subprocess.call({
    command: exe.path,
    arguments: ["-s", "-c", proxyConf],
    stderr: "stdout",
  });
  wireproxy = proc;
  // Drain the output so the process never blocks on a full pipe.
  (async () => {
    while (await proc.stdout.readString()) {
      // Discard.
    }
  })();
  proc.wait().then(() => {
    if (wireproxy === proc) {
      wireproxy = null;
    }
  });
  // Give it a moment to open the local proxy port, then make sure it's alive.
  await new Promise(resolve => setTimeout(resolve, 800));
  if (wireproxy !== proc) {
    throw new ExtensionError("wireproxy se ha cerrado al arrancar");
  }
  return { host: SOCKS_HOST, port: SOCKS_PORT };
}

// The login manager rejects values with line breaks (WireGuard configs have
// several lines), so secrets are stored base64-encoded.
function encodeSecret(text) {
  let bytes = new TextEncoder().encode(text);
  return btoa(String.fromCharCode(...bytes));
}

function decodeSecret(encoded) {
  let bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Firefox's built-in VPN (IP Protection), offered as the default provider.
function firefoxVpnStatus() {
  return {
    service: lazy.IPProtectionService.state,
    proxy: lazy.IPPProxyManager.state,
    error: lazy.IPPProxyManager.errorType ?? null,
  };
}

// The AdiOS VPN button drives Firefox's VPN, so Firefox's own VPN button
// (placed on the toolbar by default when the feature is on) is moved to the
// customization palette. CustomizableUI remembers that, so it stays there.
function hideFirefoxVpnButton() {
  const WIDGET_ID = "ipprotection-button";
  if (lazy.CustomizableUI.getPlacementOfWidget(WIDGET_ID)) {
    lazy.CustomizableUI.removeWidgetFromArea(WIDGET_ID);
  }
}

async function firefoxVpnSignIn() {
  let window = Services.wm.getMostRecentWindow("navigator:browser");
  let panel = window && lazy.IPProtection.getPanel(window);
  if (!panel) {
    throw new ExtensionError("La VPN de Firefox no está disponible");
  }
  // Opens the Mozilla account sign-in and enrolls the account in the VPN.
  await panel.enroll({ entrypoint: "adios_vpn", utm_source: "adios" });
  return firefoxVpnStatus();
}

// "Sites without VPN": the registrable domain of a host (www.dazn.com ->
// dazn.com), and the matching exception in Firefox's VPN, which applies it to
// everything the site's tabs load.
function baseDomain(host) {
  try {
    return Services.eTLD.getBaseDomainFromHost(host);
  } catch (e) {
    return host;
  }
}

function setFirefoxVpnExclusion(domain, excluded) {
  let principal = Services.scriptSecurityManager.createContentPrincipalFromOrigin(
    `https://${domain}`
  );
  lazy.IPPPermissionRules.setRule(
    principal,
    excluded ? lazy.IPPPrincipalRules.EXCLUDED : lazy.IPPPrincipalRules.DEFAULT
  );
}

// Reads a WireGuard config the user just downloaded so it can be imported.
async function readWireGuardFile(path) {
  if (!path.toLowerCase().endsWith(".conf")) {
    throw new ExtensionError("Solo se pueden importar archivos .conf");
  }
  let { size } = await IOUtils.stat(path);
  if (size > 64 * 1024) {
    throw new ExtensionError("El archivo es demasiado grande para ser un .conf");
  }
  return IOUtils.readUTF8(path);
}

// Secrets are encrypted with the OS key store (tied to the Windows user, like
// saved credit cards) and kept in a profile file that is never synced. Older
// versions kept them in the login manager, which Firefox Sync uploads:
// migrateSecrets() moves them out.
function secretsFile() {
  return PathUtils.join(PathUtils.profileDir, "adios-vpn-secrets.json");
}

async function readSecrets() {
  try {
    return await IOUtils.readJSON(secretsFile());
  } catch (e) {
    return {};
  }
}

async function writeSecrets(secrets) {
  await IOUtils.writeJSON(secretsFile(), secrets, {
    tmpPath: `${secretsFile()}.tmp`,
  });
}

async function legacyLogins() {
  return Services.logins.searchLoginsAsync({
    origin: SECRET_ORIGIN,
    httpRealm: SECRET_REALM,
  });
}

async function saveSecret(id, secret) {
  let secrets = await readSecrets();
  secrets[id] = await lazy.OSKeyStore.encrypt(encodeSecret(secret));
  await writeSecrets(secrets);
}

async function loadSecret(id) {
  let secrets = await readSecrets();
  if (!secrets[id]) {
    await migrateSecrets();
    secrets = await readSecrets();
  }
  if (!secrets[id]) {
    return null;
  }
  return decodeSecret(await lazy.OSKeyStore.decrypt(secrets[id], "adios_vpn"));
}

async function deleteSecret(id) {
  let secrets = await readSecrets();
  delete secrets[id];
  await writeSecrets(secrets);
  for (let login of await legacyLogins()) {
    if (login.username == id) {
      await Services.logins.removeLoginAsync(login);
    }
  }
}

async function migrateSecrets() {
  let logins = await legacyLogins();
  if (!logins.length) {
    return 0;
  }
  let secrets = await readSecrets();
  for (let login of logins) {
    // Legacy passwords are already encodeSecret()-encoded.
    secrets[login.username] ??= await lazy.OSKeyStore.encrypt(login.password);
  }
  await writeSecrets(secrets);
  for (let login of logins) {
    await Services.logins.removeLoginAsync(login);
  }
  return logins.length;
}

this.adiosVpn = class extends ExtensionAPI {
  onShutdown() {
    stopWireGuard();
    setLeakProtection(false);
  }

  getAPI() {
    return {
      adiosVpn: {
        async isWireGuardAvailable() {
          return wireproxyPath().exists();
        },
        startWireGuard,
        stopWireGuard,
        async setLeakProtection(enabled) {
          setLeakProtection(enabled);
        },
        saveSecret,
        loadSecret,
        migrateSecrets,
        readWireGuardFile,
        async baseDomain(host) {
          return baseDomain(host);
        },
        async setFirefoxVpnExclusion(domain, excluded) {
          setFirefoxVpnExclusion(domain, excluded);
        },
        async hideFirefoxVpnButton() {
          hideFirefoxVpnButton();
        },
        async firefoxVpnStatus() {
          return firefoxVpnStatus();
        },
        firefoxVpnSignIn,
        async firefoxVpnStart() {
          let { started, error } = await lazy.IPPProxyManager.start(true);
          return { started, error: error ?? null };
        },
        async firefoxVpnStop() {
          await lazy.IPPProxyManager.stop(true);
        },
        deleteSecret,
      },
    };
  }
};
