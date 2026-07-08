/** @file The idempotent reconcile engine: plan → (preview) → apply. */

import { JOURNAL_NAME, MODULE_ID, PACK_ID, PAGE_FLAGS, SETTINGS } from "./constants.mjs";
import { assignListToActors, ensureSpellBookRegistryToggle, hideSourceListsInSpellBook, isSpellBookActive } from "./integrations.mjs";
import { buildMembershipIndex, collectTargetClasses } from "./membership.mjs";
import { chunk, log } from "./util.mjs";

/**
 * @typedef {object} PlanAction
 * @property {"create"|"update"|"unchanged"} kind
 * @property {"class"|"subclass"} listType
 * @property {string} identifier        List identifier (class or subclass)
 * @property {string} [classIdentifier] Parent class (subclass lists only)
 * @property {string} name              Page display name
 * @property {string} [pageId]          Existing generated page id (update/unchanged)
 * @property {string} [pageUuid]        Existing generated page uuid (update/unchanged)
 * @property {string[]} added           Spell UUIDs to add
 * @property {string[]} stale           Spell UUIDs on the page no longer derivable (report-only, never deleted)
 * @property {string[]} sourcePages     UUIDs of non-generated pages contributing to this identifier
 * @property {number} total             Final spell count after apply
 */

/**
 * @typedef {object} ReconcilePlan
 * @property {PlanAction[]} actions
 * @property {{name: string, uuid: string, source: string}[]} unmapped
 * @property {string[]} unresolvedOverrides
 * @property {string[]} warnings
 * @property {string[]} skipped        Human-readable skip notices (psi-point case etc.)
 * @property {string} generatedAt      ISO timestamp
 */

/**
 * Get the module's generated-lists pack, unlocking it when a GM needs to write.
 * @returns {Promise<CompendiumCollection>} The pack.
 */
async function getPack() {
  const pack = game.packs.get(PACK_ID);
  if (!pack) throw new Error(`${MODULE_ID}: compendium pack ${PACK_ID} is missing`);
  if (pack.locked && game.user.isGM) await pack.configure({ locked: false });
  return pack;
}

/**
 * Find the single JournalEntry holding all generated pages.
 * @param {CompendiumCollection} pack  The generated-lists pack.
 * @returns {Promise<JournalEntry|null>} The journal, or null when absent.
 */
async function getJournal(pack) {
  const docs = await pack.getDocuments();
  return docs.find(j => j.getFlag(MODULE_ID, PAGE_FLAGS.GENERATED)) ?? docs[0] ?? null;
}

/**
 * Scan all JournalEntry packs except ours for spells pages, grouped by
 * `${type}:${identifier}`. This is the provenance-clean view of "existing
 * registered lists" used both to seed comprehensive pages and to know which
 * source pages the auto-hide option should hide.
 * @returns {Promise<Map<string, {uuids: Set<string>, pages: string[]}>>}
 */
async function scanSourceLists() {
  const out = new Map();
  for (const pack of game.packs.filter(p => p.metadata.type === "JournalEntry" && p.collection !== PACK_ID)) {
    let docs;
    try {
      docs = await pack.getDocuments();
    } catch (err) {
      log(`Could not read journal pack ${pack.collection}`, err);
      continue;
    }
    for (const journal of docs) {
      for (const page of journal.pages) {
        if (page.type !== "spells" || !page.system.identifier) continue;
        const key = `${page.system.type}:${page.system.identifier}`;
        if (!out.has(key)) out.set(key, { uuids: new Set(), pages: [] });
        const group = out.get(key);
        for (const uuid of page.system.spells) group.uuids.add(uuid);
        group.pages.push(page.uuid);
      }
    }
  }
  return out;
}

/**
 * Build a reconcile plan. Read-only: performs no writes.
 * @param {object} [options]
 * @param {string[]} [options.identifiers]  Restrict to these class identifiers (auto-trigger path).
 * @returns {Promise<ReconcilePlan>} The plan.
 */
export async function planReconcile({ identifiers } = {}) {
  const [index, targets, sourceLists] = await Promise.all([
    buildMembershipIndex(),
    collectTargetClasses(),
    scanSourceLists()
  ]);
  const pack = await getPack();
  const journal = await getJournal(pack);

  /** @type {Map<string, JournalEntryPage>} `${type}:${identifier}` → existing generated page */
  const existingPages = new Map();
  for (const page of journal?.pages ?? []) {
    if (page.type !== "spells" || !page.getFlag(MODULE_ID, PAGE_FLAGS.GENERATED)) continue;
    existingPages.set(`${page.system.type}:${page.system.identifier}`, page);
  }

  /** @type {ReconcilePlan} */
  const plan = {
    actions: [],
    unmapped: index.unmapped,
    unresolvedOverrides: index.unresolvedOverrides,
    warnings: [...index.warnings],
    skipped: [],
    generatedAt: new Date().toISOString()
  };

  const restrict = identifiers?.length ? new Set(identifiers) : null;

  /** Every spell UUID that ends up on (or is already on) any planned list. */
  const covered = new Set();

  const makeAction = (listType, identifier, name, derived, classIdentifier) => {
    const key = `${listType}:${identifier}`;
    const source = sourceLists.get(key);
    // Comprehensive page = bridge-derived ∪ existing source lists, so a single
    // page can drive a Spell Book class tab (NOTES.md §4.2).
    const desired = new Set(derived);
    for (const uuid of source?.uuids ?? []) desired.add(uuid);
    const existing = existingPages.get(key);
    const current = new Set(existing?.system.spells ?? []);
    for (const u of desired) covered.add(u);
    for (const u of current) covered.add(u);
    const added = [...desired].filter(u => !current.has(u));
    const stale = [...current].filter(u => !desired.has(u));
    const kind = !existing ? "create" : added.length ? "update" : "unchanged";
    plan.actions.push({
      kind,
      listType,
      identifier,
      classIdentifier,
      name,
      pageId: existing?.id,
      pageUuid: existing?.uuid,
      added,
      stale,
      sourcePages: source?.pages ?? [],
      total: current.size + added.length
    });
  };

  // Class lists: only where the bridge actually derives membership (or a
  // generated page already exists and must be maintained).
  for (const [identifier, target] of targets) {
    if (restrict && !restrict.has(identifier)) continue;
    const derived = index.classes.get(identifier);
    const hasPage = existingPages.has(`class:${identifier}`);
    if (!derived?.size && !hasPage) {
      const hasSourceList = sourceLists.has(`class:${identifier}`);
      if (target.fromOverride) {
        // Override key resolved to zero spells — the psi-point/discipline case.
        plan.skipped.push(game.i18n.format(`${MODULE_ID}.plan.skippedPsi`, { name: target.name, identifier }));
      } else if (target.progression !== "none" && !hasSourceList) {
        // Caster with no derivable membership and no existing list anywhere.
        plan.skipped.push(game.i18n.format(`${MODULE_ID}.plan.skippedEmpty`, { name: target.name, identifier }));
      }
      continue;
    }
    makeAction("class", identifier, target.name, derived ?? new Set());
  }

  // Subclass lists, only for classes actually present.
  for (const [key, uuids] of index.subclasses) {
    const [classId, subclassId] = key.split("/");
    if (restrict && !restrict.has(classId)) continue;
    if (!targets.has(classId)) continue;
    const name = index.subclassNames.get(key) ?? subclassId;
    makeAction("subclass", subclassId, name, uuids, classId);
  }

  // "Unmapped" should mean "on no list at all" — a spell Plutonium data can't
  // map is fine if an override or an existing list already covers it.
  plan.unmapped = plan.unmapped.filter(s => !covered.has(s.uuid));

  return plan;
}

/**
 * Apply a reconcile plan: batched page create/update, dnd5e registration,
 * Spell Book toggle/assignment. Never deletes; `stale` entries are report-only.
 * @param {ReconcilePlan} plan
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]  Log/report only, no writes.
 * @param {(done: number, total: number, label: string) => void} [options.onProgress]
 * @returns {Promise<object>} Structured report (also stored for `exportReport`).
 */
export async function applyPlan(plan, { dryRun = false, onProgress } = {}) {
  if (!game.user.isGM) throw new Error(`${MODULE_ID}: reconcile writes are GM-only`);
  const batchSize = game.settings.get(MODULE_ID, SETTINGS.BATCH_SIZE) || 100;
  const report = {
    module: MODULE_ID,
    version: game.modules.get(MODULE_ID)?.version,
    world: game.world.id,
    foundry: game.version,
    dnd5e: game.system.version,
    dryRun,
    generatedAt: plan.generatedAt,
    appliedAt: new Date().toISOString(),
    created: [],
    updated: [],
    unchanged: [],
    stale: [],
    skipped: plan.skipped,
    unmapped: plan.unmapped,
    unresolvedOverrides: plan.unresolvedOverrides,
    warnings: [...plan.warnings],
    spellBook: { registryToggled: 0, hiddenSources: 0, assignedActors: {} }
  };

  for (const a of plan.actions) {
    const entry = { identifier: a.identifier, type: a.listType, name: a.name, added: a.added.length, total: a.total };
    report[a.kind === "create" ? "created" : a.kind === "update" ? "updated" : "unchanged"].push(entry);
    if (a.stale.length) report.stale.push({ identifier: a.identifier, type: a.listType, spells: a.stale });
  }

  if (dryRun) {
    log("Dry run — no writes performed", report);
    await setLastReport(report);
    return report;
  }

  const actionable = plan.actions.filter(a => a.kind !== "unchanged");
  const pack = await getPack();
  let journal = await getJournal(pack);
  journal ??= await JournalEntry.create(
    { name: JOURNAL_NAME, flags: { [MODULE_ID]: { [PAGE_FLAGS.GENERATED]: true } } },
    { pack: pack.collection }
  );

  const now = new Date().toISOString();
  const toCreate = [];
  const toUpdate = [];
  for (const a of actionable) {
    if (a.kind === "create") {
      toCreate.push({
        name: a.name,
        type: "spells",
        system: {
          type: a.listType,
          identifier: a.identifier,
          grouping: "level",
          description: { value: game.i18n.format(`${MODULE_ID}.page.description`, { name: a.name }) },
          spells: a.added
        },
        flags: {
          [MODULE_ID]: {
            [PAGE_FLAGS.GENERATED]: true,
            [PAGE_FLAGS.IDENTIFIER]: a.identifier,
            [PAGE_FLAGS.CLASS_IDENTIFIER]: a.classIdentifier ?? null,
            [PAGE_FLAGS.UPDATED]: now
          }
        }
      });
    } else {
      const page = journal.pages.get(a.pageId);
      const merged = new Set(page?.system.spells ?? []);
      for (const uuid of a.added) merged.add(uuid);
      toUpdate.push({
        _id: a.pageId,
        "system.spells": [...merged],
        [`flags.${MODULE_ID}.${PAGE_FLAGS.UPDATED}`]: now
      });
    }
  }

  const totalOps = toCreate.length + toUpdate.length;
  let done = 0;
  const progress = label => onProgress?.(++done, totalOps, label);

  try {
    for (const batch of chunk(toCreate, batchSize)) {
      const created = await journal.createEmbeddedDocuments("JournalEntryPage", batch);
      for (const page of created) progress(page.name);
    }
    for (const batch of chunk(toUpdate, batchSize)) {
      const updated = await journal.updateEmbeddedDocuments("JournalEntryPage", batch);
      for (const page of updated) progress(page.name);
    }
  } catch (err) {
    log("Reconcile write failed", err);
    report.warnings.push(String(err.message ?? err));
    ui.notifications.error(game.i18n.localize(`${MODULE_ID}.notify.writeFailed`));
    await setLastReport(report);
    return report;
  }

  // Re-read and register every generated page with the dnd5e registry.
  journal = await getJournal(pack);
  const touched = [];
  for (const page of journal?.pages ?? []) {
    if (page.type !== "spells" || !page.getFlag(MODULE_ID, PAGE_FLAGS.GENERATED)) continue;
    touched.push(page);
    try {
      await dnd5e.registry.spellLists.register(page.uuid);
    } catch (err) {
      log(`Failed to register ${page.name} with dnd5e registry`, err);
      report.warnings.push(`register ${page.system.identifier}: ${err.message}`);
    }
  }

  // Spell Book interop: registry toggle + optional actor assignment + optional source hiding.
  report.spellBook.registryToggled = await ensureSpellBookRegistryToggle(touched.map(p => p.uuid));

  if (isSpellBookActive() && game.settings.get(MODULE_ID, SETTINGS.ASSIGN_TO_ACTORS)) {
    for (const page of touched) {
      const classId = page.system.type === "class" ? page.system.identifier : page.getFlag(MODULE_ID, PAGE_FLAGS.CLASS_IDENTIFIER);
      if (!classId) continue;
      const subclassId = page.system.type === "subclass" ? page.system.identifier : undefined;
      const assigned = await assignListToActors(classId, page.uuid, subclassId);
      if (assigned.length) report.spellBook.assignedActors[page.system.identifier] = assigned;
    }
  }

  if (game.settings.get(MODULE_ID, SETTINGS.AUTO_HIDE_SOURCE_LISTS)) {
    const sourceUuids = [...new Set(actionable.flatMap(a => a.sourcePages))];
    report.spellBook.hiddenSources = await hideSourceListsInSpellBook(sourceUuids);
  }

  await setLastReport(report);
  log("Reconcile complete", report);
  return report;
}

let _lastReport = null;

/**
 * Remember the most recent report (persisted to a world setting for exports after reload).
 * @param {object} report
 */
async function setLastReport(report) {
  _lastReport = report;
  if (game.user.isGM) {
    try {
      await game.settings.set(MODULE_ID, SETTINGS.LAST_REPORT, report);
    } catch (err) {
      log("Could not persist last report", err);
    }
  }
}

/** @returns {object|null} Most recent reconcile report. */
export function getLastReport() {
  if (_lastReport) return _lastReport;
  const stored = game.settings.get(MODULE_ID, SETTINGS.LAST_REPORT);
  return stored && Object.keys(stored).length ? stored : null;
}

/**
 * Register all previously generated pages with the dnd5e registry.
 * Runs on every client at ready — registration is client-side (NOTES.md §1.3).
 * @returns {Promise<number>} Number of pages registered.
 */
export async function registerGeneratedLists() {
  const pack = game.packs.get(PACK_ID);
  if (!pack) return 0;
  let count = 0;
  try {
    const journal = await getJournal(pack);
    for (const page of journal?.pages ?? []) {
      if (page.type !== "spells" || !page.getFlag(MODULE_ID, PAGE_FLAGS.GENERATED)) continue;
      await dnd5e.registry.spellLists.register(page.uuid);
      count++;
    }
  } catch (err) {
    log("Failed to register generated lists at ready", err);
  }
  return count;
}
