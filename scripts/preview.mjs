/** @file GM preview dialog for a reconcile plan (ApplicationV2 + Handlebars). */

import { MODULE_ID, SETTINGS } from "./constants.mjs";
import { applyPlan } from "./reconcile.mjs";
import { exportJson, log } from "./util.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Preview window listing create/update/merge actions, skips, and unmapped
 * spells before any write happens.
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

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "slb-reconcile-preview",
    classes: ["spell-list-bridge", "reconcile-preview"],
    tag: "form",
    position: { width: 640, height: 620 },
    window: { title: "spell-list-bridge.preview.title", icon: "fa-solid fa-arrows-rotate", resizable: true },
    form: { handler: ReconcilePreview.#onApply, closeOnSubmit: true },
    actions: { export: ReconcilePreview.#onExport }
  };

  /** @override */
  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/preview.hbs` },
    footer: { template: `modules/${MODULE_ID}/templates/preview-footer.hbs` }
  };

  /** @override */
  async _prepareContext() {
    const rows = this.plan.actions
      .map(a => ({
        ...a,
        addedCount: a.added.length,
        staleCount: a.stale.length,
        isSubclass: a.listType === "subclass",
        kindLabel: game.i18n.localize(`${MODULE_ID}.preview.kind.${a.kind}`)
      }))
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    return {
      rows,
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
