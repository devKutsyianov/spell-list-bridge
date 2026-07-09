/** @file GM review window for a reconcile plan (ApplicationV2 + Handlebars). */

import { MODULE_ID, SETTINGS } from "./constants.mjs";
import { SpellListEditor } from "./editor.mjs";
import { applyPlan, planReconcile } from "./reconcile.mjs";
import { exportJson, log } from "./util.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Review window listing create/update/merge actions, skips, missing lists, and
 * unmapped spells before any write happens. Rows open the list editor; edits
 * are saved as overrides and the plan refreshes to show their effect first —
 * Apply then writes everything.
 */
export class ReconcilePreview extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {import("./reconcile.mjs").ReconcilePlan} plan  The plan to preview.
   * @param {object} [options]  ApplicationV2 options.
   */
  constructor(plan, options = {}) {
    super(options);
    this.plan = plan;
  }

  /** Guard against double-submits while a (long) apply is running. */
  #applying = false;

  /** @type {ReconcilePreview|null} The currently open preview, if any. */
  static #current = null;

  /**
   * Open the preview as a singleton: re-use (and re-plan) an already open
   * window instead of stacking duplicates.
   * @param {import("./reconcile.mjs").ReconcilePlan} plan
   * @returns {ReconcilePreview}
   */
  static show(plan) {
    if (ReconcilePreview.#current?.rendered) {
      ReconcilePreview.#current.plan = plan;
      ReconcilePreview.#current.render();
      return ReconcilePreview.#current;
    }
    const app = new ReconcilePreview(plan);
    ReconcilePreview.#current = app;
    app.render({ force: true });
    return app;
  }

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "slb-reconcile-preview",
    classes: ["spell-list-bridge", "reconcile-preview"],
    tag: "form",
    position: { width: 700, height: 660 },
    window: { title: "spell-list-bridge.preview.title", icon: "fa-solid fa-arrows-rotate", resizable: true },
    form: { handler: ReconcilePreview.#onApply, closeOnSubmit: true },
    actions: {
      export: ReconcilePreview.#onExport,
      editList: ReconcilePreview.#onEditList,
      createList: ReconcilePreview.#onCreateList
    }
  };

  /** @override */
  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/preview.hbs` },
    footer: { template: `modules/${MODULE_ID}/templates/preview-footer.hbs` }
  };

  /** @override */
  async _prepareContext() {
    const rows = this.plan.actions
      .map((a, idx) => ({
        ...a,
        idx,
        addedCount: a.added.length,
        removedCount: a.removed?.length ?? 0,
        staleCount: a.stale.length,
        isSubclass: a.listType === "subclass",
        kindLabel: game.i18n.localize(`${MODULE_ID}.preview.kind.${a.kind}`)
      }))
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    const missing = (this.plan.missing ?? [])
      .map((m, idx) => ({ ...m, idx, isSubclass: m.listType === "subclass" }))
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    return {
      rows,
      missing,
      changed: rows.filter(r => r.kind !== "unchanged").length,
      unchanged: rows.filter(r => r.kind === "unchanged").length,
      unmapped: this.plan.unmapped,
      unresolvedOverrides: this.plan.unresolvedOverrides,
      skipped: this.plan.skipped,
      warnings: this.plan.warnings,
      dryRunDefault: game.settings.get(MODULE_ID, SETTINGS.DRY_RUN)
    };
  }

  /**
   * Recompute the plan (e.g. after an editor save) and re-render.
   * @returns {Promise<void>}
   */
  async refresh() {
    try {
      this.plan = await planReconcile();
      this.render();
    } catch (err) {
      log("Failed to refresh plan", err);
    }
  }

  /**
   * Open the editor for a planned list row.
   * @this {ReconcilePreview}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static #onEditList(_event, target) {
    const action = this.plan.actions[Number(target.closest("[data-idx]")?.dataset.idx)];
    if (!action) return;
    new SpellListEditor(action, { onSave: () => this.refresh() }).render({ force: true });
  }

  /**
   * Open the editor to create a list for a class/subclass that has none.
   * @this {ReconcilePreview}
   * @param {PointerEvent} _event
   * @param {HTMLElement} target
   */
  static #onCreateList(_event, target) {
    const entry = this.plan.missing?.[Number(target.closest("[data-idx]")?.dataset.idx)];
    if (!entry) return;
    new SpellListEditor(entry, { onSave: () => this.refresh() }).render({ force: true });
  }

  /**
   * Apply the plan (respecting the dry-run checkbox) with a progress notification.
   * @this {ReconcilePreview}
   * @param {SubmitEvent} _event
   * @param {HTMLFormElement} form
   */
  static async #onApply(_event, form) {
    if (this.#applying) return;
    this.#applying = true;
    try {
      const dryRun = form.elements.dryRun?.checked ?? false;
      let bar;
      try {
        bar = ui.notifications.info(game.i18n.localize(`${MODULE_ID}.notify.applying`), { progress: true });
      } catch {
        bar = null;
      }
      const report = await applyPlan(this.plan, {
        dryRun,
        onProgress: (done, total, label) => bar?.update?.({ pct: total ? done / total : 1, message: label })
      });
      bar?.update?.({ pct: 1 });
      log("Report", report);
      if (report.ok === false) return; // applyPlan already surfaced the failure.
      const key = dryRun ? "notify.dryRunDone" : "notify.applied";
      ui.notifications.info(
        game.i18n.format(`${MODULE_ID}.${key}`, {
          created: report.created.length,
          updated: report.updated.length
        })
      );
    } finally {
      this.#applying = false;
    }
  }

  /**
   * Export the current plan as JSON for issue reports.
   * @this {ReconcilePreview}
   */
  static #onExport() {
    exportJson(this.plan, `${MODULE_ID}-plan-${Date.now()}.json`);
  }
}
