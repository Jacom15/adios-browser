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
 * Private windows are never listed. When a page gives no picture of what it
 * plays, a frame of its video is saved in <profile>/adios-sonando/.
 */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const FILE_NAME = "adios-sonando.json";
const WATCHED_ATTRIBUTES = [
  "soundplaying",
  "soundplaying-scheduledremoval",
  "muted",
  "label",
  "image",
];
const CONTROLLER_EVENTS = [
  "activated",
  "deactivated",
  "audiblechange",
  "playbackstatechange",
  "metadatachange",
  "positionstatechange",
];
// Width of the saved video frames, and how often they are taken again while
// the video plays.
const SNAPSHOT_WIDTH = 480;
const SNAPSHOT_EVERY_MS = 60000;
const SNAPSHOT_RETRY_MS = 2000;

export const AdiosMedia = {
  _initialized: false,
  _pending: null,
  _pendingAt: 0,
  _poll: null,
  _lastJSON: "",
  // browserId -> { playing, at }: when it last started or stopped playing, to
  // sort the list without rewriting the file while it keeps playing.
  _lastPlayed: new Map(),
  // browserId -> { duration, position, rate, at } from the page's player.
  _positions: new Map(),
  // browserId -> { title, at, path, image }: the saved frame and the page's
  // preview image.
  _pictures: new Map(),
  _capturing: false,
  _controllers: new WeakSet(),

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    ChromeUtils.registerWindowActor("AdiosMedia", {
      child: { esModuleURI: "resource:///modules/AdiosMediaChild.sys.mjs" },
      matches: ["http://*/*", "https://*/*"],
      messageManagerGroups: ["browsers"],
      // The child only reports where the page shows its video, and that is
      // checked here before it is used.
      safeForUntrustedWebProcess: true,
    });
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

  get _picturesDir() {
    return PathUtils.join(PathUtils.profileDir, "adios-sonando");
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
      IOUtils.remove(this._picturesDir, {
        recursive: true,
        ignoreAbsent: true,
      }).catch(() => {});
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
        this._schedule(50);
      }
    });
    tabs.addEventListener("TabClose", () => this._schedule(50));
    win.addEventListener("unload", () => this._schedule());
  },

  // The page's player tells at once when it plays, pauses or ends.
  _watchController(browser) {
    let controller = browser.browsingContext?.mediaController;
    if (!controller || this._controllers.has(controller)) {
      return controller;
    }
    this._controllers.add(controller);
    let id = String(browser.browserId);
    for (let type of CONTROLLER_EVENTS) {
      controller.addEventListener(type, event => {
        if (type == "positionstatechange") {
          this._positions.set(id, {
            duration: event.duration,
            position: event.position,
            rate: event.playbackRate,
            at: Date.now(),
          });
        }
        this._schedule(50);
      });
    }
    return controller;
  },

  _schedule(delay = 300) {
    let at = Date.now() + delay;
    if (this._pending) {
      if (this._pendingAt <= at) {
        return;
      }
      lazy.clearTimeout(this._pending);
    }
    this._pendingAt = at;
    this._pending = lazy.setTimeout(() => {
      this._pending = null;
      this._update().catch(console.error);
    }, delay);
  },

  // Changing song or title does not always touch the tab, so while something
  // is listed it is checked every few seconds.
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
    let controller = this._watchController(browser);
    // A video that ended (or left the page) leaves nothing to control, even if
    // the page keeps its media session.
    let controlled = !!(
      controller?.isActive && controller.isAnyMediaBeingControlled
    );
    // The tab keeps its sound icon a few seconds after the sound stops; that
    // is not playing any more.
    let audible =
      tab.soundPlaying && !tab.hasAttribute("soundplaying-scheduledremoval");
    if (!controlled && !audible) {
      return null;
    }
    let metadata = {};
    try {
      metadata = (controlled && controller.getMetadata()) || {};
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
    let playing = controlled ? controller.isPlaying : audible;
    let last = this._lastPlayed.get(id);
    if (!last) {
      last = { playing, at: playing ? Date.now() : 0 };
      this._lastPlayed.set(id, last);
    } else if (last.playing != playing) {
      last.playing = playing;
      last.at = Date.now();
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
    let position = (controlled && this._positions.get(id)) || {};
    let picture = this._pictures.get(id);
    return {
      id,
      title: metadata.title || tab.label,
      artist: metadata.artist || "",
      album: metadata.album || "",
      site,
      playing,
      audible: tab.soundPlaying,
      muted: tab.muted,
      canControl: controlled,
      artwork,
      snapshot: artwork ? "" : picture?.path || "",
      pageImage: picture?.image || "",
      icon: tab.image?.startsWith("http") ? tab.image : "",
      lastPlayed: last.at,
      duration: Number.isFinite(position.duration) ? position.duration : 0,
      position: position.position || 0,
      positionAt: position.at || 0,
      rate: position.rate ?? 1,
    };
  },

  async _update() {
    let tabs = [];
    let listed = [];
    let ids = new Set();
    for (let { win, tab } of this._tabs()) {
      let info = this._describe(tab);
      if (info) {
        tabs.push(info);
        listed.push({ win, tab, info });
        ids.add(info.id);
      }
    }
    for (let map of [this._lastPlayed, this._positions, this._pictures]) {
      for (let [id, value] of map) {
        if (!ids.has(id)) {
          map.delete(id);
          if (value.path) {
            IOUtils.remove(value.path, { ignoreAbsent: true }).catch(() => {});
          }
        }
      }
    }
    if (tabs.length) {
      this._startPolling();
    } else {
      this._stopPolling();
    }
    for (let { win, tab, info } of listed) {
      this._maybeTakePicture(win, tab, info);
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

  // Only for pages that give no picture of what they play. One at a time, again
  // when the title changes and every minute while it plays.
  _maybeTakePicture(win, tab, info) {
    if (info.artwork || this._capturing) {
      return;
    }
    let previous = this._pictures.get(info.id);
    // Until a frame is drawn (the video may not have one yet), it is tried
    // again sooner, less and less often.
    let every = previous?.path
      ? SNAPSHOT_EVERY_MS
      : Math.min(SNAPSHOT_RETRY_MS * 2 ** (previous?.failures ?? 0), 60000);
    if (
      previous?.title == info.title &&
      (!info.playing || Date.now() - previous.at < every)
    ) {
      return;
    }
    this._capturing = true;
    this._takePicture(win, tab, info, previous)
      .catch(() => {
        // The page went away or cannot be drawn; it keeps its icon.
      })
      .finally(() => {
        this._capturing = false;
      });
  },

  async _takePicture(win, tab, info, previous) {
    let picture = {
      title: info.title,
      at: Date.now(),
      path: previous?.path ?? "",
      image: previous?.image ?? "",
      failures: previous?.title == info.title ? (previous.failures ?? 0) : 0,
    };
    this._pictures.set(info.id, picture);
    let browser = tab.linkedBrowser;
    let actor =
      browser.browsingContext?.currentWindowGlobal?.getActor("AdiosMedia");
    let page = await actor?.sendQuery("AdiosMedia:Describe");
    if (typeof page?.image == "string" && page.image.startsWith("https:")) {
      picture.image = page.image.slice(0, 2048);
    }
    let video = page?.video;
    let inPage = (value, max) =>
      typeof value == "number" && value >= 0 && value <= max;
    let bytes = null;
    if (
      inPage(video?.x, 1e6) &&
      inPage(video.y, 1e6) &&
      inPage(video.width, 16384) &&
      inPage(video.height, 16384) &&
      video.width >= 160 &&
      video.height >= 90
    ) {
      let scale = Math.min(1, SNAPSHOT_WIDTH / video.width);
      let bitmap = await browser.drawSnapshot(
        video.x,
        video.y,
        video.width,
        video.height,
        scale,
        "black"
      );
      bytes = bitmap && (await this._toJPEG(win, bitmap));
    }
    if (bytes && this._pictures.get(info.id) == picture) {
      await IOUtils.makeDirectory(this._picturesDir, { ignoreExisting: true });
      let path = PathUtils.join(
        this._picturesDir,
        `${info.id}-${picture.at}.jpg`
      );
      await IOUtils.write(path, bytes);
      if (picture.path) {
        IOUtils.remove(picture.path, { ignoreAbsent: true }).catch(() => {});
      }
      picture.path = path;
      picture.failures = 0;
    } else {
      picture.failures++;
    }
    this._schedule(0);
  },

  async _toJPEG(win, bitmap) {
    let canvas = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas"
    );
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    let context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    // A black frame (a video not drawn in a background tab, protected
    // content) shows nothing.
    let { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let light = 0;
    let samples = 0;
    for (let i = 0; i < data.length; i += 64) {
      light += data[i] + data[i + 1] + data[i + 2];
      samples++;
    }
    if (!samples || light / samples < 30) {
      return null;
    }
    let blob = await new Promise(resolve =>
      canvas.toBlob(resolve, "image/jpeg", 0.85)
    );
    return blob && new Uint8Array(await blob.arrayBuffer());
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
    this._schedule(50);
  },
};
