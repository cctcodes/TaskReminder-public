/*
 * gamedata.js — live game data for the Tasks app.
 *
 * Loaded in index.html BEFORE app.js. Nothing here is fetched at runtime:
 * everything is MANUALLY maintained, so edit the arrays below as schedules are
 * announced. The app degrades gracefully when this file (or any field) is
 * missing.
 *
 * SOURCES: current patch and banner dates are maintained in Upcoming content.txt.
 * Entries without a dated release are intentionally omitted until confirmed.
 *
 * SCHEMA (keyed by the display name used in app.js GAME_PACKS):
 *   icon        : "assets/<file>"        game icon (see assets/README.txt)
 *   currency    : { name, icon }         premium ("gacha") currency + icon
 *   cosmetics   : { name, icon }         optional cosmetics currency + icon
 *   patches     : ["YYYY-MM-DD", ...]    patch / version start dates (ascending)
 *   patchEvents : [{ name, startOffsetDays, endsAtNextPatch | durationDays }]
 *                 Recurring end-game activity tied to each patch. "1 week after
 *                 each patch" => startOffsetDays: 7. With endsAtNextPatch:true
 *                 it runs until the day before the next patch; otherwise it
 *                 lasts durationDays (default 1).
 *   characters  : [{ name, date: "YYYY-MM-DD", portrait, note }]
 *                 New character / banner release dates. Drives the Reminders
 *                 tab and the calendar character markers.
 */
var GAME_META = {
  "Genshin Impact": {
    icon: "assets/genshin.png",
    currency: { name: "Primogem", icon: "assets/primogem.png" },
     patches: ["2026-09-23", "2026-11-04"],
     patchEvents: [],
     characters: [
       { name: "Vesna", date: "2026-09-23", portrait: "assets/characters/vesna.png" },
       { name: "Vodyanitsa", date: "2026-09-23", portrait: "assets/characters/vodyanitsa.png" },
       { name: "Mitya", date: "2026-11-04", portrait: "assets/characters/mitya.png" },
    ],
  },

  "Honkai: Star Rail": {
    icon: "assets/hsr.png",
    currency: { name: "Stellar Jade", icon: "assets/stellarjade.png" },
     patches: ["2026-09-28", "2026-11-11"],
     patchEvents: [],
     characters: [
       { name: "Pearl", date: "2026-09-28", portrait: "assets/characters/pearl.png" },
       { name: "Aha", date: "2026-11-11", portrait: "assets/characters/aha.png" },
     ],
  },

  "Zenless Zone Zero": {
    icon: "assets/zzz.png",
    currency: { name: "Polychrome", icon: "assets/polychrome.png" },
     patches: ["2026-09-09", "2026-10-21"],
     patchEvents: [],
     characters: [
       { name: "Roxy", date: "2026-09-30", portrait: "assets/characters/roxy.png" },
       { name: "Phoenix", date: "2026-10-21", portrait: "assets/characters/phoenix.png" },
       { name: "Severian", date: "2026-11-11", portrait: "assets/characters/severian.png" },
     ],
  },

  "Wuthering Waves": {
    icon: "assets/wuwa.png",
    currency: { name: "Astrite", icon: "assets/astrite.png" },
     patches: ["2026-09-30", "2026-11-11"],
     patchEvents: [],
     characters: [
       { name: "Hsin", date: "2026-09-30", portrait: "assets/characters/hsin.jpg" },
       { name: "Suoming", date: "2026-10-22", portrait: "assets/characters/suoming.jpg" },
     ],
  },

  "Arknights: Endfield": {
    icon: "assets/endfield.png",
    currency: { name: "Oroberyl", icon: "assets/oroberyl.png" },
     patches: ["2026-09-02", "2026-10-15"],
     patchEvents: [],
     characters: [
       { name: "Typhoeus", date: "2026-09-02" },
       { name: "Si", date: "2026-10-15" },
       { name: "Argent Flow", date: "2026-11-05" },
     ],
  },

  "Neverness to Everness": {
    icon: "assets/nte.png",
    currency: { name: "Annulith", icon: "assets/annulith.png" },
    cosmetics: { name: "Fons", icon: "assets/fons.png" },
     patches: ["2026-09-30", "2026-11-11"],
     patchEvents: [],
     characters: [
       { name: "Blackbird", date: "2026-09-30", portrait: "assets/characters/blackbird.png" },
       { name: "Akane Rin", date: "2026-10-21", portrait: "assets/characters/akane-rin.png" },
     ],
  },

  Arknights: {
    icon: "assets/arknights.png",
    currency: { name: "Orundum", icon: "assets/orundum.png" },
     patches: ["2026-09-16", "2026-10-14"],
     patchEvents: [],
     characters: [
       { name: "Zima the Raging Tide", date: "2026-09-16" },
       { name: "Kal'tsit Esperanta", date: "2026-10-14" },
       { name: "Closure", date: "2026-10-14", portrait: "assets/characters/closure.png" },
     ],
  },

  "Girls' Frontline 2: Exilium": {
    icon: "assets/gfl2.png",
    currency: { name: "Collapse Pieces", icon: "assets/collapsepieces.png" },
     patches: ["2026-10-08", "2026-10-29"],
     patchEvents: [],
     characters: [
       { name: "Mityl", date: "2026-10-08", portrait: "assets/characters/mityl.png" },
       { name: "Welrod", date: "2026-10-29", portrait: "assets/characters/welrod.png" },
     ],
  },
};
