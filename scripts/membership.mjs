/** @file Resolves spell→class/subclass membership from overrides, Plutonium flags, and the 5etools lookup. */

import { MODULE_ID, PLUTONIUM_ID, SETTINGS } from "./constants.mjs";
import { getPlutoniumSpellLookup } from "./integrations.mjs";
import { log, toIdentifier } from "./util.mjs";

/**
 * @typedef {object} MembershipIndex
 * @property {Map<string, Set<string>>} classes     classIdentifier → Set of spell UUIDs
 * @property {Map<string, Set<string>>} subclasses  `${classId}/${subclassId}` → Set of spell UUIDs
 * @property {Map<string, string>} subclassNames    `${classId}/${subclassId}` → display name
 * @property {Map<string, Set<string>>} excludes  `class:${id}` / `subclass:${classId}/${scId}` → excluded spell UUIDs
 * @property {{name: string, uuid: string, source: string}[]} unmapped  Plutonium spells with no class resolution
 * @property {string[]} unresolvedOverrides  Override entries that matched no spell
 * @property {string[]} warnings  Human-readable warnings
 */

/**
 * @typedef {object} SourcePackScan
 * @property {CompendiumCollection[]} packs  Packs that were scanned
 * @property {{uuid: string, name: string, plutonium: object|undefined}[]} spells
 * @property {{identifier: string, name: string, progression: string}[]} classes
 * @property {{identifier: string, classIdentifier: string, name: string}[]} subclasses
 * @property {Map<string, string[]>} byName  lowercase spell name → uuids
 */

/** Index fields for the single source-pack scan (spells + classes + subclasses in one pass). */
const INDEX_FIELDS = [
  "type",
  "name",
  "system.identifier",
  "system.classIdentifier",
  "system.spellcasting.progression",
  `flags.${PLUTONIUM_ID}`
];

/**
 * Get the configured source packs (Item compendiums scanned for spells).
 * Defaults to every visible Item pack when the setting is empty.
 * @returns {CompendiumCollection[]} Item packs to scan.
 */
export function getSourcePacks() {
  const configured = game.settings.get(MODULE_ID, SETTINGS.SOURCE_PACKS) ?? [];
  const all = game.packs.filter(p => p.metadata.type === "Item");
  if (!configured.length) return all;
  return all.filter(p => configured.includes(p.collection));
}

/**
 * Index every source pack exactly once, collecting spell and class entries
 * together. Callers that need both (planReconcile) share one scan instead of
 * indexing each pack twice.
 * @returns {Promise<SourcePackScan>} The scan result.
 */
export async function scanSourcePacks() {
  /** @type {SourcePackScan} */
  const scan = { packs: getSourcePacks(), spells: [], classes: [], subclasses: [], byName: new Map() };
  for (const pack of scan.packs) {
    let packIndex;
    try {
      packIndex = await pack.getIndex({ fields: INDEX_FIELDS });
    } catch (err) {
      log(`Could not index pack ${pack.collection}`, err);
      continue;
    }
    for (const entry of packIndex) {
      if (entry.type === "spell") {
        scan.spells.push({ uuid: entry.uuid, name: entry.name, plutonium: entry.flags?.[PLUTONIUM_ID] });
        const key = entry.name.toLowerCase();
        if (!scan.byName.has(key)) scan.byName.set(key, []);
        scan.byName.get(key).push(entry.uuid);
      } else if (entry.type === "class") {
        scan.classes.push({
          identifier: entry.system?.identifier || toIdentifier(entry.name),
          name: entry.name,
          progression: entry.system?.spellcasting?.progression ?? "none"
        });
      } else if (entry.type === "subclass") {
        scan.subclasses.push({
          identifier: entry.system?.identifier || toIdentifier(entry.name),
          classIdentifier: entry.system?.classIdentifier ?? "",
          name: entry.name
        });
      }
    }
  }
  return scan;
}

/**
 * Deep-union two override nodes ({spells, exclude, subclasses}).
 * @param {object} [a]
 * @param {object} [b]
 * @returns {object}
 */
function mergeOverrideNode(a = {}, b = {}) {
  const out = {
    spells: [...new Set([...(a.spells ?? []), ...(b.spells ?? [])])],
    exclude: [...new Set([...(a.exclude ?? []), ...(b.exclude ?? [])])]
  };
  const subKeys = new Set([...Object.keys(a.subclasses ?? {}), ...Object.keys(b.subclasses ?? {})]);
  if (subKeys.size) {
    out.subclasses = {};
    for (const key of subKeys) out.subclasses[key] = mergeOverrideNode(a.subclasses?.[key], b.subclasses?.[key]);
  }
  return out;
}

/**
 * Load the effective override mapping: the configured JSON file merged with the
 * world-setting store written by the list-editor window.
 * @returns {Promise<object>} Merged overrides (empty object when none).
 */
export async function loadOverrides() {
  let file = {};
  const path = (game.settings.get(MODULE_ID, SETTINGS.OVERRIDE_PATH) ?? "").trim();
  if (path) {
    try {
      file = (await foundry.utils.fetchJsonWithTimeout(path)) ?? {};
    } catch (err) {
      log(`Failed to load override mapping from "${path}"`, err);
      ui.notifications.error(game.i18n.format(`${MODULE_ID}.notify.overrideLoadFailed`, { path }));
    }
  }
  const stored = game.settings.get(MODULE_ID, SETTINGS.UI_OVERRIDES) ?? {};
  const merged = {};
  for (const classId of new Set([...Object.keys(file), ...Object.keys(stored)])) {
    merged[classId] = mergeOverrideNode(file[classId], stored[classId]);
  }
  return merged;
}

/**
 * Persist a list edit from the editor window into the world-setting override
 * store. Adds win over previous excludes and vice versa (last edit wins).
 * @param {object} args
 * @param {string} args.classIdentifier          Class identifier the list belongs to.
 * @param {string} [args.subclassIdentifier]     Set for subclass lists.
 * @param {string[]} [args.adds]                 Spell UUIDs added manually.
 * @param {string[]} [args.excludes]             Spell UUIDs removed manually.
 * @returns {Promise<void>}
 */
export async function saveListOverride({ classIdentifier, subclassIdentifier, adds = [], excludes = [] }) {
  const store = foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTINGS.UI_OVERRIDES) ?? {});
  const cls = (store[classIdentifier] ??= {});
  const node = subclassIdentifier ? ((cls.subclasses ??= {})[subclassIdentifier] ??= {}) : cls;
  const spells = new Set(node.spells ?? []);
  const exclude = new Set(node.exclude ?? []);
  for (const uuid of adds) {
    spells.add(uuid);
    exclude.delete(uuid);
  }
  for (const uuid of excludes) {
    exclude.add(uuid);
    spells.delete(uuid);
  }
  node.spells = [...spells];
  node.exclude = [...exclude];
  await game.settings.set(MODULE_ID, SETTINGS.UI_OVERRIDES, store);
}

/**
 * Original 5etools name from a Plutonium hash ("fire%20bolt_phb" → "fire bolt"),
 * for spells renamed at import time or edited afterwards.
 * @param {string} hash  Value of `flags.plutonium.hash`.
 * @returns {string|null} Lowercased original name, or null when underivable.
 */
function nameFromHash(hash) {
  if (typeof hash !== "string" || !hash) return null;
  try {
    const decoded = decodeURIComponent(hash);
    const cut = decoded.lastIndexOf("_");
    return cut > 0 ? decoded.slice(0, cut).toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Build the full membership index from all sources, in priority order:
 * 1. override JSON, 2. Plutonium flags (`spellClassNames` / lookup), 3. left to
 * the caller (existing registered lists are merged during planning).
 * @param {object} [options]
 * @param {object} [options.overrides]      Preloaded override mapping (avoids a second fetch).
 * @param {SourcePackScan} [options.scan]   Preloaded source-pack scan (avoids re-indexing).
 * @returns {Promise<MembershipIndex>} The resolved index.
 */
export async function buildMembershipIndex({ overrides, scan } = {}) {
  /** @type {MembershipIndex} */
  const index = {
    classes: new Map(),
    subclasses: new Map(),
    subclassNames: new Map(),
    excludes: new Map(),
    unmapped: [],
    unresolvedOverrides: [],
    warnings: []
  };

  scan ??= await scanSourcePacks();
  overrides ??= await loadOverrides();
  const lookup = await getPlutoniumSpellLookup();

  const addClass = (identifier, uuid) => {
    if (!index.classes.has(identifier)) index.classes.set(identifier, new Set());
    index.classes.get(identifier).add(uuid);
  };
  const addSubclass = (classId, subclassId, name, uuid) => {
    const key = `${classId}/${subclassId}`;
    if (!index.subclasses.has(key)) index.subclasses.set(key, new Set());
    index.subclasses.get(key).add(uuid);
    if (name) index.subclassNames.set(key, name);
  };

  // 2. Plutonium-derived membership (flags first, lookup fallback).
  for (const spell of scan.spells) {
    const flags = spell.plutonium;
    if (!flags) continue;
    let mapped = false;

    if (Array.isArray(flags.spellClassNames) && flags.spellClassNames.length) {
      for (const className of flags.spellClassNames) addClass(toIdentifier(className), spell.uuid);
      mapped = true;
    }

    // Current display name first; the hash-derived original name covers spells
    // renamed at import (Plutonium source-suffix options) or edited by the GM.
    const bySrc = lookup?.[String(flags.source ?? "").toLowerCase()];
    const lookupEntry = bySrc?.[spell.name.toLowerCase()] ?? bySrc?.[nameFromHash(flags.hash)];
    if (lookupEntry) {
      // `class` = base list membership; `classVariant` = expanded-list membership
      // (XGE/TCE style). Both are keyed classSource → className; only the leaf
      // values differ (`true` vs `{definedInSources}`), which we don't need.
      for (const groupKey of ["class", "classVariant"]) {
        for (const bySource of Object.values(lookupEntry[groupKey] ?? {})) {
          for (const className of Object.keys(bySource)) addClass(toIdentifier(className), spell.uuid);
          mapped ||= Object.keys(bySource).length > 0;
        }
      }
      for (const bySource of Object.values(lookupEntry.subclass ?? {})) {
        for (const [className, byScSource] of Object.entries(bySource)) {
          for (const scGroup of Object.values(byScSource)) {
            for (const [scShortName, scData] of Object.entries(scGroup)) {
              // Identifier from the full subclass name ("College of Lore" → "college-of-lore"),
              // matching how Plutonium slugs subclass items; the lookup key is only the short name.
              const scName = scData?.name ?? scShortName;
              addSubclass(toIdentifier(className), toIdentifier(scName), scName, spell.uuid);
              mapped = true;
            }
          }
        }
      }
    }

    if (!mapped) index.unmapped.push({ name: spell.name, uuid: spell.uuid, source: flags.source ?? "?" });
  }

  // 1. Overrides — authoritative, applied last so they always land, and reported when unresolved.
  // Name resolution runs first so spell names containing "." are not mistaken for UUIDs.
  const resolveRef = ref => {
    if (typeof ref !== "string" || !ref) return [];
    if (ref.startsWith("uuid://")) ref = ref.slice("uuid://".length);
    const named = scan.byName.get(ref.toLowerCase());
    if (named?.length) return named;
    try {
      return foundry.utils.parseUuid(ref)?.documentId ? [ref] : [];
    } catch {
      return [];
    }
  };

  const addExclude = (key, uuid) => {
    if (!index.excludes.has(key)) index.excludes.set(key, new Set());
    index.excludes.get(key).add(uuid);
  };

  for (const [classId, config] of Object.entries(overrides)) {
    for (const ref of config?.spells ?? []) {
      const uuids = resolveRef(ref);
      if (!uuids.length) index.unresolvedOverrides.push(`${classId}: ${ref}`);
      for (const uuid of uuids) addClass(classId, uuid);
    }
    for (const ref of config?.exclude ?? []) {
      for (const uuid of resolveRef(ref)) addExclude(`class:${classId}`, uuid);
    }
    for (const [subclassId, scConfig] of Object.entries(config?.subclasses ?? {})) {
      for (const ref of scConfig?.spells ?? []) {
        const uuids = resolveRef(ref);
        if (!uuids.length) index.unresolvedOverrides.push(`${classId}/${subclassId}: ${ref}`);
        for (const uuid of uuids) addSubclass(classId, subclassId, undefined, uuid);
      }
      for (const ref of scConfig?.exclude ?? []) {
        for (const uuid of resolveRef(ref)) addExclude(`subclass:${classId}/${subclassId}`, uuid);
      }
    }
  }

  if (!scan.packs.length) index.warnings.push(game.i18n.localize(`${MODULE_ID}.notify.noSourcePacks`));
  if (!lookup && scan.spells.some(s => s.plutonium && !s.plutonium.spellClassNames)) {
    index.warnings.push(game.i18n.localize(`${MODULE_ID}.notify.noLookup`));
  }

  return index;
}

/**
 * @typedef {object} TargetClass
 * @property {string} identifier   Real `system.identifier` of the class item
 * @property {string} name         Display name
 * @property {string} progression  Spellcasting progression ("none" when non-caster)
 * @property {boolean} fromOverride  Whether this target exists only in the override JSON
 */

/**
 * Collect target classes: embedded classes on world actors, class items in
 * source packs, and override JSON keys. Identifiers are always read from the
 * actual Class item when one exists.
 * @param {object} [options]
 * @param {object} [options.overrides]      Preloaded override mapping (avoids a second fetch).
 * @param {SourcePackScan} [options.scan]   Preloaded source-pack scan (avoids re-indexing).
 * @returns {Promise<Map<string, TargetClass>>} identifier → target descriptor.
 */
export async function collectTargetClasses({ overrides, scan } = {}) {
  scan ??= await scanSourcePacks();
  overrides ??= await loadOverrides();

  /** @type {Map<string, TargetClass>} */
  const targets = new Map();
  const put = (identifier, name, progression, fromOverride = false) => {
    const existing = targets.get(identifier);
    if (existing) {
      // A real class item beats an override stub; a caster progression beats "none".
      if (existing.progression === "none" && progression !== "none") existing.progression = progression;
      existing.fromOverride &&= fromOverride;
      return;
    }
    targets.set(identifier, { identifier, name, progression, fromOverride });
  };

  for (const actor of game.actors) {
    for (const cls of actor.itemTypes?.class ?? []) {
      put(cls.identifier, cls.name, cls.system.spellcasting?.progression ?? "none");
    }
  }

  for (const cls of scan.classes) put(cls.identifier, cls.name, cls.progression);

  for (const classId of Object.keys(overrides)) {
    put(classId, classId.titleCase?.() ?? classId, "none", true);
  }

  return targets;
}

/**
 * Collect subclasses present in the world (actor items + source packs), so
 * planning can surface ones that end up with no spell list.
 * @param {object} [options]
 * @param {SourcePackScan} [options.scan]  Preloaded source-pack scan.
 * @returns {Promise<Map<string, {identifier: string, classIdentifier: string, name: string}>>}
 *   `${classId}/${subclassId}` → descriptor.
 */
export async function collectTargetSubclasses({ scan } = {}) {
  scan ??= await scanSourcePacks();
  const targets = new Map();
  const put = (classId, subclassId, name) => {
    if (!classId || !subclassId) return;
    const key = `${classId}/${subclassId}`;
    if (!targets.has(key)) targets.set(key, { identifier: subclassId, classIdentifier: classId, name });
  };
  for (const actor of game.actors) {
    for (const sc of actor.itemTypes?.subclass ?? []) put(sc.system.classIdentifier, sc.identifier, sc.name);
  }
  for (const sc of scan.subclasses) put(sc.classIdentifier, sc.identifier, sc.name);
  return targets;
}
