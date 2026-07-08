/** @file Small shared helpers. */

import { MODULE_ID } from "./constants.mjs";

/**
 * Namespaced console logger.
 * @param {string} message   Message to log.
 * @param {...*} rest        Extra values (an Error switches to console.error).
 */
export function log(message, ...rest) {
  const fn = rest.some(r => r instanceof Error) ? console.error : console.log;
  fn(`${MODULE_ID} | ${message}`, ...rest);
}

/**
 * dnd5e-style identifier from a display name ("Eldritch Knight" → "eldritch-knight").
 * Uses the system helper when available so slugs always match class items.
 * @param {string} name  Display name.
 * @returns {string} Identifier slug.
 */
export function toIdentifier(name) {
  if (globalThis.dnd5e?.utils?.formatIdentifier) return dnd5e.utils.formatIdentifier(name);
  return String(name).replaceAll(/(\w+)([\\|/])(\w+)/g, "$1-$3").slugify({ strict: true });
}

/**
 * Split an array into chunks of at most `size` elements.
 * @template T
 * @param {T[]} arr    Source array.
 * @param {number} size  Maximum chunk length (min 1).
 * @returns {T[][]} Chunks.
 */
export function chunk(arr, size) {
  size = Math.max(1, size | 0);
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Guard: warn and return false when the current user is not a GM.
 * @returns {boolean} Whether the user is a GM.
 */
export function requireGM() {
  if (game.user.isGM) return true;
  ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notify.gmOnly`));
  return false;
}

/**
 * Download a JSON-serializable object as a file.
 * @param {object} data      Data to export.
 * @param {string} filename  Suggested file name.
 */
export function exportJson(data, filename) {
  const save = foundry.utils.saveDataToFile ?? globalThis.saveDataToFile;
  save(JSON.stringify(data, null, 2), "application/json", filename);
}
