/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const $ = id => document.getElementById(id);
const field = (form, name) => form.elements.namedItem(name);

const AVATARS = {
  firefox: ["firefox", "F"],
  proton: ["proton", "P"],
  nord: ["nord", "N"],
};

async function send(command, data = {}) {
  let reply = await browser.runtime.sendMessage({ command, ...data });
  if (!reply.ok) {
    throw new Error(reply.error);
  }
  return reply.result;
}

function showError(message) {
  $("error").textContent = message ?? "";
  $("error").hidden = !message;
}

const NORD_COUNTRIES = { nl: "Países Bajos", se: "Suecia", us: "Estados Unidos" };
const GROUP_TITLES = { proton: "Proton VPN", nord: "NordVPN" };

// One row per provider: Proton VPN configs and the NordVPN account are
// grouped, with a country picker; anything else gets its own row.
function groupConnections(connections) {
  let groups = [];
  let byProvider = new Map();
  for (let connection of connections) {
    let key = ["proton", "nord"].includes(connection.provider) ? connection.provider : connection.id;
    if (!byProvider.has(key)) {
      let group = { key, items: [] };
      byProvider.set(key, group);
      groups.push(group);
    }
    byProvider.get(key).items.push(connection);
  }
  return groups;
}

function serverLabel(connection) {
  return connection.server ?? connection.name.replace(/^Proton VPN · /, "");
}

function countryPicker(group, current) {
  let select = document.createElement("select");
  select.className = "country";
  if (group.key == "nord") {
    for (let [code, country] of Object.entries(NORD_COUNTRIES)) {
      select.add(new Option(country, code, false, code == current.nordServer));
    }
    select.addEventListener("change", async () => {
      await run(() => send("setNordServer", { id: current.id, server: select.value }));
    });
  } else {
    for (let item of group.items) {
      select.add(new Option(serverLabel(item), item.id, false, item.id == current.id));
    }
    select.add(new Option("＋ Añadir otro país…", "add"));
    select.addEventListener("change", async () => {
      if (select.value == "add") {
        await send("startImport", { provider: "proton" });
        window.close();
        return;
      }
      await run(() => send("choose", { id: select.value }));
    });
  }
  select.addEventListener("click", event => event.stopPropagation());
  return select;
}

function groupRow(group, status) {
  let current = group.items.find(c => c.id == status.activeId) ?? group.items[0];
  let selected = group.items.some(c => c.id == status.activeId);
  let kind = current.kind == "firefox" ? "firefox" : group.key;
  let [avatarClass, letter] = AVATARS[kind] ?? ["other", "W"];

  let item = document.createElement("li");
  item.className = "provider";
  item.classList.toggle("selected", selected);

  let avatar = document.createElement("span");
  avatar.className = `avatar ${avatarClass}`;
  avatar.textContent = letter;

  let text = document.createElement("div");
  text.className = "text";
  let name = document.createElement("div");
  name.className = "name";
  name.textContent = GROUP_TITLES[group.key] ?? current.name;
  text.append(name);
  item.append(avatar, text);

  if (current.kind == "firefox") {
    let detail = document.createElement("div");
    detail.className = "detail";
    text.append(detail);
    if (current.state == "unauthenticated") {
      detail.textContent = "Gratis · inicia sesión con tu cuenta de Mozilla";
      let signIn = document.createElement("button");
      signIn.className = "action primary";
      signIn.textContent = "Iniciar sesión";
      signIn.addEventListener("click", async event => {
        event.stopPropagation();
        await send("firefoxSignIn");
        window.close();
      });
      item.append(signIn);
    } else if (current.state == "ready") {
      detail.textContent = current.detail;
    } else {
      detail.textContent = "No disponible ahora mismo";
      item.classList.add("disabled");
      return item;
    }
  } else {
    if (group.key == "proton" || group.key == "nord") {
      text.append(countryPicker(group, current));
    } else {
      let detail = document.createElement("div");
      detail.className = "detail";
      detail.textContent = current.kind == "wireguard" ? "WireGuard" : current.host;
      text.append(detail);
    }
    let remove = document.createElement("button");
    remove.className = "remove";
    remove.textContent = "✕";
    let what = group.key == "proton" ? `Proton VPN · ${serverLabel(current)}` : name.textContent;
    remove.title = `Quitar ${what}`;
    remove.addEventListener("click", async event => {
      event.stopPropagation();
      if (confirm(`¿Quitar «${what}»?`)) {
        await send("remove", { id: current.id });
        render();
      }
    });
    item.append(remove);
  }

  item.addEventListener("click", async () => {
    if (!selected) {
      await run(() => send("choose", { id: current.id }));
    }
  });
  return item;
}

// Runs an action that may (re)connect, showing errors in the panel.
async function run(action) {
  showError(null);
  try {
    await action();
  } catch (e) {
    showError(e.message);
  }
  await render();
}

async function render() {
  let status = await send("status");
  document.body.classList.toggle("connected", status.connected);
  let active = status.connections.find(c => c.id == status.activeId);
  $("state").textContent = status.connected
    ? `Conectada · ${active?.name ?? ""}`
    : "Desconectada";
  $("hero-icon").src = status.connected ? "../icons/vpn-on.svg" : "../icons/vpn-off.svg";

  let sw = $("switch");
  sw.setAttribute("aria-checked", status.connected);
  sw.onclick = async () => {
    sw.classList.add("busy");
    showError(null);
    try {
      await send(status.connected ? "disconnect" : "connect", { id: status.activeId });
    } catch (e) {
      showError(e.message);
    }
    sw.classList.remove("busy");
    $("ip").textContent = "¿Por dónde sales a internet?";
    render();
  };

  $("providers").replaceChildren(
    ...groupConnections(status.connections).map(g => groupRow(g, status))
  );
  showError(status.error);
  $("importing").hidden = !status.importing;
  await renderSites();
}


// "Sites without VPN": the current tab's site and the list of exceptions.
async function renderSites() {
  let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  let info = tab?.url ? await send("siteInfo", { url: tab.url }) : null;
  $("site").hidden = !info;
  if (info) {
    $("site-domain").textContent = info.domain;
    $("site-state").textContent = info.excluded
      ? "Va por tu conexión normal"
      : "Va por la VPN cuando está encendida";
    let toggle = $("site-toggle");
    toggle.textContent = info.excluded ? "Volver a usar VPN" : "No usar VPN aquí";
    toggle.classList.toggle("primary", !info.excluded);
    toggle.onclick = async () => {
      await send("setExcluded", { host: new URL(tab.url).hostname, excluded: !info.excluded });
      // Reload so the page's connections follow the new rule.
      browser.tabs.reload(tab.id);
      renderSites();
    };
  }

  let exclusions = await send("exclusions");
  $("no-exclusions").hidden = exclusions.length > 0;
  $("exclusions").replaceChildren(
    ...exclusions.map(domain => {
      let chip = document.createElement("li");
      chip.textContent = domain;
      let remove = document.createElement("button");
      remove.textContent = "✕";
      remove.title = `Volver a usar la VPN en ${domain}`;
      remove.addEventListener("click", async () => {
        await send("setExcluded", { host: domain, excluded: false });
        renderSites();
      });
      chip.append(remove);
      return chip;
    })
  );
}

// Add view.
function showView(name) {
  $("main-view").hidden = name != "main";
  $("add-view").hidden = name != "add";
  $("add-message").hidden = true;
}

function showAddMessage(text, isError) {
  let message = $("add-message");
  message.textContent = text;
  message.className = isError ? "error" : "ok";
  message.hidden = false;
}

function selectTab(tab) {
  for (let button of document.querySelectorAll("[role=tab]")) {
    button.setAttribute("aria-selected", button.dataset.tab == tab);
  }
  for (let panel of document.querySelectorAll("[data-panel]")) {
    panel.hidden = panel.dataset.panel != tab;
  }
}

$("add").addEventListener("click", () => showView("add"));
$("back").addEventListener("click", () => {
  showView("main");
  render();
});
for (let button of document.querySelectorAll("[role=tab]")) {
  button.addEventListener("click", () => selectTab(button.dataset.tab));
}

for (let button of document.querySelectorAll("[data-import]")) {
  button.addEventListener("click", async () => {
    await send("startImport", { provider: button.dataset.import });
    window.close();
  });
}

for (let link of document.querySelectorAll("a[href]")) {
  link.addEventListener("click", event => {
    event.preventDefault();
    browser.tabs.create({ url: link.href });
    window.close();
  });
}

$("nord-form").addEventListener("submit", async event => {
  event.preventDefault();
  let form = event.target;
  try {
    await send("addNord", {
      nord: {
        username: field(form, "username").value.trim(),
        password: field(form, "password").value,
        server: field(form, "server").value,
      },
    });
    form.reset();
    showView("main");
    render();
  } catch (e) {
    showAddMessage(e.message, true);
  }
});

$("proxy-form").addEventListener("submit", async event => {
  event.preventDefault();
  let form = event.target;
  let host = field(form, "host").value.trim();
  try {
    await send("add", {
      connection: {
        name: field(form, "name").value.trim() || host,
        kind: field(form, "kind").value,
        host,
        port: Number(field(form, "port").value),
        username: field(form, "username").value.trim(),
        secret: field(form, "password").value,
      },
    });
    form.reset();
    showView("main");
    render();
  } catch (e) {
    showAddMessage(e.message, true);
  }
});

$("check-ip").addEventListener("click", async () => {
  let ip = $("ip");
  ip.textContent = "Comprobando…";
  try {
    let info = await send("checkIp");
    ip.textContent = `${info.ip} · ${[info.city, info.country].filter(Boolean).join(", ")}`;
  } catch (e) {
    ip.textContent = "No se pudo comprobar";
  }
});

// Refresh while open, e.g. when a downloaded .conf is imported.
browser.storage.onChanged.addListener(changes => {
  if ((changes.connections || changes.lastSession) && !$("main-view").hidden) {
    render();
  }
});

render();
