/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Text for AdiOS's profile selector. AdiOS only ships en-US and es-ES, so the
// strings live here instead of in the l10n repository.
const STRINGS = {
  es: {
    title: "AdiOS · Elige perfil",
    heading: "¿Con qué perfil entras?",
    body: "Cada perfil guarda aparte sus contraseñas, marcadores, historial y pestañas.",
    open: name => `Entrar en ${name}`,
    more: name => `Más opciones de ${name}`,
    edit: "Cambiar nombre, icono y color",
    delete: name => `Eliminar ${name}…`,
    last: "Último",
    current: "Abierto ahora",
    lastUsed: when => `Última vez: ${when}`,
    today: "hoy",
    yesterday: "ayer",
    newProfile: "Nuevo perfil",
    hint: count =>
      `Pulsa ${count > 1 ? `del 1 al ${Math.min(count, 9)}` : "1"} para entrar en un perfil, o Intro para el último que usaste.`,
    ask: "Preguntar al abrir AdiOS",
    always: "Abrir siempre con",
    lastOption: "El último que usé",
  },
  en: {
    title: "AdiOS · Choose a profile",
    heading: "Which profile do you want to use?",
    body: "Each profile keeps its own passwords, bookmarks, history and tabs.",
    open: name => `Open ${name}`,
    more: name => `More options for ${name}`,
    edit: "Change name, icon and colour",
    delete: name => `Delete ${name}…`,
    last: "Last used",
    current: "Open now",
    lastUsed: when => `Last used: ${when}`,
    today: "today",
    yesterday: "yesterday",
    newProfile: "New profile",
    hint: count =>
      `Press ${count > 1 ? `1 to ${Math.min(count, 9)}` : "1"} to open a profile, or Enter for the last one you used.`,
    ask: "Ask when AdiOS opens",
    always: "Always open with",
    lastOption: "The last one I used",
  },
};

const LANG = Services.locale.appLocaleAsBCP47.startsWith("es") ? "es" : "en";

/**
 * @param {string} key The string to get.
 * @param {...any} args Values for strings that take them (a name, a date…).
 * @returns {string}
 */
export function text(key, ...args) {
  let value = STRINGS[LANG][key];
  return typeof value === "function" ? value(...args) : value;
}

/**
 * «hoy, 06:02», «ayer, 18:40» or «24 nov.», in the app's language.
 *
 * @param {number} time Milliseconds since the epoch.
 * @returns {string}
 */
export function when(time) {
  let date = new Date(time);
  let locale = Services.locale.appLocaleAsBCP47;
  let hour = date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  let today = new Date();
  today.setHours(0, 0, 0, 0);
  let day = 24 * 60 * 60 * 1000;
  if (time >= today.getTime()) {
    return `${text("today")}, ${hour}`;
  }
  if (time >= today.getTime() - day) {
    return `${text("yesterday")}, ${hour}`;
  }
  return date.toLocaleDateString(locale, { day: "numeric", month: "short" });
}
