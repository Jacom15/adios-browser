/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
import { html } from "chrome://global/content/vendor/lit.all.mjs";

// eslint-disable-next-line import-x/no-unassigned-import
import "chrome://browser/content/profiles/profile-card.mjs";
// eslint-disable-next-line import-x/no-unassigned-import
import "chrome://global/content/elements/moz-toggle.mjs";
import { text } from "chrome://browser/content/profiles/profile-selector-strings.mjs";

const { SelectableProfileService } = ChromeUtils.importESModule(
  "resource:///modules/profiles/SelectableProfileService.sys.mjs"
);

/**
 * The element for display SelectableProfiles in the profile selector window
 */
export class ProfileSelector extends MozLitElement {
  static properties = {
    profiles: { type: Array },
    showSelector: { type: Boolean },
    startupProfileId: { type: Number },
  };

  static queries = {
    toggle: "moz-toggle",
    profileCards: { all: "profile-card" },
    createProfileCard: "new-profile-card",
  };

  #initPromise = null;
  #startupParams = null;

  constructor() {
    super();

    this.#initPromise = this.init();
    if (window.arguments?.[0] instanceof Ci.nsIDialogParamBlock) {
      this.#startupParams = window.arguments[0];
    }
  }

  get isStartupUI() {
    return !!this.#startupParams;
  }

  /**
   * Sets the return block for the startup UI.
   *
   * @param {SelectableProfile} profile The profile to launch
   * @param {string[]} args Any additional command line arguments to append
   */
  async setLaunchArguments(profile, args = []) {
    if (!this.#startupParams) {
      return;
    }

    this.#startupParams.SetInt(
      0,
      Ci.nsIToolkitProfileService.launchWithProfile
    );
    // Set start offline to false.
    this.#startupParams.SetInt(1, 0);
    // Number of new arguments.
    this.#startupParams.SetInt(2, args.length);

    this.#startupParams.objects.insertElementAt(await profile.rootDir, 0);
    this.#startupParams.objects.insertElementAt(await profile.localDir, 1);

    this.#startupParams.SetNumberStrings(args.length);
    for (let i = 0; i < args.length; i++) {
      this.#startupParams.SetString(i, args[i]);
    }
  }

  async getUpdateComplete() {
    let result = await super.getUpdateComplete();
    await this.#initPromise;
    return result;
  }

  async init() {
    if (this.initialized) {
      return;
    }

    document.addEventListener("LaunchProfile", this);
    document.addEventListener("CreateProfile", this);
    document.addEventListener("DeleteProfile", this);
    document.addEventListener("keydown", this);
    document.title = text("title");

    this.selectableProfileService = SelectableProfileService;

    await this.selectableProfileService.init();
    await this.selectableProfileService.maybeSetupDataStore();
    let profiles = await this.selectableProfileService.getAllProfiles();
    // When each profile was last used: prefs.js is saved while it runs and when it closes.
    this.lastUsed = new Map();
    await Promise.all(
      profiles.map(async profile => {
        try {
          let dir = await profile.rootDir;
          let info = await IOUtils.stat(PathUtils.join(dir.path, "prefs.js"));
          this.lastUsed.set(profile.id, info.lastModified);
        } catch (e) {
          // A profile that was never opened has no prefs.js yet.
        }
      })
    );
    this.startupProfileId =
      await this.selectableProfileService.getStartupProfileId();
    this.profiles = profiles;
    this.showSelector =
      this.selectableProfileService.groupToolkitProfile.showProfileSelector;

    if (!this.profiles.length) {
      await this.selectableProfileService.setShowProfileSelectorWindow(false);
    }

    this.initialized = true;
    this.#initPromise = null;

    if (this.isStartupUI) {
      window.addEventListener("unload", () => {
        // In case the user closed the window manually.
        this.selectableProfileService.uninit();
      });
    }
  }

  /** The profile used most recently, which Enter opens. */
  get lastUsedProfile() {
    let best = null;
    for (let profile of this.profiles ?? []) {
      if (
        !best ||
        (this.lastUsed.get(profile.id) ?? 0) > (this.lastUsed.get(best.id) ?? 0)
      ) {
        best = profile;
      }
    }
    return best;
  }

  async handleAlwaysChange(event) {
    let id = Number(event.target.value);
    this.startupProfileId = id;
    await this.selectableProfileService.setStartupProfile(
      this.profiles.find(p => p.id === id) ?? null
    );
  }

  /** 1 to 9 open that profile; Enter opens the last one used. */
  handleKeyDown(event) {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return;
    }
    let target = event.composedPath()[0] ?? event.target;
    if (target.closest?.("select, input, button, moz-toggle")) {
      return;
    }
    let number = parseInt(event.key, 10);
    let profile = null;
    if (number >= 1 && number <= Math.min(9, this.profiles?.length ?? 0)) {
      profile = this.profiles[number - 1];
    } else if (event.key === "Enter") {
      profile = this.lastUsedProfile;
    }
    if (profile) {
      event.preventDefault();
      Glean.profilesSelectorWindow.launch.record();
      this.launchProfile(profile);
    }
  }

  handleCheckboxToggle() {
    this.showSelector = this.toggle.pressed;
    let state = this.showSelector ? "enabled" : "disabled";
    Glean.profilesSelectorWindow.showAtStartup.record({ value: state });
    this.selectableProfileService.setShowProfileSelectorWindow(
      this.showSelector
    );
  }

  async launchProfile(profile, url) {
    if (this.isStartupUI) {
      await this.setLaunchArguments(profile, url ? ["-url", url] : []);
      await this.selectableProfileService.uninit();
    } else {
      this.selectableProfileService.launchInstance(profile, url ? [url] : []);
    }

    window.close();
  }

  async handleEvent(event) {
    switch (event.type) {
      case "keydown": {
        this.handleKeyDown(event);
        break;
      }
      case "LaunchProfile": {
        Glean.profilesSelectorWindow.launch.record();
        let { profile, url } = event.detail;
        await this.launchProfile(profile, url);
        break;
      }
      case "CreateProfile": {
        let profile = await this.selectableProfileService.createNewProfile(
          false,
          null,
          this.isStartupUI ? "selector-startup" : "selector-runtime"
        );
        await this.launchProfile(profile, "about:newprofile");
        break;
      }
      case "DeleteProfile": {
        let profile = event.detail;
        await this.launchProfile(profile, "about:deleteprofile");
        break;
      }
    }
  }

  render() {
    if (!this.profiles) {
      return null;
    }
    let currentId = this.isStartupUI
      ? null
      : this.selectableProfileService.currentProfile?.id;

    return html`<link
        rel="stylesheet"
        href="chrome://browser/content/profiles/profile-selector.css"
      />
      <link
        rel="stylesheet"
        href="chrome://global/skin/in-content/common.css"
      />
      <header class="heading">
        <img
          class="logo"
          alt=""
          src="chrome://branding/content/about-logo.svg"
        />
        <div>
          <h1>${text("heading")}</h1>
          <p class="profiles-body-text">${text("body")}</p>
        </div>
      </header>
      <div class="profile-list">
        ${this.profiles.map(
          (p, i) =>
            html`<profile-card
              .profile=${p}
              .index=${i}
              .lastUsed=${this.lastUsed.get(p.id) ?? 0}
              .isLast=${p.id === this.lastUsedProfile?.id}
              .isCurrent=${p.id === currentId}
            ></profile-card>`
        )}
        <new-profile-card></new-profile-card>
      </div>
      <p class="hint">${text("hint", this.profiles.length)}</p>
      <footer class="footer">
        <moz-toggle
          .pressed=${this.showSelector}
          label=${text("ask")}
          @toggle=${this.handleCheckboxToggle}
        ></moz-toggle>
        ${this.showSelector
          ? ""
          : html`<label class="always"
              >${text("always")}
              <select @change=${this.handleAlwaysChange}>
                <option value="0" ?selected=${!this.startupProfileId}>
                  ${text("lastOption")}
                </option>
                ${this.profiles.map(
                  p =>
                    html`<option
                      value=${p.id}
                      ?selected=${p.id === this.startupProfileId}
                    >
                      ${p.name}
                    </option>`
                )}
              </select></label
            >`}
      </footer>`;
  }
}

customElements.define("profile-selector", ProfileSelector);
