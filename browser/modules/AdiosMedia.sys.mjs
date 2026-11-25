/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * AdiOS: tells Ecosistema (the Windows dock that comes with AdiOS) which tabs
 * are playing or have paused media, and lets it control them.
 *
 * The list is kept in <profile>/adios-sonando.json. Ecosistema acts on a tab by
 * launching AdiOS with that profile, which reaches this running instance:
 *
 *   firefox.exe --profile <dir> --adios-media <action>:<browserId>
 *
 * where <action> is focus, toggle, play, pause, next or previous.
 * Private windows are never listed.
 */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const FILE_NAME = "adios-sonando.json";
const WATCHED_ATTRIBUTES = ["soundplaying", "muted", "label", "image"];

export const AdiosMedia = {
  _initialized: false,
  _pending: null,
  _poll: null,
  _lastJSON: "",
  // browserId -> when it was last heard playing, to sort the list.
  _lastPlayed: new Map(),

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    Services.obs.addObserver(this, "browser-delayed-startup-finished");
    Services.obs.addObserver(this, "quit-application-granted");
    for (let win of lazy.BrowserWindowTracker.orderedWindows) {
      this._watch(win);
    }
    this._schedule();
  },

  get _path() {
    return PathUtils.join(PathUtils.profileDir, FILE_NAME);
  },

  observe(subject, topic) {
    if (topic == "browser-delayed-startup-finished") {
      this._watch(subject);
      this._schedule();
    } else if (topic == "quit-application-granted") {
      this._stopPolling();
      // Nothing plays once AdiOS is closed.
      IOUtils.writeUTF8(this._path, JSON.stringify({ tabs: [] })).catch(
        () => {}
      );
    }
  },

  _watch(win) {
    if (!win.gBrowser || win.__adiosMediaWatched) {
      return;
    }
    win.__adiosMediaWatched = true;
    let tabs = win.gBrowser.tabContainer;
    tabs.addEventListener("TabAttrModified", event => {
      let changed = event.detail?.changed ?? [];
      if (changed.some(name => WATCHED_ATTRIBUTES.includes(name))) {
        this._schedule();
      }
    });
    tabs.addEventListener("TabClose", () => this._schedule());
    win.addEventListener("unload", () => this._schedule());
  },

  _schedule() {
    if (this._pending) {
      return;
    }
    this._pending = lazy.setTimeout(() => {
      this._pending = null;
      this._update().catch(console.error);
    }, 300);
  },

  // Pausing with the page's own button or changing song does not always touch
  // the tab, so while something is listed it is checked every few seconds.
  _startPolling() {
    if (!this._poll) {
      this._poll = lazy.setInterval(() => this._schedule(), 3000);
    }
  },

  _stopPolling() {
    if (this._poll) {
      lazy.clearInterval(this._poll);
      this._poll = null;
    }
  },

  *_tabs() {
    for (let win of lazy.BrowserWindowTracker.orderedWindows) {
      if (!win.gBrowser || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
        continue;
      }
      for (let tab of win.gBrowser.tabs) {
        yield { win, tab };
      }
    }
  },

  _describe(tab) {
    let browser = tab.linkedBrowser;
    let controller = browser.browsingContext?.mediaController;
    let active = !!controller?.isActive;
    if (!active && !tab.soundPlaying) {
      return null;
    }
    let metadata = {};
    try {
      metadata = (active && controller.getMetadata()) || {};
    } catch (e) {
      // No metadata yet.
    }
    let site = "";
    try {
      site = browser.currentURI.host.replace(/^www\./, "");
    } catch (e) {
      // about: pages and the like have no host.
    }
    let id = String(browser.browserId);
    let playing = active ? controller.isPlaying : tab.soundPlaying;
    if (playing) {
      this._lastPlayed.set(id, Date.now());
    }
    let artwork = "";
    let bestSize = -1;
    for (let image of metadata.artwork ?? []) {
      let size = parseInt(image.sizes, 10) || 0;
      if (image.src?.startsWith("http") && size > bestSize) {
        artwork = image.src;
        bestSize = size;
      }
    }
    return {
      id,
      title: metadata.title || tab.label,
      artist: metadata.artist || "",
      album: metadata.album || "",
      site,
      playing,
      audible: tab.soundPlaying,
      muted: tab.muted,
      canControl: active,
      artwork,
      icon: tab.image?.startsWith("http") ? tab.image : "",
      lastPlayed: this._lastPlayed.get(id) ?? 0,
    };
  },

  async _update() {
    let tabs = [];
    let ids = new Set();
    for (let { tab } of this._tabs()) {
      let info = this._describe(tab);
      if (info) {
        tabs.push(info);
        ids.add(info.id);
      }
    }
    for (let id of this._lastPlayed.keys()) {
      if (!ids.has(id)) {
        this._lastPlayed.delete(id);
      }
    }
    if (tabs.length) {
      this._startPolling();
    } else {
      this._stopPolling();
    }
    let json = JSON.stringify({ pid: Services.appinfo.processID, tabs });
    if (json == this._lastJSON) {
      return;
    }
    this._lastJSON = json;
    await IOUtils.writeUTF8(this._path, json, {
      tmpPath: this._path + ".tmp",
    });
  },

  /**
   * Runs an order from Ecosistema.
   *
   * @param {string} order "<action>:<browserId>", e.g. "toggle:12".
   */
  handleCommand(order) {
    let [action, id] = order.split(":");
    for (let { win, tab } of this._tabs()) {
      if (String(tab.linkedBrowser.browserId) != id) {
        continue;
      }
      let controller = tab.linkedBrowser.browsingContext?.mediaController;
      switch (action) {
        case "focus":
          if (win.windowState == win.STATE_MINIMIZED) {
            win.restore();
          }
          win.gBrowser.selectedTab = tab;
          win.focus();
          break;
        case "toggle":
          if (controller?.isPlaying) {
            controller.pause("user");
          } else {
            controller?.play();
          }
          break;
        case "play":
          controller?.play();
          break;
        case "pause":
          controller?.pause("user");
          break;
        case "next":
          controller?.nextTrack();
          break;
        case "previous":
          controller?.prevTrack();
          break;
      }
      break;
    }
    this._schedule();
  },
};
