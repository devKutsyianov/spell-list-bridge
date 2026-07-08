/** @file Resolves spell→class/subclass membership from overrides, Plutonium flags, and the 5etools lookup. */

import { MODULE_ID, PLUTONIUM_ID, SETTINGS } from "./constants.mjs";
import { getPlutoniumSpellLookup } from "./integrations.mjs";
import { log, toIdentifier } from "./util.mjs";

/**
 * @typedef {object} MembershipIndex
 * @property {Map<string, Set<string>>} classes     classIdentifier → Set of spell UUIDs
 * @property {Map<string, Set<string>>} subclasses  `${classId}/${subclassId}` → Set of spell UUIDs
 * @property {Map<string, string>} subclassNames    `${classId}/${subclassId}` → display name
 * @property {{name: string, uuid: string, source: string}[]} unmapped  Plutonium spells with no class resolution
 * @property {string[]} unresolvedOverrides  Override entries that matched no spell
 * @property {string[]} warnings  Human-readable warnings
 */

/** Index fields needed from source packs. */
const INDEX_FIELDS = ["type", "name", "system.identifier", "system.level", `flags.${PLUTONIUM_ID}`];

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
 * Load the override-mapping JSON from the configured path.
 * @returns {Promise<object>} Parsed overrides (empty object when unset or unreadable).
 */
export async function loadOverrides() {
  const path = (game.settings.get(MODULE_ID, SETTINGS.OVERRIDE_PATH) ?? "").trim();
  if (!path) return {};
  try {
    return (await foundry.utils.fetchJsonWithTimeout(path)) ?? {};
  } catch (err) {
    log(`Failed to load override mapping from "${path}"`, err);
    ui.notifications.error(game.i18n.format(`${MODULE_ID}.notify.overrideLoadFailed`, { path }));
    return {};
  }
}

/**
 * Build the full membership index from all sources, in priority order:
 * 1. override JSON, 2. Plutonium flags (`spellClassNames` / lookup), 3. left to
 * the caller (existing registered lists are merged during planning).
 * @returns {Promise<MembershipIndex>} The resolved index.
 */
export async function buildMembershipIndex() {
  /** @type {MembershipIndex} */
  const index = {
    classes: new Map(),
    subclasses: new Map(),
    subclassNames: new Map(),
    unmapped: [],
    unresolvedOverrides: [],
    warnings: []
  };

  const packs = getSourcePacks();
  const lookup = await getPlutoniumSpellLookup();
  const overrides = await loadOverrides();

  // Collect spell index entries across all source packs.
  /** @type {{uuid: string, name: string, plutonium: object|undefined}[]} */
  const spellEntries = [];
  /** @type {Map<string, string[]>} lowercase name → uuids (for override name resolution) */
  const byName = new Map();

  for (const pack of packs) {
    let packIndex;
    try {
      packIndex = await pack.getIndex({ fields: INDEX_FIELDS });
    } catch (err) {
      log(`Could not index pack ${pack.collection}`, err);
      continue;
    }
    for (const entry of packIndex) {
      if (entry.type !== "spell") continue;
      const record = { uuid: entry.uuid, name: entry.name, plutonium: entry.flags?.[PLUTONIUM_ID] };
      spellEntries.push(record);
      const key = entry.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(entry.uuid);
    }
  }

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
  for (const spell of spellEntries) {
    const flags = spell.plutonium;
    if (!flags) continue;
    let mapped = false;

    if (Array.isArray(flags.spellClassNames) && flags.spellClassNames.length) {
      for (const className of flags.spellClassNames) addClass(toIdentifier(className), spell.uuid);
      mapped = true;
    }

    const lookupEntry = lookup?.[String(flags.source ?? "").toLowerCase()]?.[spell.name.toLowerCase()];
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
  const resolveRef = ref => {
    if (typeof ref !== "string" || !ref) return [];
    if (ref.startsWith("uuid://")) ref = ref.slice("uuid://".length);
    if (ref.includes(".")) {
      try {
        return foundry.utils.parseUuid(ref)?.documentId ? [ref] : [];
      } catch {
        return [];
      }
    }
    return byName.get(ref.toLowerCase()) ?? [];
  };

  for (const [classId, config] of Object.entries(overrides)) {
    for (const ref of config?.spells ?? []) {
      const uuids = resolveRef(ref);
      if (!uuids.length) index.unresolvedOverrides.push(`${classId}: ${ref}`);
      for (const uuid of uuids) addClass(classId, uuid);
    }
    for (const [subclassId, scConfig] of Object.entries(config?.subclasses ?? {})) {
      for (const ref of scConfig?.spells ?? []) {
        const uuids = resolveRef(ref);
        if (!uuids.length) index.unresolvedOverrides.push(`${classId}/${subclassId}: ${ref}`);
        for (const uuid of uuids) addSubclass(classId, subclassId, undefined, uuid);
      }
    }
  }

  if (!packs.length) index.warnings.push(game.i18n.localize(`${MODULE_ID}.notify.noSourcePacks`));
  if (!lookup && spellEntries.some(s => s.plutonium && !s.plutonium.spellClassNames)) {
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
 * @returns {Promise<Map<string, TargetClass>>} identifier → target descriptor.
 */
export async function collectTargetClasses() {
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

  for (const pack of getSourcePacks()) {
    let packIndex;
    try {
      packIndex = await pack.getIndex({ fields: ["type", "name", "system.identifier", "system.spellcasting.progression"] });
    } catch {
      continue;
    }
    for (const entry of packIndex) {
      if (entry.type !== "class") continue;
      const identifier = entry.system?.identifier || toIdentifier(entry.name);
      put(identifier, entry.name, entry.system?.spellcasting?.progression ?? "none");
    }
  }

  const overrides = await loadOverrides();
  for (const classId of Object.keys(overrides)) {
    put(classId, classId.titleCase?.() ?? classId, "none", true);
  }

  return targets;
}
