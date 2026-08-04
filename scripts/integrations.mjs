/** @file Soft-detection of and interoperation with Plutonium and Spell Book. */

import { MODULE_ID, PACK_ID, PAGE_FLAGS, PLUTONIUM_ID, PLUTONIUM_LOOKUP_PATH, SB, SPELLBOOK_ID } from "./constants.mjs";
import { log } from "./util.mjs";

/**
 * Normalize a Spell Book class-rules list value to an array.
 * @param {string[]|string|undefined} value
 * @returns {string[]}
 */
function toArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

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
      const current = toArray(classRules[key]);
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
 * Repair actor class-rule assignments that point at generated pages which no
 * longer exist — e.g. the pack's journal was recreated, so every actor still
 * referencing the old journal id resolves to nothing and Spell Book shows an
 * empty tab (blaming disabled Compendium Browser sources).
 *
 * Only UUIDs inside this module's own pack are touched: a dead one is
 * repointed to the current page for the same class/subclass identifier, or
 * dropped when no replacement exists (so Spell Book reports "no list assigned"
 * truthfully instead of showing an empty list). Foreign lists are never
 * modified.
 * @param {JournalEntryPage[]} pages  Live generated pages.
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]  Report without writing.
 * @returns {Promise<{repaired: object[], dropped: object[]}>} What was (or would be) changed.
 */
export async function healActorAssignments(pages, { dryRun = false } = {}) {
  const result = { repaired: [], dropped: [] };
  if (!isSpellBookActive()) return result;

  const ourPrefix = `Compendium.${PACK_ID}.`;
  const live = new Set();
  /** @type {Map<string, string>} classIdentifier → page uuid */
  const byClass = new Map();
  /** @type {Map<string, string>} `${classId}/${subclassId}` → page uuid */
  const bySubclass = new Map();
  for (const page of pages) {
    live.add(page.uuid);
    if (page.system.type === "class") byClass.set(page.system.identifier, page.uuid);
    else if (page.system.type === "subclass") {
      const classId = page.getFlag(MODULE_ID, PAGE_FLAGS.CLASS_IDENTIFIER);
      if (classId) bySubclass.set(`${classId}/${page.system.identifier}`, page.uuid);
    }
  }

  for (const actor of game.actors) {
    const stored = actor.getFlag(SPELLBOOK_ID, SB.FLAG_CLASS_RULES);
    if (!stored || !Object.keys(stored).length) continue;
    const rules = foundry.utils.deepClone(stored);
    let changed = false;

    for (const [classId, config] of Object.entries(rules)) {
      if (!config || typeof config !== "object") continue;
      for (const key of ["customSpellList", "customSubclassSpellList"]) {
        const current = toArray(config[key]);
        if (!current.length) continue;
        const next = [];
        for (const uuid of current) {
          // Keep anything that is not ours, and anything still alive.
          if (!uuid.startsWith(ourPrefix) || live.has(uuid)) {
            next.push(uuid);
            continue;
          }
          let replacement = null;
          if (key === "customSpellList") {
            replacement = byClass.get(classId) ?? null;
          } else {
            // Pick the generated page of a subclass this actor actually has.
            for (const sc of actor.itemTypes?.subclass ?? []) {
              if (sc.system?.classIdentifier !== classId) continue;
              const candidate = bySubclass.get(`${classId}/${sc.identifier}`);
              if (candidate) {
                replacement = candidate;
                break;
              }
            }
          }
          changed = true;
          if (replacement) {
            if (!next.includes(replacement)) next.push(replacement);
            result.repaired.push({ actor: actor.name, classIdentifier: classId, key, from: uuid, to: replacement });
          } else {
            result.dropped.push({ actor: actor.name, classIdentifier: classId, key, from: uuid });
          }
        }
        config[key] = next;
      }
    }

    if (!changed || dryRun) continue;
    try {
      await actor.setFlag(SPELLBOOK_ID, SB.FLAG_CLASS_RULES, rules);
    } catch (err) {
      log(`Failed to repair assignments on actor ${actor.name}`, err);
    }
  }

  if (result.repaired.length || result.dropped.length) {
    log(`Assignment repair${dryRun ? " (dry run)" : ""}: ${result.repaired.length} repointed, ${result.dropped.length} dropped`, result);
  }
  return result;
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
