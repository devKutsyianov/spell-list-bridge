# Spell List Bridge (Plutonium → Spell Book)

Automatically generates and registers **dnd5e class/subclass spell-list journal
pages** from **Plutonium**-imported spells, so **[Spell Book](https://github.com/Sayshal/spell-book)**
and the native dnd5e class filters recognize them — no more hand-building lists
in the Spell List Manager after every import or level-up.

- Foundry **v13/v14**, dnd5e **5.3+** (2014 & 2024 rules).
- No hard dependencies: Plutonium and Spell Book are soft-detected. Without
  Plutonium, the manual trigger + override JSON still work; without Spell Book,
  lists are still registered with the dnd5e system registry.

## How it works

1. **Membership resolution** (first hit wins, then merge/dedupe):
   1. **Override JSON** — authoritative for homebrew classes 5etools doesn't know.
   2. **Plutonium flags** — `flags.plutonium.spellClassNames` baked onto imported
      spells, with a fallback to Plutonium's bundled 5etools lookup
      (`gendata-spell-source-lookup.json`, covers 2014 *and* 2024 sources).
   3. **Existing lists** — pages already registered for the same identifier are
      merged in additively, so a generated page is *comprehensive* (SRD + imports).
2. **Writes** go to this module's own compendium pack
   **“Generated Spell Lists”** — one `spells` journal page per class identifier
   and per subclass identifier, keyed to the *real* `system.identifier` of the
   class items. Packaged/locked lists are never edited.

   > Why a pack and not a world journal? Spell Book only discovers spell lists
   > in **JournalEntry compendium packs** — a world journal would be invisible
   > to it (see `NOTES.md` §2.1).
3. **After writing**, every touched page is registered with
   `dnd5e.registry.spellLists` (all clients, every reload), added to Spell
   Book's per-list **registry toggle** (`registryEnabledLists`), and — optionally —
   assigned to world actors whose Spell Book class rules have no list yet.
4. Reconcile is **idempotent and non-destructive**: re-running changes nothing
   new; merges are additive; entries that stopped being derivable are *reported*
   (`stale`), never deleted.

## The workflow

```
Plutonium import / level-up ──▶ Spell List Bridge (auto or “Sync Spell Lists”) ──▶
Generated Spell Lists pack ──▶ dnd5e registry + Spell Book tabs/filters
```

- **Auto**: watches `createItem` (Plutonium-flagged spells, embedded classes/
  subclasses) and `dnd5e.advancementManagerComplete`; debounced; reconciles only
  the affected class identifiers. (Plutonium emits no hooks of its own.)
- **Manual**: GM-only **“Sync Spell Lists”** button in the Journal directory
  footer, or the settings menu. Shows a preview (create/update/merge, skipped
  classes, unmapped spells) before writing; supports dry-run.
- **On ready**: opt-in setting to open the preview at world start.

## Review & edit workflow (v0.2)

Auto-sync now opens the **review window** instead of writing silently (setting:
*Review window before auto-sync applies*, on by default). The window shows every
planned create/update — including a **Removing** column — plus a
**"Detected without a spell list"** section for classes/subclasses found on
actors or in packs that no data source could populate (the common case:
subclasses whose spells 5etools doesn't map).

- **Edit list** (pencil, per row) / **Create list** (missing section) opens the
  list editor: the left column is everything the list will contain after the
  sync; the right column searches the source compendiums to add spells.
- Removals become permanent **exclusions**, additions permanent **inclusions** —
  both are stored as overrides in a world setting (merged with the override
  JSON file), so they survive every future re-sync.
- Nothing is written until you press **Apply** in the review window.

## Homebrew (the Psion case)

Homebrew classes have no 5etools mapping — their membership comes from the
override JSON. Point the **Override mapping JSON path** setting at a file in
your Data folder (e.g. `worlds/my-world/spell-overrides.json`):

```jsonc
{
  "psion": {
    "spells": ["Fire Bolt", "Mage Hand", "Compendium.world.my-spells.Item.abcdef1234567890"],
    "subclasses": {
      "telepath": { "spells": ["Detect Thoughts"] }
    }
  }
}
```

- Keys are **class identifiers** — check the actual value on the Class item
  (Item sheet → Details → Identifier); the module always reads the real
  identifier from the item, but override keys must match it.
- Spell entries may be **names** (resolved case-insensitively against the source
  compendiums; all printings match) or full **UUIDs**. Unresolved entries are
  listed in the preview and in `reportUnmapped()`.
- **Psi-point / discipline builds**: if a class's powers are *features* rather
  than spells, its override resolves to no spell items and the class is skipped
  with a clear warning instead of creating an empty list.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Source Compendiums | all Item packs | Menu with per-pack checkboxes |
| Auto-sync after imports and level-ups | on | Debounced, affected identifiers only |
| Open sync preview at world start | off | Opt-in |
| Assign generated lists to actors (Spell Book) | on | Only fills *empty* class rules |
| Hide source lists in Spell Book after merge | off | Writes Spell Book's `hiddenSpellLists` |
| Override mapping JSON path | — | See above |
| Write batch size | 100 | Journal pages per DB call |
| Default to dry-run | off | Makes auto-sync report-only too |

## API

```js
const api = game.modules.get("spell-list-bridge").api;
await api.reconcile({ dryRun: true });          // full reconcile, report only
await api.reconcile({ interactive: true });     // open the preview dialog
await api.reconcile({ identifiers: ["psion"] });// restrict to one class
await api.reportUnmapped();                     // spells with no class + bad overrides
await api.spellsNotInLists();                   // wraps Spell Book's diagnostic
api.exportReport();                             // download last report as JSON
```

Every reconcile stores a structured report (also world-persisted); export it
with `api.exportReport()` when filing issues.

## Test plan

1. **Import** a class (e.g. Wizard) and a batch of spells via Plutonium into a
   world compendium; add the class to a test character.
2. Click **Sync Spell Lists** in the Journal directory footer. The preview
   should list a `wizard` **Create** (or **Update**) action whose *Adding* count
   matches the imported spells not already on an existing wizard list. Apply.
3. Confirm:
   - The **Generated Spell Lists** compendium contains a “Wizard” spells page
     whose identifier is `wizard`.
   - **Spell Book → Spell List Manager** shows the generated list, and the
     actor's class tab shows the spells (auto-assigned when the class rules had
     no list).
   - The **dnd5e compendium browser** spell tab filters by the class.
   - `game.modules.get("spell-book").api.spellsNotInLists()` reports fewer
     (ideally zero new) uncovered spells than before the sync.
4. **Level-up path**: level the character with Plutonium or dnd5e advancement —
   the auto-sync notification should appear within a few seconds (when enabled).
5. **Homebrew path**: add an override JSON with a `psion` entry, import/create
   the Psion class item, re-sync, and confirm a `psion` list appears and is
   assigned. Then try a discipline-style class with no spells and confirm the
   *skipped* warning instead of an empty list.
6. **Idempotency**: run Sync again immediately — every action should read
   **Unchanged**.

## Known limitations

- **Auto-sync trigger scope**: compendium imports fire hooks only on the client
  that ran the import, so that client must be a GM for auto-sync to trigger;
  world/actor changes trigger on the active GM's client.
- **Spell Book rules cache**: Spell Book caches per-actor class rules in memory
  for the session. If a client read an actor's rules *before* a sync assigned a
  list (e.g. the Spell Book was open), that client may not see the assignment
  until reload — Spell Book exposes no cache-invalidation API.
- **dnd5e registry is additive-only**: spells removed from a generated page
  (reported as *stale*, never auto-deleted) stay in the in-memory registry until
  the next world reload.

## Files

- `NOTES.md` — Step-0 investigation of the installed dnd5e/Spell Book/Plutonium
  sources (schemas, flags, hooks, and the design consequences).
- `scripts/` — ES modules (`reconcile.mjs` is the engine; `membership.mjs` the
  resolver; `integrations.mjs` the Plutonium/Spell Book seams).
