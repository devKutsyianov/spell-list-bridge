/** @file Interactive editor for one spell list: review planned content, add/remove spells, save as overrides. */

import { MODULE_ID } from "./constants.mjs";
import { saveListOverride, scanSourcePacks } from "./membership.mjs";
import { log } from "./util.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * @typedef {object} EditorRow
 * @property {string} uuid
 * @property {string} name
 * @property {"existing"|"planned"|"manual"} status  On the page / will be added by sync / added here
 * @property {boolean} removed  Marked for exclusion
 */

/**
 * Editor for a single class/subclass spell list. Changes are persisted into the
 * module's override store (world setting), so they survive every future sync:
 * manual additions become override `spells`, removals become `exclude`.
 */
export class SpellListEditor extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {object} list  A PlanAction or MissingList descriptor.
   * @param {"class"|"subclass"} list.listType
   * @param {string} list.identifier
   * @param {string} [list.classIdentifier]
   * @param {string} list.name
   * @param {string[]} [list.current]  Spell UUIDs already on the generated page.
   * @param {string[]} [list.added]    Spell UUIDs the plan would add.
   * @param {object} [options]
   * @param {() => void} [options.onSave]  Called after the override store was updated.
   */
  constructor(list, { onSave, ...options } = {}) {
    super(foundry.utils.mergeObject(
      { id: `slb-list-editor-${list.listType}-${list.classIdentifier ?? "x"}-${list.identifier}` },
      options
    ));
    this.list = list;
    this.onSave = onSave;
    this.searchTerm = "";
    /** @type {Map<string, EditorRow>} */
    this.rows = new Map();
    for (const uuid of list.current ?? []) this.rows.set(uuid, makeRow(uuid, "existing"));
    for (const uuid of list.added ?? []) {
      if (!this.rows.has(uuid)) this.rows.set(uuid, makeRow(uuid, "planned"));
    }
  }

  /** @type {Promise<{uuid: string, name: string}[]>|null} Search pool (source-pack spells), loaded once. */
  #searchPool = null;

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["spell-list-bridge", "list-editor"],
    tag: "form",
    position: { width: 660, height: 640 },
    window: { icon: "fa-solid fa-pen-to-square", resizable: true },
    form: { handler: SpellListEditor.#onSave, closeOnSubmit: true },
    actions: {
      toggleRemove: SpellListEditor.#onToggleRemove,
      addSpell: SpellListEditor.#onAddSpell
    }
  };

  /** @override */
  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/editor.hbs` }
  };

  /** @override */
  get title() {
    return game.i18n.format(`${MODULE_ID}.editor.title`, { name: this.list.name });
  }

  /** @override */
  async _prepareContext() {
    this.#searchPool ??= scanSourcePacks().then(scan => scan.spells);
    const pool = await this.#searchPool;
    // The scan enriches pack indices with source fields — backfill rows that
    // were built before it finished.
    const poolByUuid = new Map(pool.map(s => [s.uuid, s]));
    for (const row of this.rows.values()) {
      if (!row.source) row.source = poolByUuid.get(row.uuid)?.source ?? sourceOf(row.uuid);
    }
    const term = this.searchTerm.trim().toLowerCase();
    const results = term.length >= 2
      ? pool.filter(s => s.name.toLowerCase().includes(term) && !this.rows.has(s.uuid)).slice(0, 30)
      : [];
    const rows = [...this.rows.values()].sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    // Same name appearing more than once (different printings) gets flagged so
    // duplicates are visible at a glance.
    const nameCounts = new Map();
    for (const row of rows) {
      if (row.removed) continue;
      const key = row.name.toLowerCase();
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
    for (const row of rows) row.isDup = !row.removed && (nameCounts.get(row.name.toLowerCase()) ?? 0) > 1;
    return {
      name: this.list.name,
      identifier: this.list.identifier,
      classIdentifier: this.list.classIdentifier,
      isSubclass: this.list.listType === "subclass",
      isNew: !(this.list.current?.length || this.list.added?.length),
      rows,
      count: rows.filter(r => !r.removed).length,
      searchTerm: this.searchTerm,
      hasTerm: term.length >= 2,
      results
    };
  }

  /** @override */
  _onRender(context, options) {
    super._onRender?.(context, options);
    const input = this.element.querySelector("input[name=search]");
    if (!input) return;
    input.addEventListener("input", foundry.utils.debounce(event => {
      this.searchTerm = event.target.value ?? "";
      this.render();
    }, 250));
    if (this.searchTerm) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  /**
   * Toggle a row's removal mark; rows added in this session are dropped outright.
   * @this {SpellListEditor}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static #onToggleRemove(_event, target) {
    const uuid = target.closest("[data-uuid]")?.dataset.uuid;
    const row = this.rows.get(uuid);
    if (!row) return;
    if (row.status === "manual") this.rows.delete(uuid);
    else row.removed = !row.removed;
    this.render();
  }

  /**
   * Add a spell from the search results (or restore a removed one).
   * @this {SpellListEditor}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static #onAddSpell(_event, target) {
    const uuid = target.closest("[data-uuid]")?.dataset.uuid;
    if (!uuid) return;
    const row = this.rows.get(uuid);
    if (row) row.removed = false;
    else this.rows.set(uuid, makeRow(uuid, "manual"));
    this.render();
  }

  /**
   * Persist the edits as overrides: manual rows → `spells`, removed rows → `exclude`.
   * @this {SpellListEditor}
   */
  static async #onSave() {
    const adds = [];
    const excludes = [];
    for (const row of this.rows.values()) {
      if (row.removed) excludes.push(row.uuid);
      else if (row.status === "manual") adds.push(row.uuid);
    }
    if (!adds.length && !excludes.length) return;
    try {
      await saveListOverride({
        classIdentifier: this.list.listType === "class" ? this.list.identifier : this.list.classIdentifier,
        subclassIdentifier: this.list.listType === "subclass" ? this.list.identifier : undefined,
        adds,
        excludes
      });
      ui.notifications.info(game.i18n.format(`${MODULE_ID}.notify.overrideSaved`, { name: this.list.name }));
      this.onSave?.();
    } catch (err) {
      log("Failed to save list override", err);
      ui.notifications.error(game.i18n.localize(`${MODULE_ID}.notify.overrideSaveFailed`));
    }
  }
}

/**
 * Build an editor row for a spell UUID.
 * @param {string} uuid
 * @param {"existing"|"planned"|"manual"} status
 * @returns {EditorRow}
 */
function makeRow(uuid, status) {
  return { uuid, name: nameOf(uuid), source: sourceOf(uuid), status, removed: false };
}

/**
 * Display name for a spell UUID (compendium indexes always carry names).
 * @param {string} uuid
 * @returns {string}
 */
function nameOf(uuid) {
  try {
    return fromUuidSync(uuid)?.name ?? uuid.split(".").pop();
  } catch {
    return uuid.split(".").pop();
  }
}

/**
 * Human-readable origin for a spell UUID: 5etools source code or source book
 * when the index carries it, otherwise the compendium's label.
 * @param {string} uuid
 * @returns {string}
 */
function sourceOf(uuid) {
  try {
    const doc = fromUuidSync(uuid);
    const source = doc?.flags?.plutonium?.source ?? doc?.system?.source?.book;
    if (source) return source;
  } catch { /* fall through to pack label */ }
  try {
    return foundry.utils.parseUuid(uuid)?.collection?.metadata?.label ?? "";
  } catch {
    return "";
  }
}
