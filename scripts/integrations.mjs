/** @file Soft-detection of and interoperation with Plutonium and Spell Book. */

import { MODULE_ID, PLUTONIUM_ID, PLUTONIUM_LOOKUP_PATH, SB, SPELLBOOK_ID } from "./constants.mjs";
import { log } from "./util.mjs";

/** @returns {boolean} Whether Plutonium is installed and active. */
export function isPlutoniumActive() {
  return !!game.modules.get(PLUTONIUM_ID)?.active;
}

/** @returns {boolean} Whether Spell Book is installed and active. */
export function isSpellBookActive() {
  return !!game.modules.get(SPELLBOOK_ID)?.active;
}

let _lookupPromise = null;

/**
 * Load (once) Plutonium's 5etools spell→class/subclass lookup table.
 * Structure: `lookup[spellSourceLower][spellNameLower] = { class, subclass, ... }`
 * (see NOTES.md §3.3).
 * @returns {Promise<object|null>} The lookup, or null when Plutonium is absent or the fetch fails.
 */
export async function getPlutoniumSpellLookup() {
  if (!isPlutoniumActive()) return null;
  _lookupPromise ??= foundry.utils
    .fetchJsonWithTimeout(PLUTONIUM_LOOKUP_PATH)
    .catch(err => {
      log("Failed to load Plutonium spell-source lookup", err);
      return null;
    });
  return _lookupPromise;
}

/**
 * Append UUIDs to one of Spell Book's array-of-uuids world settings, skipping
 * ones already present. No-op when Spell Book is absent.
 * @param {string} settingKey  Spell Book setting key holding an array of UUIDs.
 * @param {string[]} uuids     UUIDs to append.
 * @returns {Promise<number>} Number of UUIDs newly added.
 */
async function appendToSpellBookListSetting(settingKey, uuids) {
  if (!isSpellBookActive() || !uuids.length) return 0;
  try {
    const stored = game.settings.get(SPELLBOOK_ID, settingKey) ?? [];
    const existing = Array.isArray(stored) ? stored : [];
    const missing = uuids.filter(u => !existing.includes(u));
    if (missing.length) await game.settings.set(SPELLBOOK_ID, settingKey, [...existing, ...missing]);
    return missing.length;
  } catch (err) {
    log(`Could not update Spell Book ${settingKey}`, err);
    return 0;
  }
}

/**
 * Ensure the given page UUIDs are present in Spell Book's `registryEnabledLists`
 * world setting (its per-list "registry toggle"), so Spell Book re-registers them
 * with the dnd5e registry on every reload.
 * @param {string[]} uuids  Journal page UUIDs to enable.
 * @returns {Promise<number>} Number of UUIDs newly added.
 */
export function ensureSpellBookRegistryToggle(uuids) {
  return appendToSpellBookListSetting(SB.SETTING_REGISTRY_ENABLED, uuids);
}

/**
 * Add source-list page UUIDs to Spell Book's `hiddenSpellLists` setting so the
 * originals stop cluttering its pickers after a merge.
 * @param {string[]} uuids  Page UUIDs of source lists to hide.
 * @returns {Promise<number>} Number of UUIDs newly hidden.
 */
export function hideSourceListsInSpellBook(uuids) {
  return appendToSpellBookListSetting(SB.SETTING_HIDDEN_LISTS, uuids);
}

/**
 * Assign a generated list page to every world actor that has the class but no
 * custom spell list configured in Spell Book. Never overwrites an existing
 * assignment. No-op without Spell Book.
 * @param {string} classIdentifier          Class identifier (e.g. "wizard").
 * @param {string} pageUuid                 UUID of the generated page.
 * @param {string} [subclassIdentifier]     When set, assign as subclass list instead.
 * @returns {Promise<string[]>} Names of actors that received the assignment.
 */
export async function assignListToActors(classIdentifier, pageUuid, subclassIdentifier) {
  if (!isSpellBookActive()) return [];
  const key = subclassIdentifier ? "customSubclassSpellList" : "customSpellList";
  const assigned = [];
  for (const actor of game.actors) {
    if (actor.type !== "character") continue;
    if (!actor.spellcastingClasses?.[classIdentifier]) continue;
    if (subclassIdentifier) {
      const subclass = actor.itemTypes.subclass?.find(s => s.identifier === subclassIdentifier);
      if (!subclass) continue;
    }
    try {
      const rules = foundry.utils.deepClone(actor.getFlag(SPELLBOOK_ID, SB.FLAG_CLASS_RULES) ?? {});
      const classRules = rules[classIdentifier] ?? {};
      const current = Array.isArray(classRules[key]) ? classRules[key] : classRules[key] ? [classRules[key]] : [];
      if (current.length) continue; // Never clobber an explicit choice.
      classRules[key] = [pageUuid];
      rules[classIdentifier] = classRules;
      await actor.setFlag(SPELLBOOK_ID, SB.FLAG_CLASS_RULES, rules);
      assigned.push(actor.name);
    } catch (err) {
      log(`Failed to assign list to actor ${actor.name}`, err);
    }
  }
  return assigned;
}

/**
 * Wrapper around Spell Book's `spellsNotInLists()` diagnostic dialog.
 * @returns {Promise<void>}
 */
export async function spellsNotInLists() {
  const api = game.modules.get(SPELLBOOK_ID)?.api;
  if (api?.spellsNotInLists) return api.spellsNotInLists();
  ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notify.noSpellBook`));
}
