/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// AdiOS VPN: one toolbar button for every VPN provider.
//  - "firefox": Firefox's built-in VPN (the default, free with a Mozilla
//    account).
//  - "wireguard": a WireGuard config (Proton VPN, Mullvad, ...) run by
//    wireproxy, which exposes the tunnel as a local SOCKS5 proxy. Configs are
//    picked up automatically when the user downloads them after choosing
//    "add Proton".
//  - "socks" / "https": a provider proxy with username and password (NordVPN
//    service credentials, ...).
// Secrets (passwords, WireGuard configs) are encrypted with the OS key store
// and never synced;
// storage.local only keeps names, hosts and ports.

const FIREFOX_ID = "firefox";
const DIRECT = { type: "direct" };
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const IMPORT_WINDOW_MS = 30 * 60 * 1000;

const PROVIDERS = {
  proton: {
    label: "Proton VPN",
    url: "https://account.protonvpn.com/downloads#wireguard-configuration",
  },
  wireguard: { label: "WireGuard" },
};

const NORD_SERVERS = {
  nl: { country: "Países Bajos", host: "nl.socks.nordhold.net" },
  se: { country: "Suecia", host: "se.socks.nordhold.net" },
  us: { country: "Estados Unidos", host: "us.socks.nordhold.net" },
};

const COUNTRY_NAMES = new Intl.DisplayNames(["es"], { type: "region" });

const FIREFOX_ERRORS = {
  "vpn-unavailable": "La VPN de Firefox todavía no está disponible en tu país.",
  "quota-exhausted": "Has gastado los 50 GB gratis de este mes de la VPN de Firefox.",
  "network-error": "No se pudo contactar con la VPN de Firefox. Revisa tu conexión.",
  "not-ready-error": "Inicia sesión con tu cuenta de Mozilla para usar la VPN de Firefox.",
};

let proxyInfo = null;
let status = { connected: false, activeId: FIREFOX_ID, error: null };
let pendingImport = null; // { provider, until }
// "Sites without VPN": registrable domains (e.g. "dazn.com") whose tabs bypass
// the VPN, for sites that block VPNs.
let exclusions = [];

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return null;
  }
}

function isExcludedHost(host) {
  return !!host && exclusions.some(d => host == d || host.endsWith(`.${d}`));
}

// The site shown in the tab that made a request: its videos, APIs and CDNs
// live on other domains, and must bypass the VPN too.
function topLevelHost(details) {
  if (details.type == "main_frame") {
    return hostOf(details.url);
  }
  let ancestors = details.frameAncestors;
  if (ancestors?.length) {
    return hostOf(ancestors[ancestors.length - 1].url);
  }
  return hostOf(details.documentUrl) ?? hostOf(details.originUrl);
}

browser.proxy.onRequest.addListener(
  details => {
    if (!proxyInfo) {
      return DIRECT;
    }
    let host = hostOf(details.url);
    if (LOCAL_HOSTS.has(host)) {
      return DIRECT;
    }
    if (isExcludedHost(topLevelHost(details)) || isExcludedHost(host)) {
      return DIRECT;
    }
    return proxyInfo;
  },
  { urls: ["<all_urls>"] }
);

async function loadExclusions() {
  exclusions = (await browser.storage.local.get("exclusions")).exclusions || [];
}

async function setExcluded(host, excluded) {
  let domain = await browser.adiosVpn.baseDomain(host);
  await loadExclusions();
  exclusions = exclusions.filter(d => d != domain);
  if (excluded) {
    exclusions.push(domain);
  }
  await browser.storage.local.set({ exclusions });
  try {
    await browser.adiosVpn.setFirefoxVpnExclusion(domain, excluded);
  } catch (e) {
    console.warn("AdiOS VPN: no se pudo aplicar la excepción a la VPN de Firefox:", e.message);
  }
  return domain;
}

async function siteInfo(url) {
  let host = hostOf(url);
  if (!host || !/^https?:/.test(url)) {
    return null;
  }
  let domain = await browser.adiosVpn.baseDomain(host);
  return { domain, excluded: exclusions.includes(domain) };
}

browser.proxy.onError.addListener(error => {
  console.warn("AdiOS VPN:", error.message);
});

function base64(text) {
  let bytes = new TextEncoder().encode(text);
  return btoa(String.fromCharCode(...bytes));
}

async function getConnections() {
  return (await browser.storage.local.get("connections")).connections || [];
}

async function setConnections(connections) {
  await browser.storage.local.set({ connections });
}

function firefoxConnection(firefoxStatus) {
  return {
    id: FIREFOX_ID,
    kind: "firefox",
    name: "VPN de Firefox",
    detail: "Gratis · 50 GB al mes",
    state: firefoxStatus.service,
  };
}

async function setStatus(newStatus) {
  status = newStatus;
  await browser.storage.local.set({
    lastSession: { connected: status.connected, activeId: status.activeId },
  });
  await browser.browserAction.setIcon({
    path: status.connected ? "icons/vpn-on.svg" : "icons/vpn-off.svg",
  });
  await browser.browserAction.setTitle({
    title: status.connected ? "VPN conectada" : "VPN desconectada",
  });
}

async function stopEverything() {
  proxyInfo = null;
  await browser.adiosVpn.stopWireGuard();
  await browser.adiosVpn.setLeakProtection(false);
  let firefox = await browser.adiosVpn.firefoxVpnStatus();
  if (firefox.proxy == "active" || firefox.proxy == "activating") {
    await browser.adiosVpn.firefoxVpnStop();
  }
}

async function disconnect() {
  await stopEverything();
  await setStatus({ connected: false, activeId: status.activeId, error: null });
}

async function connectFirefox() {
  let firefox = await browser.adiosVpn.firefoxVpnStatus();
  if (firefox.service == "unauthenticated") {
    throw new Error(FIREFOX_ERRORS["not-ready-error"]);
  }
  if (firefox.service != "ready") {
    throw new Error("La VPN de Firefox no está disponible ahora mismo.");
  }
  let { started, error } = await browser.adiosVpn.firefoxVpnStart();
  if (!started) {
    throw new Error(FIREFOX_ERRORS[error] ?? `La VPN de Firefox no arrancó (${error}).`);
  }
}

async function connectOwn(connection) {
  let secret = await browser.adiosVpn.loadSecret(connection.id);
  if (secret === null) {
    throw new Error("Faltan los datos de esta conexión; quítala y vuelve a añadirla.");
  }
  await browser.adiosVpn.setLeakProtection(true);
  switch (connection.kind) {
    case "wireguard": {
      // Point the browser at the tunnel before it is up: until then,
      // requests fail instead of leaking outside the VPN.
      proxyInfo = { type: "socks", host: "127.0.0.1", port: 25344, proxyDNS: true };
      let { host, port } = await browser.adiosVpn.startWireGuard(secret);
      proxyInfo = { type: "socks", host, port, proxyDNS: true };
      break;
    }
    case "socks":
      proxyInfo = {
        type: "socks",
        host: connection.host,
        port: connection.port,
        username: connection.username,
        password: secret,
        proxyDNS: true,
      };
      break;
    case "https":
      proxyInfo = {
        type: "https",
        host: connection.host,
        port: connection.port,
        proxyAuthorizationHeader: `Basic ${base64(`${connection.username}:${secret}`)}`,
      };
      break;
    default:
      throw new Error(`Tipo de conexión desconocido: ${connection.kind}`);
  }
}

async function connect(id) {
  await stopEverything();
  try {
    if (id == FIREFOX_ID) {
      await connectFirefox();
    } else {
      let connection = (await getConnections()).find(c => c.id == id);
      if (!connection) {
        throw new Error("No se encuentra esa conexión");
      }
      await connectOwn(connection);
    }
  } catch (e) {
    await stopEverything();
    await setStatus({ connected: false, activeId: id, error: e.message });
    throw e;
  }
  await setStatus({ connected: true, activeId: id, error: null });
}

async function addConnection({ name, kind, provider, host, port, username, secret, ...extra }) {
  if (kind == "wireguard" && !/\[Interface\][\s\S]*PrivateKey/.test(secret)) {
    throw new Error("Eso no parece un archivo de configuración WireGuard (.conf)");
  }
  let id = crypto.randomUUID();
  await browser.adiosVpn.saveSecret(id, secret);
  let connections = await getConnections();
  connections.push({ id, name, kind, provider, host, port, username, server: extra.server, nordServer: extra.nordServer });
  await setConnections(connections);
  if (!status.connected) {
    await setStatus({ ...status, activeId: id, error: null });
  }
  return id;
}

// NordVPN uses the same service credentials for every server, so there is a
// single NordVPN connection whose country can be switched at any time.
async function addNord({ username, password, server }) {
  let existing = (await getConnections()).find(c => c.provider == "nord");
  if (existing) {
    await browser.adiosVpn.saveSecret(existing.id, password);
    await updateConnection(existing.id, { username });
    await setNordServer({ id: existing.id, server });
    return existing.id;
  }
  let { country, host } = NORD_SERVERS[server];
  return addConnection({
    name: "NordVPN",
    kind: "socks",
    provider: "nord",
    host,
    port: 1080,
    username,
    secret: password,
    server: country,
    nordServer: server,
  });
}

async function updateConnection(id, changes) {
  let connections = await getConnections();
  let connection = connections.find(c => c.id == id);
  Object.assign(connection, changes);
  await setConnections(connections);
  return connection;
}

async function setNordServer({ id, server }) {
  let { country, host } = NORD_SERVERS[server];
  await updateConnection(id, { host, server: country, nordServer: server });
  if (status.connected && status.activeId == id) {
    await connect(id);
  }
}

// Picks a connection (e.g. another country); if the VPN is on, it switches
// right away.
async function choose(id) {
  if (status.connected && status.activeId != id) {
    await connect(id);
  } else {
    await setStatus({ ...status, activeId: id, error: null });
  }
}

async function removeConnection(id) {
  if (status.activeId == id) {
    if (status.connected) {
      await disconnect();
    }
    await setStatus({ connected: false, activeId: FIREFOX_ID, error: null });
  }
  await browser.adiosVpn.deleteSecret(id);
  await setConnections((await getConnections()).filter(c => c.id != id));
}

// Label an imported WireGuard config after the server in its file name, e.g.
// Proton's "wg-ES-12.conf" -> server "España #12", name "Proton VPN · España #12".
function namesFromFile(provider, filename) {
  let base = filename.split(/[\\/]/).pop().replace(/\.conf$/i, "");
  let match = base.match(/(?:^|[-_ ])([A-Z]{2})(?:[-#_ ]?(\d+))?(?:$|[-_ ])/);
  let server = base;
  if (match) {
    let country = COUNTRY_NAMES.of(match[1]) ?? match[1];
    server = `${country}${match[2] ? ` #${match[2]}` : ""}`;
  }
  return { server, name: `${PROVIDERS[provider]?.label ?? "WireGuard"} · ${server}` };
}

function startImport(provider) {
  pendingImport = { provider, until: Date.now() + IMPORT_WINDOW_MS };
  let url = PROVIDERS[provider]?.url;
  if (url) {
    browser.tabs.create({ url });
  }
}

browser.downloads.onChanged.addListener(async delta => {
  if (delta.state?.current != "complete" || !pendingImport) {
    return;
  }
  if (Date.now() > pendingImport.until) {
    pendingImport = null;
    return;
  }
  let [item] = await browser.downloads.search({ id: delta.id });
  if (!item?.filename.toLowerCase().endsWith(".conf")) {
    return;
  }
  let { provider } = pendingImport;
  try {
    let config = await browser.adiosVpn.readWireGuardFile(item.filename);
    let { name, server } = namesFromFile(provider, item.filename);
    await addConnection({ name, kind: "wireguard", provider, secret: config, server });
    // Stay ready for more files: people often download several countries.
    pendingImport.until = Date.now() + IMPORT_WINDOW_MS;
    // The file holds the private key; AdiOS keeps an encrypted copy.
    await browser.downloads.removeFile(item.id);
    await browser.downloads.erase({ id: item.id });
    browser.notifications.create({
      type: "basic",
      iconUrl: "icons/vpn-on.svg",
      title: "VPN añadida",
      message: `«${name}» está lista. Actívala desde el botón VPN de la barra.`,
    });
  } catch (e) {
    browser.notifications.create({
      type: "basic",
      iconUrl: "icons/vpn-off.svg",
      title: "No se pudo añadir la VPN",
      message: e.message,
    });
  }
});

async function checkIp() {
  let response = await fetch("https://ipinfo.io/json", { cache: "no-store" });
  let { ip, city, country, org } = await response.json();
  return { ip, city, country: country && COUNTRY_NAMES.of(country), org };
}

const COMMANDS = {
  async status() {
    let firefox = await browser.adiosVpn.firefoxVpnStatus();
    return {
      ...status,
      connections: [firefoxConnection(firefox), ...(await getConnections())],
      importing: pendingImport && Date.now() < pendingImport.until ? pendingImport.provider : null,
      wireGuardAvailable: await browser.adiosVpn.isWireGuardAvailable(),
    };
  },
  connect: ({ id }) => connect(id),
  disconnect: () => disconnect(),
  select: async ({ id }) => setStatus({ ...status, activeId: id, error: null }),
  choose: ({ id }) => choose(id),
  add: ({ connection }) => addConnection(connection),
  addNord: ({ nord }) => addNord(nord),
  setNordServer: ({ id, server }) => setNordServer({ id, server }),
  exclusions: async () => exclusions,
  siteInfo: ({ url }) => siteInfo(url),
  setExcluded: ({ host, excluded }) => setExcluded(host, excluded),
  remove: ({ id }) => removeConnection(id),
  startImport: async ({ provider }) => startImport(provider),
  firefoxSignIn: async () => {
    browser.adiosVpn.firefoxVpnSignIn().catch(e => console.warn("AdiOS VPN:", e.message));
  },
  checkIp: () => checkIp(),
};

browser.runtime.onMessage.addListener(async message => {
  try {
    return { ok: true, result: await COMMANDS[message.command](message) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

(async function startup() {
  // Firefox places its own VPN button once its default placements are
  // applied, which can happen after we start: check again a bit later.
  await browser.adiosVpn.hideFirefoxVpnButton();
  setTimeout(() => browser.adiosVpn.hideFirefoxVpnButton(), 5000);
  // Move secrets saved by older versions out of the (synced) login manager.
  await browser.adiosVpn.migrateSecrets();
  await loadExclusions();

  let { lastSession } = await browser.storage.local.get("lastSession");
  await setStatus({
    connected: false,
    activeId: lastSession?.activeId ?? FIREFOX_ID,
    error: null,
  });
  // Reconnect if the VPN was on when the browser was closed.
  if (lastSession?.connected && lastSession.activeId) {
    try {
      await connect(lastSession.activeId);
    } catch (e) {
      console.warn("AdiOS VPN: no se pudo reconectar:", e.message);
    }
  }
})();
