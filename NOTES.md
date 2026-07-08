# NOTES.md — Step-0 investigation of the installed environment

Investigated on 2026-07-08 against the **actual installed sources** in
`C:\Users\uniks\AppData\Local\FoundryVTT\Data`.

| Package | Version | Source read |
|---|---|---|
| Foundry VTT | v14 (verified 14.360–14.363 by both modules) | — |
| dnd5e system | **5.3.3** | `systems/dnd5e/dnd5e.mjs` (compiled, 82 992 lines) |
| Spell Book (`spell-book`) | **2.1.0** | `modules/spell-book/scripts/**` (readable ESM) |
| Plutonium (`plutonium`) | **2.15.2** | `modules/plutonium/js/Bundle.js` + `data/**` |

Line numbers below refer to those files as installed.

---

## 1. dnd5e 5.3.3 — spell-list journal pages & registry

### 1.1 Page subtype and schema

- Subtype string: **`"spells"`** (`JournalEntryPage.type`), registered in
  `CONFIG.JournalEntryPage.dataModels` as `spells: SpellListJournalPageData`
  (dnd5e.mjs:77311, config at :77425).
- Schema (`SpellListJournalPageData.defineSchema`, dnd5e.mjs:77313):
  - `type` — StringField, **initial `"class"`**. Valid values come from
    `CONFIG.DND5E.spellListTypes` (dnd5e.mjs:46877):
    `class`, `subclass`, `background`, `race`, `other`.
  - `identifier` — `IdentifierField` (dnd5e slug format).
  - `grouping` — StringField, initial `"level"`; choices `none|alphabetical|level|school`.
  - `description.value` — HTMLField.
  - `spells` — **`SetField<StringField>` of full document UUIDs**.
  - `unlinkedSpells` — ArrayField of `{_id, identifier, name, system:{level, school}, source:{uuid,...}}`
    for spells that aren't in any compendium.

### 1.2 Exact UUID format stored in `spells`

The sheet's drop handler (`JournalSpellListPageSheet._onDrop`, dnd5e.mjs:67553)
stores **`item.uuid` verbatim** — i.e. full UUIDs like
`Compendium.<scope>.<packName>.Item.<id>` (or a world `Item.<id>` if a world item
is dropped). No normalization is applied on write. Matching against owned actor
spells is done via `item._stats.compendiumSource` (`SpellList#has`, dnd5e.mjs:81900),
so **compendium UUIDs are strongly preferred** — world-item UUIDs won't match
actors' imported copies.

### 1.3 Registry discovery & registration

- Registry object: **`dnd5e.registry.spellLists`** → static class `SpellListRegistry`
  (dnd5e.mjs:81662), assembled into `dnd5e.registry` at :82047.
- At **`setup`** (dnd5e.mjs:82443–82446) the system registers:
  1. `DND5E.SPELL_LISTS` — hard-coded array of `Compendium.dnd5e.content24...` /
     SRD page UUIDs (2014 legacy set is swapped in via `applyLegacyRules`, :50311).
  2. `registerModuleData()` (:81195) — scans `game.system`, every **active module**,
     and `game.world` manifests for **`flags.dnd5e.spellLists: [pageUuid, ...]`**
     and calls `dnd5e.registry.spellLists.register(uuid)` for each.
- **Public re-scan API: `await dnd5e.registry.spellLists.register(uuid)`** (:81753).
  - Callable **any time after `ready`** (before ready it self-defers via
    `Hooks.once("ready", ...)`).
  - It is **client-side and in-memory** — every client must call it; it is safe
    to call repeatedly (a `SpellList` keyed by `type:identifier` is reused, and
    `contribute(page)` re-reads the page's current `system.spells`).
  - **Merging is native**: multiple pages with the same `system.type` +
    `system.identifier` merge additively into one `SpellList` (:81773–:81777,
    `contribute` :81889). We do *not* need to clone-and-extend SRD pages for the
    dnd5e side — registering a second "wizard" page extends the wizard list.
  - **There is no unregister/remove.** `contribute` only adds; deletions from a
    page take effect on the next full reload. Reconcile must therefore be
    additive-live + report-only for removals (matches our non-destructive spec).
- Readiness: `dnd5e.registry.spellLists.ready` (bool) and `dnd5e.registry.ready`
  (Promise, `RegistryStatus`, :82001). No hook fires on registry refresh.
- Lookup APIs used elsewhere: `.forType("class","wizard")` → `SpellList|null`,
  `.forSpell(uuid)` → `Set<SpellList>`, `.options` → grouped `{value:"class:wizard", label}[]`.
- `SpellList#name` resolves the display name via `dnd5e.registry.classes`
  (an `ItemRegistry("class")`) by identifier, falling back to the page name (:81858).
- The compendium-browser class filter (dnd5e.mjs:21977–22005) filters spells by
  `system.identifier ∈ list.identifiers` using this registry — so a registered
  generated list immediately drives the native class filter.

### 1.4 Spell → class linkage on items (5.3 change, 2024 rules)

- `SpellData#sourceClass` is **deprecated since 5.3** (dnd5e.mjs:22046); the live
  path is `system.sourceItem` → `classIdentifier` getter (:22030) which resolves
  through subclass parentage. List association itself is untouched by the 2024
  prepared-casting changes — preparation flows read the registry the same way.
  Nothing in the 2024 rules path keys off journal metadata other than
  `type:identifier`, confirmed by the `spellcasting.preparation` code paths.

---

## 2. Spell Book 2.1.0

### 2.1 Where it reads lists from — **critical finding**

Spell Book does **not** read from the dnd5e registry for its own UI, and it does
**not see world journals at all**:

- List discovery (`findAllSpellLists`, `scripts/data/custom-lists.mjs:276` and
  `loadSpellListOptions`, `scripts/dialogs/class-rules.mjs:39`) iterates
  **`game.packs` of type `JournalEntry` only**, plus its own custom pack
  `spell-book.custom-spell-lists` (unlocked at `ready`, `spell-book.mjs:25`).
- ⇒ **A "Generated Spell Lists" world journal would be invisible to Spell Book.**
  The prompt's suggested world-journal target contradicts the installed source;
  generated pages must live in a **JournalEntry compendium pack**. This module
  therefore ships its own world-writable pack
  `spell-list-bridge.generated-spell-lists` (any JournalEntry pack is scanned by
  Spell Book, not just its own).

### 2.2 What actually feeds a class tab

- The player app resolves spells for a class tab **exclusively** from per-actor
  config: `actor.flags["spell-book"].classRules.<classIdentifier>.customSpellList`
  (array of page UUIDs) + `.customSubclassSpellList`
  (`scripts/data/spell-list-resolver.mjs:14` — comment: *"No registry fallback:
  both lists are explicit per-actor config"*; defaults are `[]`,
  `rule-set.mjs:207`).
- When a class resolves to no list, Spell Book whispers a GM notice
  (`managers/spellcasting-notice.mjs:31`) triggered by `createItem`
  (class/subclass) and `dnd5e.advancementManagerComplete`.
- ⇒ For the bridge to be end-to-end automatic, after generating a list we should
  (optionally, GM-gated) fill empty `classRules.<id>.customSpellList` on world
  actors with the generated page UUID. Flag key constants:
  `FLAGS.CLASS_RULES = "classRules"` (`constants.mjs:13`).

### 2.3 The "registry toggle"

- World setting **`spell-book` / `registryEnabledLists`** — an **array of page
  UUIDs** (`constants.mjs:73`).
- At `ready`, **GM client only**, `registerCustomSpellLists()`
  (`data/spell-list-registry.mjs:14`) calls
  `dnd5e.registry.spellLists.register(uuid)` for each entry and prunes invalid ones.
- Live helpers: `toggleListForRegistry(uuid)`, `ensureListRegistered(uuid)`
  (adds to the setting **and** live-registers). These are internal ESM exports,
  not on the public API — we replicate the behavior by writing the setting and
  calling the dnd5e registry ourselves (safe: the setting is a plain array).
- Hidden lists: world setting `hiddenSpellLists` (array of source-page UUIDs) —
  this is what "auto-hide source lists after merge" should write.
- Custom-list mappings (clone-on-save of packaged lists): world setting
  `customSpellListMappings` (`{originalUuid: customUuid}`); duplicated pages get
  `flags["spell-book"].{isDuplicate, originalUuid, originalModTime, ...}`
  (`custom-lists.mjs:41`). Our module never edits packaged pages, so we don't
  need this path — we mirror the *principle* (never edit locked originals) by
  only ever writing to our own unlocked pack.

### 2.4 Public API & hooks

- `game.modules.get("spell-book").api` === `globalThis.SPELLBOOK.api`
  (`api.mjs:298`): `flagPurge, hasConfiguredCompendiums, openClassRulesForActor,
  openSpellBookForActor, spellBookQuickAccess, spellSlotTracker, scrollScanner,
  spellsNotInLists, debugSpell`.
- **`spellsNotInLists()`** (`api.mjs:213`): scans *all Item packs*' spell indexes
  vs all discoverable lists (via `findAllSpellLists`), then shows a GM DialogV2
  report (console-copy button). Returns `undefined` — it is UI, not data; our
  wrapper just invokes it (and our own `reportUnmapped()` provides the
  data-shaped equivalent).
- **`debugSpell(name)`** (`api.mjs:278`): fetches all spells, case-insensitive
  substring match, logs + returns `{name, uuid, compendiumSource, ...}` summaries.
- Hooks emitted: `spellBookOpened` (`{actor, app}`, player-spell-book.mjs:237),
  `spellBookClosed` (`{actor}`, :358).
- No public "refresh lists" API. Cache invalidation
  (`SpellDataManager.invalidateAllCaches`) is wired to journal-page CUD **only
  for its own custom pack** (`hooks.mjs:22–30`). Writes to our pack are picked
  up on next Spell Book open (it re-reads pages), so no action needed.
- Its GM list-manager button is injected on **`activateCompendiumDirectory`**
  into `.directory-footer` (`utils/sheets.mjs`, `addJournalSpellBookButton`) —
  we mirror the same DOM pattern for our Sync button on `renderJournalDirectory`.

---

## 3. Plutonium 2.15.2

### 3.1 Hooks / events — **none emitted**

The bundle contains **no `Hooks.call`/`Hooks.callAll` of any Plutonium-specific
event** (verified by exhaustive grep over `js/Bundle.js`; only core `Hooks.on/once`
listeners exist). There is **no import or level-up hook to subscribe to.**
⇒ Auto-trigger must watch core document events instead:

- `createItem` — fires for embedded class/subclass items (Plutonium level-up /
  class import writes real embedded Items) and for world/compendium spell
  imports; Plutonium-imported docs are identifiable by `flags.plutonium`.
- `dnd5e.advancementManagerComplete` — fires after dnd5e advancement flows
  (same trigger Spell Book uses for its notice).
- Both are debounced and coalesced per affected class identifier.

### 3.2 5etools metadata flags on imported documents

Every importer stamps **`flags.plutonium = { page, source, hash, ... }`**
(flag scope = `SharedConsts.MODULE_ID = "plutonium"`). For **spells**
(`_getSpellFlags`, Bundle.js:133261):

```js
flags.plutonium = {
  page: "spells.html",              // UrlUtil.PG_SPELLS
  source: spell.source,             // 5etools source code, e.g. "PHB", "XPHB"
  hash: "fire%20bolt_phb",          // 5etools URL hash
  propDroppable: "spell",
  // Baked-in class names (5etools `fromClassList`), e.g. ["Sorcerer","Wizard"]:
  spellClassNames: [...],
  // Only when imported via class import / level-up:
  parentClassName, parentClassSource, parentSubclassName, parentSubclassSource
}
```

- `spellClassNames` is the primary flag-derived membership source.
- Class items: `system.identifier` = `UtilDocumentItem.getNameAsIdentifier(cls.name)`
  (Bundle.js:140307) — a re-implementation of dnd5e's `formatIdentifier`
  (slugify strict; `/`→`-`). Subclasses get `identifier` from side-data or
  slugified name, plus the parent-class identifier. ⇒ Plutonium class
  identifiers match `dnd5e.utils.formatIdentifier(name)`, but we still always
  read the real `system.identifier` from the Class item.

### 3.3 Full spell→class/subclass lookup shipped on disk

**`modules/plutonium/data/generated/gendata-spell-source-lookup.json`** (616 KB)
— the same file 5etools uses (`Renderer.spell._pInitPreData_`, Bundle.js:11226).
Structure (all keys lowercase for spell source & name):

```jsonc
{
  "phb": {
    "fireball": {
      "class":    { "PHB": { "Sorcerer": true, "Wizard": true }, "XPHB": {...}, "TCE": {...} },
      "subclass": { "PHB": { "Fighter": { "PHB": { "Eldritch Knight": { "name": "Eldritch Knight" } } } }, ... },
      "feat": {...}, "reward": {...}   // ignored by this module
    }
  }
}
```

- Distinguishes 2014 (`PHB`) vs 2024 (`XPHB`) class sources — we merge by class
  *identifier*, which is what the dnd5e registry keys on anyway.
- This is the **fallback** when a spell lacks `spellClassNames` (older imports):
  look up by (`flags.plutonium.source.toLowerCase()`, `name.toLowerCase()`).

### 3.4 Import targets

Plutonium has no fixed import compendium: targets (world folder vs. arbitrary
compendium) are chosen per-import in its UI. ⇒ Source compendiums must be a
module **setting** (default: every visible Item pack that can contain spells),
same posture Spell Book takes with dnd5e's `packSourceConfiguration`.

---

## 4. Design consequences (deltas from the original brief)

1. **Generated lists live in a module compendium pack**, not a world journal —
   Spell Book cannot see world journals (§2.1). One `JournalEntry`
   ("Generated Spell Lists") in `spell-list-bridge.generated-spell-lists`,
   one `spells` page per class identifier / subclass identifier.
2. **Generated pages are comprehensive**: seeded with the union of existing
   registered lists for the identifier + Plutonium-derived + overrides. Reason:
   Spell Book actor tabs read *only* the assigned page(s) (§2.2), so a
   supplement-only page would lose SRD spells for the actor.
3. **Persistence of registration across reloads** cannot use manifest flags (we
   can't edit our own manifest at runtime): we re-register our pages on every
   client's `ready`, and *additionally* add them to Spell Book's
   `registryEnabledLists` when present (belt and braces + surfaces its toggle UI).
4. **No Plutonium hooks** ⇒ auto-trigger = debounced `createItem` +
   `dnd5e.advancementManagerComplete` (§3.1).
5. **Removals are report-only** while live (dnd5e registry has no unregister,
   §1.3); page contents are still trimmed only on explicit user confirmation —
   default reconcile is additive.
6. **Psi-point / discipline builds**: class items whose
   `system.spellcasting.progression` is `"none"`/absent and whose override
   resolves to no spell-type items get skipped with a clear warning instead of
   an empty list.
