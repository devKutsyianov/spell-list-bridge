/** @file Auto and manual reconcile triggers. */

import { MODULE_ID, PACK_ID, PLUTONIUM_ID, SETTINGS, TRIGGER_DEBOUNCE_MS } from "./constants.mjs";
import { planReconcile, applyPlan, invalidateSourceListsCache } from "./reconcile.mjs";
import { ReconcilePreview } from "./preview.mjs";
import { log, requireGM, toIdentifier } from "./util.mjs";

/**
 * Class identifiers accumulated between debounced auto-runs. `null` means the
 * next run is unrestricted (membership unknown at trigger time).
 * @type {Set<string>|null}
 */
let pending = new Set();

/** Debounced executor for the auto path (silent, restricted reconcile). */
const runAuto = foundry.utils.debounce(async () => {
  const restricted = pending ? [...pending] : null;
  pending = new Set();
  if (restricted && !restricted.length) return;
  try {
    const plan = await planReconcile({ identifiers: restricted ?? undefined });
    const changed = plan.actions.filter(a => a.kind !== "unchanged");
    if (!changed.length && !plan.missing?.length) return;
    const label = restricted?.join(", ") ?? game.i18n.localize(`${MODULE_ID}.notify.allClasses`);
    if (game.settings.get(MODULE_ID, SETTINGS.AUTO_PREVIEW)) {
      // Review-first workflow: show what would be written (including lists that
      // could not be derived) and let the GM edit before applying.
      ReconcilePreview.show(plan);
      ui.notifications.info(game.i18n.format(`${MODULE_ID}.notify.autoReview`, { identifiers: label }));
      return;
    }
    if (!changed.length) return;
    const dryRun = game.settings.get(MODULE_ID, SETTINGS.DRY_RUN);
    const report = await applyPlan(plan, { dryRun });
    if (report.ok === false) return; // applyPlan already surfaced the failure.
    const key = dryRun ? "notify.autoDryRun" : "notify.autoApplied";
    ui.notifications.info(
      game.i18n.format(`${MODULE_ID}.${key}`, {
        created: report.created.length,
        updated: report.updated.length,
        identifiers: label
      })
    );
  } catch (err) {
    log("Auto reconcile failed", err);
  }
}, TRIGGER_DEBOUNCE_MS);

/**
 * Queue class identifiers for a debounced auto reconcile.
 * @param {object} options
 * @param {string[]} [options.identifiers]      Class identifiers touched by the trigger.
 * @param {boolean} [options.unrestricted]      Queue a full reconcile instead.
 * @param {boolean} [options.localOnly=false]   Gate on this client being a GM (compendium
 *   CRUD hooks only fire on the initiating client) instead of the active GM.
 */
function queue({ identifiers = [], unrestricted = false, localOnly = false } = {}) {
  const gate = localOnly ? game.user.isGM : game.user.isGM && game.user === game.users.activeGM;
  if (!gate) return;
  if (!game.settings.get(MODULE_ID, SETTINGS.AUTO_TRIGGER)) return;
  if (unrestricted) pending = null;
  else if (pending) for (const id of identifiers) if (id) pending.add(id);
  if (!pending || pending.size) runAuto();
}

/**
 * `createItem` — fires for Plutonium class imports / level-ups (embedded class
 * or subclass items) and for imported spells carrying Plutonium flags.
 * Plutonium emits no hooks of its own (NOTES.md §3.1), so this is the signal.
 * Compendium creations only fire on the importing client, so those are gated
 * on that client being a GM rather than the active GM.
 * @param {Item} item
 */
function onCreateItem(item) {
  const localOnly = !!item.pack;
  if (item.type === "class" && item.actor) {
    queue({ identifiers: [item.identifier], localOnly });
  } else if (item.type === "subclass" && item.actor) {
    queue({ identifiers: [item.system.classIdentifier], localOnly });
  } else if (item.type === "spell" && item.flags?.[PLUTONIUM_ID]) {
    // A freshly imported spell: reconcile the classes it claims.
    const names = item.flags[PLUTONIUM_ID].spellClassNames ?? [];
    if (names.length) queue({ identifiers: names.map(n => toIdentifier(n)), localOnly });
    else queue({ unrestricted: true, localOnly }); // Membership resolved by the lookup during planning.
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
  queue({ identifiers: (actor.itemTypes?.class ?? []).map(c => c.identifier) });
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
    ReconcilePreview.show(plan);
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
  const footer = app.element?.querySelector(".directory-footer");
  if (!footer || footer.querySelector(".slb-sync-button")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("slb-sync-button");
  button.innerHTML = `<i class="fa-solid fa-arrows-rotate"></i> ${game.i18n.localize(`${MODULE_ID}.ui.syncButton`)}`;
  button.addEventListener("click", () => manualReconcile());
  footer.appendChild(button);
}

/**
 * Invalidate the cached foreign-pack list scan when spells pages change in
 * another compendium.
 * @param {JournalEntryPage} page
 */
function onJournalPageChanged(page) {
  if (page.pack && page.pack !== PACK_ID && page.type === "spells") invalidateSourceListsCache();
}

/** Wire all trigger hooks. */
export function registerTriggers() {
  Hooks.on("createItem", onCreateItem);
  Hooks.on("dnd5e.advancementManagerComplete", onAdvancementComplete);
  Hooks.on("renderJournalDirectory", onRenderJournalDirectory);
  for (const hook of ["createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage"]) {
    Hooks.on(hook, onJournalPageChanged);
  }
}
