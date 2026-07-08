/** @file Entry point: init/ready wiring. */

import { createApi } from "./api.mjs";
import { MODULE_ID, SETTINGS } from "./constants.mjs";
import { registerGeneratedLists } from "./reconcile.mjs";
import { registerSettings } from "./settings.mjs";
import { manualReconcile, registerTriggers } from "./triggers.mjs";
import { log } from "./util.mjs";

Hooks.once("init", () => {
  registerSettings();
  registerTriggers();
  createApi();
  log("Initialized");
});

Hooks.once("ready", async () => {
  // Registration is client-side and in-memory (NOTES.md §1.3): every client
  // must register the generated pages so class filters work for players too.
  const count = await registerGeneratedLists();
  if (count) log(`Registered ${count} generated spell list page(s) with the dnd5e registry`);

  // The pack is unlocked lazily by applyPlan when a write actually happens.
  if (game.user.isGM && game.settings.get(MODULE_ID, SETTINGS.RECONCILE_ON_READY)) {
    log("Reconcile-on-ready is enabled — opening preview");
    manualReconcile();
  }
});
