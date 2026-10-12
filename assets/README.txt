ASSETS — image icon manifest
============================

Drop the images below into this `assets/` folder using the EXACT file names
listed. app.js references these paths directly (e.g. "assets/genshin.png").
Square, transparent PNG preferred (SVG also works). ~64px is plenty.

If a file is missing, the app hides its <img> gracefully — nothing breaks.

Game icons
----------
  genshin.png        Genshin Impact
  hsr.png            Honkai: Star Rail
  zzz.png            Zenless Zone Zero
  wuwa.png           Wuthering Waves
  endfield.png       Arknights: Endfield
  nte.png            Neverness to Everness
  arknights.png      Arknights
  gfl2.png           Girls' Frontline 2: Exilium

Premium-currency icons
----------------------
  primogem.png       Primogem            (Genshin Impact)
  stellarjade.png    Stellar Jade        (Honkai: Star Rail)
  polychrome.png     Polychrome          (Zenless Zone Zero)
  astrite.png        Astrite             (Wuthering Waves)
  oroberyl.png       Oroberyl            (Arknights: Endfield)
  annulith.png       Annulith            (Neverness to Everness)
  orundum.png        Orundum             (Arknights)
  collapsepieces.png Collapse Pieces     (Girls' Frontline 2: Exilium)

Tip: pull icons from the games' official press kits / subreddits / X posts.

Character portraits
------------------
Portraits are optional fields in gamedata.js. If a portrait is missing or fails
to load, the app displays that game's icon instead.

  characters/vesna.png
  characters/vodyanitsa.png
  characters/mitya.png
  characters/pearl.png
  characters/aha.png
  characters/roxy.png
  characters/phoenix.png
  characters/severian.png
  characters/hsin.jpg
  characters/suoming.jpg
  characters/blackbird.png
  characters/akane-rin.png
  characters/closure.png
  characters/mityl.png
  characters/welrod.png

Sources: each image was downloaded from the applicable game wiki's file/API
record (Fandom for Genshin, HSR, ZZZ, WuWa, NTE, and Arknights; IOP Wiki for
Girls' Frontline 2). No portrait was found for Typhoeus, Si, Argent Flow, Zima
the Raging Tide, or Kal'tsit Esperanta; those entries use the game-icon fallback.
