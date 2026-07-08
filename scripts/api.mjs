/** @file Public module API: `game.modules.get("spell-list-bridge").api`. */

import { MODULE_ID } from "./constants.mjs";
import { spellsNotInLists } from "./integrations.mjs";
import { buildMembershipIndex } from "./membership.mjs";
import { ReconcilePreview } from "./preview.mjs";
import { applyPlan, getLastReport, planReconcile } from "./reconcile.mjs";
import { exportJson, requireGM } from "./util.mjs";

/**
 * Run a reconcile.
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]      Compute and report without writing.
 * @param {boolean} [options.interactive=false] Show the preview dialog instead of applying directly.
 * @param {string[]} [options.identifiers]      Restrict to these class identifiers.
 * @returns {Promise<object|void>} The report (non-interactive) or nothing (interactive).
 */
async function reconcile({ dryRun = false, interactive = false, identifiers } = {}) {
  if (!requireGM()) return;
  const plan = await planReconcile({ identifiers });
  if (interactive) {
    new ReconcilePreview(plan).render({ force: true });
    return;
  }
  return applyPlan(plan, { dryRun });
}

/**
 * Report spells that carry Plutonium flags but resolved to no class, plus
 * unresolved override entries. Logs to console and returns the data.
 * @returns {Promise<{unmapped: object[], unresolvedOverrides: string[]}>}
 */
async function reportUnmapped() {
  const index = await buildMembershipIndex();
  const out = { unmapped: index.unmapped, unresolvedOverrides: index.unresolvedOverrides };
  console.log(`${MODULE_ID} | Unmapped spells (${out.unmapped.length})`, out.unmapped);
  console.log(`${MODULE_ID} | Unresolved overrides (${out.unresolvedOverrides.length})`, out.unresolvedOverrides);
  return out;
}

/**
 * Download the most recent reconcile report as JSON (for pasting into issues).
 * @returns {object|null} The report that was exported, or null when none exists.
 */
function exportReport() {
  const report = getLastReport();
  if (!report) {
    ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notify.noReport`));
    return null;
  }
  exportJson(report, `${MODULE_ID}-report-${Date.now()}.json`);
  return report;
}

/** Attach the API to the module. */
export function createApi() {
  game.modules.get(MODULE_ID).api = {
    reconcile,
    reportUnmapped,
    spellsNotInLists,
    exportReport,
    getLastReport
  };
}
