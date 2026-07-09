/** @file Shared constants for Spell List Bridge. */

/** Module id (must match module.json). */
export const MODULE_ID = "spell-list-bridge";

/** Collection id of the module's generated-lists compendium pack. */
export const PACK_ID = `${MODULE_ID}.generated-spell-lists`;

/** Name of the JournalEntry inside the pack that holds all generated pages. */
export const JOURNAL_NAME = "Generated Spell Lists";

/** Flag keys written on generated pages (scope = MODULE_ID). */
export const PAGE_FLAGS = {
  /** Marker so reconcile can find its own pages. */
  GENERATED: "generated",
  /** `class` or `subclass` identifier the page is keyed to. */
  IDENTIFIER: "identifier",
  /** Parent class identifier (subclass pages only). */
  CLASS_IDENTIFIER: "classIdentifier",
  /** ISO timestamp of the last reconcile that touched the page. */
  UPDATED: "updated"
};

/** World-setting keys. */
export const SETTINGS = {
  SOURCE_PACKS: "sourcePacks",
  AUTO_TRIGGER: "autoTrigger",
  RECONCILE_ON_READY: "reconcileOnReady",
  AUTO_HIDE_SOURCE_LISTS: "autoHideSourceLists",
  ASSIGN_TO_ACTORS: "assignToActors",
  OVERRIDE_PATH: "overridePath",
  BATCH_SIZE: "batchSize",
  DRY_RUN: "dryRun",
  LAST_REPORT: "lastReport",
  /** Curated list edits made through the editor window (same shape as the override JSON). */
  UI_OVERRIDES: "uiOverrides",
  /** Open the review window after auto-detected imports instead of applying silently. */
  AUTO_PREVIEW: "autoPreview"
};

/** Soft-detected neighbor modules. */
export const PLUTONIUM_ID = "plutonium";
export const SPELLBOOK_ID = "spell-book";

/** Spell Book internals we interoperate with (verified in NOTES.md §2). */
export const SB = {
  SETTING_REGISTRY_ENABLED: "registryEnabledLists",
  SETTING_HIDDEN_LISTS: "hiddenSpellLists",
  FLAG_CLASS_RULES: "classRules"
};

/** Plutonium's on-disk 5etools spell→class lookup (NOTES.md §3.3). */
export const PLUTONIUM_LOOKUP_PATH = "modules/plutonium/data/generated/gendata-spell-source-lookup.json";

/** Debounce for auto-trigger coalescing, in milliseconds. */
export const TRIGGER_DEBOUNCE_MS = 2500;
