/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
import { html } from "chrome://global/content/vendor/lit.all.mjs";

// eslint-disable-next-line import-x/no-unassigned-import
import "chrome://browser/content/profiles/profile-card.mjs";
import {
  text,
  when,
} from "chrome://browser/content/profiles/profile-selector-strings.mjs";

const { SelectableProfile } = ChromeUtils.importESModule(
  "resource:///modules/profiles/SelectableProfile.sys.mjs"
);

/**
 * A bright colour with the hue of the profile's theme, for the card's band and
 * ring. The theme background is usually very dark, so only its hue is kept.
 *
 * @param {string} css A colour like "rgb(1,28,35)".
 * @returns {string}
 */
function toneFrom(css) {
  let [r, g, b] = (css.match(/\d+(\.\d+)?/g) || []).map(n => Number(n) / 255);
  if (r === undefined || b === undefined) {
    return "var(--color-accent-primary)";
  }
  let max = Math.max(r, g, b);
  let delta = max - Math.min(r, g, b);
  if (delta < 0.02) {
    return "var(--color-accent-primary)";
  }
  let hue;
  if (max === r) {
    hue = 60 * (((g - b) / delta) % 6);
  } else if (max === g) {
    hue = 60 * ((b - r) / delta + 2);
  } else {
    hue = 60 * ((r - g) / delta + 4);
  }
  return `hsl(${Math.round((hue + 360) % 360)} 60% 50%)`;
}

/**
 * Element used for displaying a SelectableProfile in the profile selector window
 */
export class ProfileCard extends MozLitElement {
  static properties = {
    profile: { type: SelectableProfile, reflect: true },
    index: { type: Number },
    lastUsed: { type: Number },
    isLast: { type: Boolean },
    isCurrent: { type: Boolean },
    menuOpen: { type: Boolean, state: true },
  };

  static queries = {
    avatarImage: ".profile-avatar",
    profileCard: ".profile-card",
    moreButton: ".more",
    editButton: "#edit-button",
    deleteButton: "#delete-button",
  };

  #closeMenu = event => {
    if (event.type === "keydown" && event.key !== "Escape") {
      return;
    }
    if (event.type === "click" && event.composedPath().includes(this)) {
      return;
    }
    this.menuOpen = false;
  };

  firstUpdated() {
    super.firstUpdated();

    this.setAvatarImage();
  }

  updated(changed) {
    super.updated(changed);
    if (changed.has("profile")) {
      let { themeFg, themeBg } = this.profile.theme;
      this.profileCard.style.setProperty("--tone", toneFrom(themeBg));
      this.profileCard.style.setProperty("--avatar-fill", themeBg);
      this.profileCard.style.setProperty("--avatar-stroke", themeFg);
    }
    if (!changed.has("menuOpen")) {
      return;
    }
    if (this.menuOpen) {
      document.addEventListener("click", this.#closeMenu, true);
      document.addEventListener("keydown", this.#closeMenu, true);
      this.editButton?.focus();
    } else {
      document.removeEventListener("click", this.#closeMenu, true);
      document.removeEventListener("keydown", this.#closeMenu, true);
    }
  }

  async setAvatarImage() {
    this.avatarImage.style.backgroundImage = `url(${await this.profile.getAvatarURL(48)})`;
    let { themeFg, themeBg } = this.profile.theme;
    this.avatarImage.style.fill = themeBg;
    this.avatarImage.style.stroke = themeFg;
  }

  launchProfile(url) {
    this.dispatchEvent(
      new CustomEvent("LaunchProfile", {
        bubbles: true,
        composed: true,
        detail: { profile: this.profile, url },
      })
    );
  }

  click() {
    this.handleClick();
  }

  handleClick() {
    this.launchProfile();
  }

  handleKeyDown(event) {
    if (
      event.target === this.profileCard &&
      (event.code === "Enter" || event.code === "Space")
    ) {
      event.preventDefault();
      event.stopPropagation();
      this.launchProfile();
    }
  }

  handleMoreClick(event) {
    event.stopPropagation();
    this.menuOpen = !this.menuOpen;
  }

  handleEditClick(event) {
    event.stopPropagation();
    this.menuOpen = false;
    this.launchProfile("about:editprofile");
  }

  handleDeleteClick(event) {
    event.stopPropagation();
    this.menuOpen = false;
    this.dispatchEvent(
      new CustomEvent("DeleteProfile", {
        bubbles: true,
        composed: true,
        detail: this.profile,
      })
    );
  }

  render() {
    let { name } = this.profile;
    let status = "";
    if (this.isCurrent) {
      status = html`<span class="dot"></span>${text("current")}`;
    } else if (this.lastUsed) {
      status = text("lastUsed", when(this.lastUsed));
    }
    return html`<link
        rel="stylesheet"
        href="chrome://browser/content/profiles/profile-card.css"
      />
      <div
        class="profile-card"
        role="button"
        tabindex="0"
        aria-label=${text("open", name)}
        @click=${this.handleClick}
        @keydown=${this.handleKeyDown}
      >
        <div class="band">
          ${this.index < 9
            ? html`<span class="key" aria-hidden="true"
                >${this.index + 1}</span
              >`
            : ""}
          <div class="profile-avatar"></div>
          <button
            class="more"
            aria-haspopup="menu"
            aria-expanded=${this.menuOpen ? "true" : "false"}
            title=${text("more", name)}
            aria-label=${text("more", name)}
            @click=${this.handleMoreClick}
            @keydown=${e => e.stopPropagation()}
          ></button>
        </div>
        <div class="info">
          <span class="name"
            ><span class="text-truncated-ellipsis">${name}</span>${this.isLast
              ? html`<span class="chip">${text("last")}</span>`
              : ""}</span
          >
          <span class="when">${status}</span>
        </div>
      </div>
      ${this.menuOpen
        ? html`<div class="menu" role="menu">
            <button
              id="edit-button"
              role="menuitem"
              @click=${this.handleEditClick}
            >
              <img
                src="chrome://global/skin/icons/edit-outline.svg"
                alt=""
              />${text("edit")}
            </button>
            <button
              id="delete-button"
              class="danger"
              role="menuitem"
              @click=${this.handleDeleteClick}
            >
              <img src="chrome://global/skin/icons/delete.svg" alt="" />${text(
                "delete",
                name
              )}
            </button>
          </div>`
        : ""}`;
  }
}

customElements.define("profile-card", ProfileCard);

/**
 * Element used for creating a new SelectableProfile in the profile selector window
 */
export class NewProfileCard extends MozLitElement {
  createProfile() {
    this.dispatchEvent(
      new CustomEvent("CreateProfile", {
        bubbles: true,
        composed: true,
      })
    );
  }

  click() {
    this.handleClick();
  }

  handleClick() {
    this.createProfile();
  }

  handleKeyDown(event) {
    if (event.code === "Enter" || event.code === "Space") {
      this.createProfile();
    }
  }

  render() {
    return html`<link
        rel="stylesheet"
        href="chrome://browser/content/profiles/profile-card.css"
      />
      <div
        class="profile-card new-profile-card"
        role="button"
        tabindex="0"
        @click=${this.handleClick}
        @keydown=${this.handleKeyDown}
      >
        <span class="plus"></span>
        <span>${text("newProfile")}</span>
      </div>`;
  }
}

customElements.define("new-profile-card", NewProfileCard);
