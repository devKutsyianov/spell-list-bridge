/** @file Auto and manual reconcile triggers. */

import { MODULE_ID, PLUTONIUM_ID, SETTINGS, TRIGGER_DEBOUNCE_MS } from "./constants.mjs";
import { planReconcile, applyPlan } from "./reconcile.mjs";
import { ReconcilePreview } from "./preview.mjs";
import { log, requireGM, toIdentifier } from "./util.mjs";

/** Class identifiers accumulated between debounced auto-runs. */
const pending = new Set();

/** Debounced executor for the auto path (silent, restricted reconcile). */
const runAuto = foundry.utils.debounce(async () => {
  const identifiers = [...pending];
  pending.clear();
  if (!identifiers.length) return;
  try {
    // "*" means membership was unknown at trigger time — run unrestricted.
    const restricted = identifiers.includes("*") ? undefined : identifiers;
    const plan = await planReconcile({ identifiers: restricted });
    const changed = plan.actions.filter(a => a.kind !== "unchanged");
    if (!changed.length) return;
    const report = await applyPlan(plan, { dryRun: game.settings.get(MODULE_ID, SETTINGS.DRY_RUN) });
    ui.notifications.info(
      game.i18n.format(`${MODULE_ID}.notify.autoApplied`, {
        created: report.created.length,
        updated: report.updated.length,
        identifiers: identifiers.join(", ")
      })
    );
  } catch (err) {
    log("Auto reconcile failed", err);
  }
}, TRIGGER_DEBOUNCE_MS);

/**
 * Queue class identifiers for a debounced auto reconcile.
 * @param {...string} identifiers  Class identifiers touched by the trigger.
 */
function queue(...identifiers) {
  if (!game.user.isGM || game.user !== game.users.activeGM) return;
  if (!game.settings.get(MODULE_ID, SETTINGS.AUTO_TRIGGER)) return;
  for (const id of identifiers) if (id) pending.add(id);
  if (pending.size) runAuto();
}

/**
 * `createItem` — fires for Plutonium class imports / level-ups (embedded class
 * or subclass items) and for imported spells carrying Plutonium flags.
 * Plutonium emits no hooks of its own (NOTES.md §3.1), so this is the signal.
 * @param {Item} item
 * @param {object} _options
 * @param {string} userId
 */
function onCreateItem(item, _options, _userId) {
  if (item.type === "class" && item.actor) {
    queue(item.identifier);
  } else if (item.type === "subclass" && item.actor) {
    queue(item.system.classIdentifier);
  } else if (item.type === "spell" && item.flags?.[PLUTONIUM_ID]) {
    // A freshly imported spell: reconcile the classes it claims.
    const names = item.flags[PLUTONIUM_ID].spellClassNames ?? [];
    const ids = names.map(n => toIdentifier(n));
    if (ids.length) queue(...ids);
    else queue("*"); // Unknown membership — plan will resolve via the lookup; run unrestricted.
  }
}

/**
 * `dnd5e.advancementManagerComplete` — level-up flows (same trigger Spell Book
 * uses for its notice).
 * @param {object} manager  The advancement manager.
 */
function onAdvancementComplete(manager) {
  const actor = manager?.actor;
  if (!actor) return;
  queue(...(actor.itemTypes?.class ?? []).map(c => c.identifier));
}

/**
 * Run a full, interactive reconcile: build the plan and show the preview dialog.
 * @returns {Promise<void>}
 */
export async function manualReconcile() {
  if (!requireGM()) return;
  let bar;
  try {
    bar = ui.notifications.info(game.i18n.localize(`${MODULE_ID}.notify.planning`), { progress: true });
  } catch {
    bar = null;
  }
  try {
    const plan = await planReconcile();
    bar?.update?.({ pct: 1 });
    new ReconcilePreview(plan).render({ force: true });
  } catch (err) {
    bar?.update?.({ pct: 1 });
    log("Planning failed", err);
    ui.notifications.error(game.i18n.localize(`${MODULE_ID}.notify.planFailed`));
  }
}

/**
 * Inject the GM-only "Sync spell lists" button into the Journal directory
 * footer (same DOM pattern Spell Book uses for its manager button).
 * @param {Application} app  The rendered directory application.
 */
function onRenderJournalDirectory(app) {
  if (!game.user.isGM) return;
  const footer = app.element?.querySelector?.(".directory-footer") ?? app.element?.[0]?.querySelector(".directory-footer");
  if (!footer || footer.querySelector(".slb-sync-button")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("slb-sync-button");
  button.innerHTML = `<i class="fa-solid fa-arrows-rotate"></i> ${game.i18n.localize(`${MODULE_ID}.ui.syncButton`)}`;
  button.addEventListener("click", () => manualReconcile());
  footer.appendChild(button);
}

/** Wire all trigger hooks. */
export function registerTriggers() {
  Hooks.on("createItem", onCreateItem);
  Hooks.on("dnd5e.advancementManagerComplete", onAdvancementComplete);
  Hooks.on("renderJournalDirectory", onRenderJournalDirectory);
}
