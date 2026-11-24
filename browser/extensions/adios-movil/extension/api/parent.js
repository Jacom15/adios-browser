/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* global ExtensionAPI, ExtensionUtils, Services */

// Privileged helper for the AdiOS Móvil built-in add-on: runs
// distribution/movil-puente.exe, which talks to the Android phone through adb
// and scrcpy-server (distribution/scrcpy/) and serves the stream to the Móvil
// panel on a 127.0.0.1 WebSocket that only accepts a per-launch secret.
// The bridge exits by itself when the browser closes (its stdin pipe ends).

const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);
const { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);
const { ExtensionError } = ExtensionUtils;

let bridge = null; // { proc, port, token }
let starting = null;

function bridgePath() {
  let file = Services.dirsvc.get("GreBinD", Ci.nsIFile);
  file.append("distribution");
  file.append("movil-puente.exe");
  return file;
}

// The bridge prints "PUERTO <n>" once it listens on 127.0.0.1.
async function readPort(proc) {
  let text = "";
  let timeout = new Promise(resolve => setTimeout(() => resolve(null), 10000));
  while (!/PUERTO (\d+)/.test(text)) {
    let chunk = await Promise.race([proc.stdout.readString(), timeout]);
    if (!chunk) {
      return 0;
    }
    text += chunk;
  }
  return Number(text.match(/PUERTO (\d+)/)[1]);
}

async function launch() {
  let exe = bridgePath();
  if (!exe.exists()) {
    throw new ExtensionError(`No se encuentra el puente de Móvil en ${exe.path}`);
  }
  let token = Services.uuid.generateUUID().toString().replace(/[{}-]/g, "");
  let proc = await Subprocess.call({
    command: exe.path,
    arguments: ["--token", token],
    stderr: "stdout",
  });
  let port = await readPort(proc);
  if (!port) {
    await proc.kill();
    throw new ExtensionError("El puente de Móvil no ha arrancado");
  }
  bridge = { proc, port, token };
  // Drain the output so the process never blocks on a full pipe.
  (async () => {
    while (await proc.stdout.readString()) {
      // Discard.
    }
  })();
  proc.wait().then(() => {
    if (bridge?.proc === proc) {
      bridge = null;
    }
  });
  return { port, token };
}

async function start() {
  if (bridge) {
    return { port: bridge.port, token: bridge.token };
  }
  starting ??= launch().finally(() => {
    starting = null;
  });
  return starting;
}

async function stop() {
  let current = bridge;
  bridge = null;
  if (current) {
    // Closing stdin lets the bridge stop adb before exiting.
    await current.proc.stdin.close();
    let exited = await Promise.race([
      current.proc.wait().then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 3000)),
    ]);
    if (!exited) {
      await current.proc.kill();
    }
  }
}

this.adiosMovil = class extends ExtensionAPI {
  onShutdown() {
    stop();
  }

  getAPI() {
    return {
      adiosMovil: {
        start,
        stop,
      },
    };
  }
};
