/** @file The idempotent reconcile engine: plan → (preview) → apply. */

import { JOURNAL_NAME, MODULE_ID, PACK_ID, PAGE_FLAGS, SETTINGS } from "./constants.mjs";
import { assignListToActors, ensureSpellBookRegistryToggle, hideSourceListsInSpellBook, isSpellBookActive } from "./integrations.mjs";
import { buildMembershipIndex, collectTargetClasses, loadOverrides, scanSourcePacks } from "./membership.mjs";
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
 * @property {boolean} restricted      Whether the plan covered only some identifiers
 * @property {{name: string, uuid: string, source: string}[]} unmapped
 * @property {string[]} unresolvedOverrides
 * @property {string[]} warnings
 * @property {string[]} skipped        Human-readable skip notices (psi-point case etc.)
 * @property {string} generatedAt      ISO timestamp
 */

/**
 * Whether a journal page is one of ours.
 * @param {JournalEntryPage} page
 * @returns {boolean}
 */
function isGeneratedPage(page) {
  return page.type === "spells" && !!page.getFlag(MODULE_ID, PAGE_FLAGS.GENERATED);
}

/**
 * Stable key for a generated page. Subclass pages are scoped by their parent
 * class so same-named subclasses of different classes don't collide.
 * @param {"class"|"subclass"} listType
 * @param {string} identifier
 * @param {string} [classIdentifier]
 * @returns {string}
 */
function listKey(listType, identifier, classIdentifier) {
  return listType === "subclass" ? `subclass:${classIdentifier ?? ""}:${identifier}` : `class:${identifier}`;
}

/**
 * `listKey` derived from an existing generated page.
 * @param {JournalEntryPage} page
 * @returns {string}
 */
function pageListKey(page) {
  return listKey(page.system.type, page.system.identifier, page.getFlag(MODULE_ID, PAGE_FLAGS.CLASS_IDENTIFIER));
}

/**
 * Get the module's generated-lists pack.
 * @param {object} [options]
 * @param {boolean} [options.unlock=false]  Unlock the pack (GM write paths only).
 * @returns {Promise<CompendiumCollection>} The pack.
 */
async function getPack({ unlock = false } = {}) {
  const pack = game.packs.get(PACK_ID);
  if (!pack) throw new Error(`${MODULE_ID}: compendium pack ${PACK_ID} is missing`);
  if (unlock && pack.locked && game.user.isGM) await pack.configure({ locked: false });
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

/** Cache for scanSourceLists — foreign journal packs rarely change mid-session. */
let _sourceListsCache = null;

/** Drop the cached foreign-pack scan (wired to journal-page CUD hooks in triggers.mjs). */
export function invalidateSourceListsCache() {
  _sourceListsCache = null;
}

/**
 * Scan all JournalEntry packs except ours for spells pages, grouped by
 * `${type}:${identifier}`. This is the provenance-clean view of "existing
 * registered lists" used both to seed comprehensive pages and to know which
 * source pages the auto-hide option should hide. Cached between runs.
 * @returns {Promise<Map<string, {uuids: Set<string>, pages: string[]}>>}
 */
async function scanSourceLists() {
  if (_sourceListsCache) return _sourceListsCache;
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
  _sourceListsCache = out;
  return out;
}

/**
 * Build a reconcile plan. Read-only: performs no writes.
 * @param {object} [options]
 * @param {string[]} [options.identifiers]  Restrict to these class identifiers (auto-trigger path).
 * @returns {Promise<ReconcilePlan>} The plan.
 */
export async function planReconcile({ identifiers } = {}) {
  // One override fetch and one source-pack scan shared by both consumers.
  const [overrides, scan] = await Promise.all([loadOverrides(), scanSourcePacks()]);
  const [index, targets, sourceLists] = await Promise.all([
    buildMembershipIndex({ overrides, scan }),
    collectTargetClasses({ overrides, scan }),
    scanSourceLists()
  ]);
  const pack = await getPack();
  const journal = await getJournal(pack);

  /** @type {Map<string, JournalEntryPage>} listKey → existing generated page */
  const existingPages = new Map();
  for (const page of journal?.pages ?? []) {
    if (!isGeneratedPage(page)) continue;
    existingPages.set(pageListKey(page), page);
  }

  const restrict = identifiers?.length ? new Set(identifiers) : null;

  /** @type {ReconcilePlan} */
  const plan = {
    actions: [],
    restricted: !!restrict,
    unmapped: index.unmapped,
    unresolvedOverrides: index.unresolvedOverrides,
    warnings: [...index.warnings],
    skipped: [],
    generatedAt: new Date().toISOString()
  };

  /** Every spell UUID that ends up on (or is already on) any planned list. */
  const covered = new Set();

  const makeAction = (listType, identifier, name, derived, classIdentifier) => {
    const source = sourceLists.get(`${listType}:${identifier}`);
    // Comprehensive page = bridge-derived ∪ existing source lists, so a single
    // page can drive a Spell Book class tab (NOTES.md §4.2).
    const desired = new Set(derived);
    for (const uuid of source?.uuids ?? []) desired.add(uuid);
    const existing = existingPages.get(listKey(listType, identifier, classIdentifier));
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
    const hasPage = existingPages.has(listKey("class", identifier));
    if (!derived?.size && !hasPage) {
      const hasSourceList = sourceLists.has(`class:${identifier}`);
      if (target.fromOverride) {
        // Override key resolved to zero spells — the psi-point/discipline case.
        plan.skipped.push(game.i18n.format(`${MODULE_ID}.plan.skippedPsi`, { name: target.name, identifier }));
      } else if (target.progression !== "none" && !hasSourceList) {
        // Caster with no derivable membership and no existing list anywhere.
        plan.skipped.push(game.i18n.format(`${MODULE_ID}.plan.skippedEmpty`, { name: target.name, identifier }));
      }
      // Casters whose lists already exist outside the bridge are intentionally
      // left alone — dnd5e registers those pages natively.
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
  // map is fine if an override or an existing list already covers it. Restricted
  // plans skip most lists, so their coverage view is partial: report nothing
  // rather than a misleading list.
  plan.unmapped = restrict ? [] : plan.unmapped.filter(s => !covered.has(s.uuid));

  return plan;
}

/** Serialization chain so overlapping applies (auto + manual) never interleave. */
let _applyChain = Promise.resolve();

/**
 * Apply a reconcile plan: batched page create/update, dnd5e registration,
 * Spell Book toggle/assignment. Never deletes; `stale` entries are report-only.
 * Actions are revalidated against the pack's current state at apply time, so a
 * stale plan (preview left open, double submit, overlapping auto-runs) degrades
 * to updates/no-ops instead of duplicating pages. Runs are serialized.
 * @param {ReconcilePlan} plan
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]  Log/report only, no writes.
 * @param {(done: number, total: number, label: string) => void} [options.onProgress]
 * @returns {Promise<object>} Structured report; `report.ok` is false when writes failed.
 */
export function applyPlan(plan, options = {}) {
  const run = _applyChain.then(() => _applyPlan(plan, options));
  _applyChain = run.catch(() => {});
  return run;
}

/**
 * @param {ReconcilePlan} plan
 * @param {object} [options]
 * @param {boolean} [options.dryRun]
 * @param {(done: number, total: number, label: string) => void} [options.onProgress]
 * @returns {Promise<object>}
 */
async function _applyPlan(plan, { dryRun = false, onProgress } = {}) {
  if (!game.user.isGM) throw new Error(`${MODULE_ID}: reconcile writes are GM-only`);
  const batchSize = game.settings.get(MODULE_ID, SETTINGS.BATCH_SIZE) || 100;
  const report = {
    module: MODULE_ID,
    version: game.modules.get(MODULE_ID)?.version,
    world: game.world.id,
    foundry: game.version,
    dnd5e: game.system.version,
    ok: true,
    dryRun,
    restricted: !!plan.restricted,
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

  const entryFor = (a, added, total) => ({ identifier: a.identifier, type: a.listType, name: a.name, added, total });
  for (const a of plan.actions) {
    if (a.stale.length) report.stale.push({ identifier: a.identifier, type: a.listType, spells: a.stale });
    if (a.kind === "unchanged") report.unchanged.push(entryFor(a, 0, a.total));
  }

  if (dryRun) {
    // A dry run reports the plan's prediction — it is labeled as such.
    for (const a of plan.actions) {
      if (a.kind === "unchanged") continue;
      report[a.kind === "create" ? "created" : "updated"].push(entryFor(a, a.added.length, a.total));
    }
    log("Dry run — no writes performed", report);
    await setLastReport(report);
    return report;
  }

  const actionable = plan.actions.filter(a => a.kind !== "unchanged");
  if (!actionable.length) {
    await setLastReport(report);
    return report;
  }

  const pack = await getPack({ unlock: true });
  let journal = await getJournal(pack);
  journal ??= await JournalEntry.create(
    { name: JOURNAL_NAME, flags: { [MODULE_ID]: { [PAGE_FLAGS.GENERATED]: true } } },
    { pack: pack.collection }
  );

  // Revalidate every action against the pack's CURRENT pages: a page created
  // since planning turns a stale "create" into an update or a no-op.
  const currentPages = new Map();
  for (const page of journal.pages) {
    if (isGeneratedPage(page)) currentPages.set(pageListKey(page), page);
  }

  const now = new Date().toISOString();
  const creates = [];
  const updates = [];
  for (const a of actionable) {
    const existing = currentPages.get(listKey(a.listType, a.identifier, a.classIdentifier));
    if (existing) {
      const merged = new Set(existing.system.spells);
      const add = a.added.filter(u => !merged.has(u));
      if (!add.length) {
        report.unchanged.push(entryFor(a, 0, merged.size));
        continue;
      }
      for (const u of add) merged.add(u);
      updates.push({
        data: { _id: existing.id, "system.spells": [...merged], [`flags.${MODULE_ID}.${PAGE_FLAGS.UPDATED}`]: now },
        meta: entryFor(a, add.length, merged.size)
      });
    } else {
      creates.push({
        data: {
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
        },
        meta: entryFor(a, a.added.length, a.added.length)
      });
    }
  }

  const totalOps = creates.length + updates.length;
  let done = 0;
  const progress = label => onProgress?.(++done, totalOps, label);

  // Report entries are pushed only after their batch commits, so a failure
  // mid-apply leaves the report reflecting exactly what was written.
  try {
    for (const batch of chunk(creates, batchSize)) {
      await journal.createEmbeddedDocuments("JournalEntryPage", batch.map(b => b.data));
      for (const b of batch) {
        report.created.push(b.meta);
        progress(b.meta.name);
      }
    }
    for (const batch of chunk(updates, batchSize)) {
      await journal.updateEmbeddedDocuments("JournalEntryPage", batch.map(b => b.data));
      for (const b of batch) {
        report.updated.push(b.meta);
        progress(b.meta.name);
      }
    }
  } catch (err) {
    log("Reconcile write failed", err);
    report.ok = false;
    report.warnings.push(String(err.message ?? err));
    ui.notifications.error(game.i18n.localize(`${MODULE_ID}.notify.writeFailed`));
    await setLastReport(report);
    return report;
  }

  // Re-read and register every generated page with the dnd5e registry.
  journal = await getJournal(pack);
  const touched = [...(journal?.pages ?? [])].filter(isGeneratedPage);
  await registerPages(touched, report);

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
    if (report.spellBook.hiddenSources) {
      ui.notifications.info(game.i18n.format(`${MODULE_ID}.notify.hiddenSources`, { count: report.spellBook.hiddenSources }));
    }
  }

  await setLastReport(report);
  log("Reconcile complete", report);
  return report;
}

/**
 * Register pages with the dnd5e registry, one try/catch per page so a single
 * failure doesn't abort the rest.
 * @param {JournalEntryPage[]} pages
 * @param {object} [report]  Report to append warnings to.
 * @returns {Promise<number>} Number registered.
 */
async function registerPages(pages, report) {
  let count = 0;
  for (const page of pages) {
    try {
      await dnd5e.registry.spellLists.register(page.uuid);
      count++;
    } catch (err) {
      log(`Failed to register ${page.name} with dnd5e registry`, err);
      report?.warnings.push(`register ${page.system.identifier}: ${err.message}`);
    }
  }
  return count;
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
  try {
    const journal = await getJournal(pack);
    return await registerPages([...(journal?.pages ?? [])].filter(isGeneratedPage));
  } catch (err) {
    log("Failed to register generated lists at ready", err);
    return 0;
  }
}
