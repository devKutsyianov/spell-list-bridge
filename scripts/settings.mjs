/** @file World-setting registration and the source-pack configuration menu. */

import { MODULE_ID, SETTINGS } from "./constants.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Small ApplicationV2 menu: pick which Item compendiums are spell/class sources. */
export class SourcePacksConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @override */
  static DEFAULT_OPTIONS = {
    id: "slb-source-packs",
    classes: ["spell-list-bridge", "source-packs"],
    tag: "form",
    position: { width: 480, height: 560 },
    window: { title: "spell-list-bridge.settings.sourcePacks.name", icon: "fa-solid fa-book", resizable: true },
    form: { handler: SourcePacksConfig.#onSubmit, closeOnSubmit: true }
  };

  /** @override */
  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/source-packs.hbs` }
  };

  /** @override */
  async _prepareContext() {
    const selected = game.settings.get(MODULE_ID, SETTINGS.SOURCE_PACKS) ?? [];
    const packs = game.packs
      .filter(p => p.metadata.type === "Item")
      .map(p => ({
        id: p.collection,
        label: `${p.metadata.label} (${p.collection})`,
        checked: !selected.length || selected.includes(p.collection)
      }))
      .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
    return { packs, allByDefault: !selected.length };
  }

  /**
   * Persist selection. An all-checked selection is stored as [] (= "all packs",
   * so newly added packs are included automatically).
   * @this {SourcePacksConfig}
   * @param {SubmitEvent} _event
   * @param {HTMLFormElement} form
   */
  static async #onSubmit(_event, form) {
    const boxes = [...form.querySelectorAll("input[type=checkbox][name=pack]")];
    const chosen = boxes.filter(b => b.checked).map(b => b.value);
    const value = chosen.length === boxes.length ? [] : chosen;
    await game.settings.set(MODULE_ID, SETTINGS.SOURCE_PACKS, value);
  }
}

/** Register all module settings. */
export function registerSettings() {
  const w = { scope: "world", config: true };

  game.settings.register(MODULE_ID, SETTINGS.SOURCE_PACKS, {
    scope: "world",
    config: false,
    type: Array,
    default: []
  });

  game.settings.registerMenu(MODULE_ID, "sourcePacksMenu", {
    name: `${MODULE_ID}.settings.sourcePacks.name`,
    label: `${MODULE_ID}.settings.sourcePacks.label`,
    hint: `${MODULE_ID}.settings.sourcePacks.hint`,
    icon: "fa-solid fa-book",
    type: SourcePacksConfig,
    restricted: true
  });

  game.settings.register(MODULE_ID, SETTINGS.AUTO_TRIGGER, {
    ...w,
    name: `${MODULE_ID}.settings.autoTrigger.name`,
    hint: `${MODULE_ID}.settings.autoTrigger.hint`,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.RECONCILE_ON_READY, {
    ...w,
    name: `${MODULE_ID}.settings.reconcileOnReady.name`,
    hint: `${MODULE_ID}.settings.reconcileOnReady.hint`,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, SETTINGS.ASSIGN_TO_ACTORS, {
    ...w,
    name: `${MODULE_ID}.settings.assignToActors.name`,
    hint: `${MODULE_ID}.settings.assignToActors.hint`,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.AUTO_HIDE_SOURCE_LISTS, {
    ...w,
    name: `${MODULE_ID}.settings.autoHideSourceLists.name`,
    hint: `${MODULE_ID}.settings.autoHideSourceLists.hint`,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, SETTINGS.OVERRIDE_PATH, {
    ...w,
    name: `${MODULE_ID}.settings.overridePath.name`,
    hint: `${MODULE_ID}.settings.overridePath.hint`,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTINGS.BATCH_SIZE, {
    ...w,
    name: `${MODULE_ID}.settings.batchSize.name`,
    hint: `${MODULE_ID}.settings.batchSize.hint`,
    type: Number,
    range: { min: 10, max: 500, step: 10 },
    default: 100
  });

  game.settings.register(MODULE_ID, SETTINGS.DRY_RUN, {
    ...w,
    name: `${MODULE_ID}.settings.dryRun.name`,
    hint: `${MODULE_ID}.settings.dryRun.hint`,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, SETTINGS.LAST_REPORT, {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });
}
