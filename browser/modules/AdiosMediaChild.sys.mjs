/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * AdiOS: tells AdiosMedia where a page shows what it plays, so that Ecosistema
 * can show a picture of it when the page gives none: the visible part of the
 * biggest video (a playing one first) and the page's preview image.
 */
export class AdiosMediaChild extends JSWindowActorChild {
  receiveMessage(message) {
    if (message.name != "AdiosMedia:Describe") {
      return null;
    }
    let win = this.contentWindow;
    let doc = this.document;
    let video = null;
    let best = [false, 0];
    for (let element of doc.querySelectorAll("video")) {
      if (element.readyState < element.HAVE_CURRENT_DATA) {
        continue;
      }
      let rect = element.getBoundingClientRect();
      let left = Math.max(rect.left, 0);
      let top = Math.max(rect.top, 0);
      let width = Math.min(rect.right, win.innerWidth) - left;
      let height = Math.min(rect.bottom, win.innerHeight) - top;
      if (width < 160 || height < 90) {
        continue;
      }
      let score = [!element.paused, width * height];
      if (score[0] > best[0] || (score[0] == best[0] && score[1] > best[1])) {
        best = score;
        video = {
          x: left + win.scrollX,
          y: top + win.scrollY,
          width,
          height,
        };
      }
    }
    let image = "";
    let meta = doc.querySelector(
      'meta[property="og:image"], meta[name="twitter:image"]'
    );
    try {
      image = meta ? new URL(meta.content, doc.baseURI).href : "";
    } catch (e) {
      // Not a valid address.
    }
    return { video, image };
  }
}
