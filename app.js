/*
 * Tasks — a static, dependency-free to-do app.
 * Runs entirely in the browser: open index.html, no build step needed.
 * No modules / bundler — this file is loaded via <script src="app.js">.
 *
 * DATA MODEL
 *   tasks: array of task objects
 *   { id, text, done, date, repeat, weekday, monthDay, game, createdAt, spawnOf }
 *   - date     : local "YYYY-MM-DD" string or null (see date helpers — never ISO)
 *   - repeat   : null | "daily" | "weekly" | "monthly" | "interval" | "patch"
 *   - weekday  : 0 (Sun)..6 (Sat), used by weekly tasks
 *   - monthDay : day-of-month (1..31), used by monthly tasks
 *   - intervalDays / anchorDate: reset interval details for managed game schedules
 *   - periodEnd / patchOffsetDays: known patch-activity availability window
 *   - spawnOf  : set when this task was auto-created as the next occurrence of task.id
 *   Tasks are persisted in localStorage under the key "elegant-todo.tasks".
 *
 * RECURRING TASKS
 *   Completing a recurring task marks it done and spawns its next occurrence
 *   (see spawnNext). Un-completing it deletes that next occurrence again.
 *   Future occurrences are HIDDEN from the main list until their date arrives,
 *   but are still projected onto the calendar.
 *
 * COMPLETION RULES
 *   - due today / overdue / no date : completes instantly
 *   - future + recurring            : blocked ("Not due yet")
 *   - future + one-time             : allowed, but only after a confirm dialog
 *
 * RENDERING
 *   The UI is fully re-rendered on every change: mutate `tasks`, then call
 *   render() (which also re-renders the calendar). No VDOM / diffing.
 */
(() => {
  "use strict";

  // localStorage keys
  const STORAGE_KEY = "elegant-todo.tasks";
  const THEME_KEY = "elegant-todo.theme";
  const CHARACTER_DONE_KEY = "elegant-todo.character-reminders";
  const GAME_PACK_SYNC_KEY = "elegant-todo.game-pack-sync.v2";

  // ---- DOM element lookups (ids are defined in index.html) ----

  const form = document.getElementById("taskForm");
  const input = document.getElementById("taskInput");
  const suggestWrap = document.getElementById("suggestWrap");
  const suggestBox = document.getElementById("suggestBox");
  const dueDate = document.getElementById("dueDate");
  const duePick = document.getElementById("duePick");
  const clearDue = document.getElementById("clearDue");
  const list = document.getElementById("taskList");
  const gameBoxes = document.getElementById("gameBoxes");
  const recurringColumn = document.getElementById("recurringColumn");
  const recurringList = document.getElementById("recurringList");
  const recurringCount = document.getElementById("recurringCount");
  const oneshotColumn = document.getElementById("oneshotColumn");
  const oneshotList = document.getElementById("oneshotList");
  const oneshotCount = document.getElementById("oneshotCount");
  const emptyState = document.getElementById("emptyState");
  const emptyTitle = document.getElementById("emptyTitle");
  const emptyMsg = document.getElementById("emptyMsg");
  const counter = document.getElementById("counter");
  const progressLabel = document.getElementById("progressLabel");
  const filters = document.getElementById("filters");
  const clearBtn = document.getElementById("clearCompleted");
  const clearAll = document.getElementById("clearAll");
  const dateLine = document.getElementById("dateLine");

  const viewTabs = document.getElementById("viewTabs");
  const tasksView = document.getElementById("tasksView");
  const remindersView = document.getElementById("remindersView");
  const taskFooter = document.getElementById("taskFooter");

  const themeToggle = document.getElementById("themeToggle");
  const themeIcon = document.getElementById("themeIcon");
  const themeLabel = document.getElementById("themeLabel");

  const calTitle = document.getElementById("calTitle");
  const calDays = document.getElementById("calDays");
  const calPrev = document.getElementById("calPrev");
  const calNext = document.getElementById("calNext");
  const calToday = document.getElementById("calToday");
  const calForm = document.getElementById("calForm");
  const calInput = document.getElementById("calInput");
  const calTaskList = document.getElementById("calTaskList");
  const calSelectedLabel = document.getElementById("calSelectedLabel");
  const calSelectedCount = document.getElementById("calSelectedCount");

  const repeatToggle = document.getElementById("repeatToggle");
  const repeatLabel = document.getElementById("repeatLabel");
  const repeatMenu = document.getElementById("repeatMenu");
  const repeatHint = document.getElementById("repeatHint");

  const confirmModalEl = document.getElementById("confirmModal");
  const confirmTitle = document.getElementById("confirmModalTitle");
  const confirmBody = document.getElementById("confirmModalBody");
  const confirmCancel = document.getElementById("confirmCancelBtn");
  const confirmOk = document.getElementById("confirmOkBtn");

  // ---- app state ----
  let tasks = load();
  let completedCharacters = loadCompletedCharacters();
  let filter = "all"; // "all" | "active" | "completed"
  let repeat = { type: "none", weekday: null }; // pending repeat rule for the next added task
  let view = "tasks"; // left-card view: "tasks" | "reminders"

  // Calendar state (defaults to the current month/day)
  const now = new Date();
  let calYear = now.getFullYear();
  let calMonth = now.getMonth();
  let selectedKey = toKey(now);
  // Calendar day list: which game boxes are expanded (keyed "day::game") so the
  // open/closed state survives re-renders.
  const expandedCalGames = new Set();

  /* ---------- date helpers ----------
   * Dates are stored and compared as LOCAL "YYYY-MM-DD" strings.
   * Always convert with toKey/fromKey; never use toISOString() (it shifts by timezone). */

  function toKey(d) {
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  }

  function fromKey(key) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function todayKey() {
    return toKey(new Date());
  }

  function addDaysKey(key, n) {
    const d = fromKey(key);
    d.setDate(d.getDate() + n);
    return toKey(d);
  }

  function daysBetweenKeys(start, end) {
    const a = start.split("-").map(Number);
    const b = end.split("-").map(Number);
    return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
  }

  function monthlyKey(year, month, day) {
    return toKey(new Date(year, month, Math.min(day, new Date(year, month + 1, 0).getDate())));
  }

  function latestMonthlyStartKey(key, day) {
    const d = fromKey(key);
    const thisMonth = monthlyKey(d.getFullYear(), d.getMonth(), day);
    return thisMonth <= key
      ? thisMonth
      : monthlyKey(d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear(), (d.getMonth() + 11) % 12, day);
  }

  function latestIntervalStartKey(anchor, intervalDays, key) {
    if (key <= anchor) return anchor;
    const steps = Math.floor(daysBetweenKeys(anchor, key) / intervalDays);
    return addDaysKey(anchor, steps * intervalDays);
  }

  // The most recent `weekday` on or before `key` (start of that task's week).
  function weekStartKey(key, weekday) {
    const d = fromKey(key);
    d.setDate(d.getDate() - ((d.getDay() - weekday + 7) % 7));
    return toKey(d);
  }

  function formatShort(key) {
    return fromKey(key).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function formatLong(key) {
    return fromKey(key).toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }

  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  /* Returns the date key of the NEXT occurrence after fromKeyStr, given a task's
   * repeat rule (daily → +1 day, weekly → the chosen weekday, monthly → same
   * day-of-month). Returns null for non-recurring tasks. */
  function nextOccurrenceKey(fromKeyStr, task) {
    const ref = fromKey(fromKeyStr);

    if (task.repeat === "daily") {
      const d = new Date(ref);
      d.setDate(d.getDate() + 1);
      return toKey(d);
    }

    if (task.repeat === "weekly") {
      const wd = task.weekday;
      const d = new Date(ref);
      for (let i = 0; i < 7; i++) {
        d.setDate(d.getDate() + 1);
        if (d.getDay() === wd) break;
      }
      return toKey(d);
    }

    if (task.repeat === "monthly") {
      const day = task.monthDay || ref.getDate();
      const y = ref.getMonth() === 11 ? ref.getFullYear() + 1 : ref.getFullYear();
      const m = (ref.getMonth() + 1) % 12;
      return monthlyKey(y, m, day);
    }

    if (task.repeat === "interval") {
      return addDaysKey(fromKeyStr, task.intervalDays || 14);
    }

    if (task.repeat === "patch") {
      const offset = task.patchOffsetDays || 0;
      return patchOccurrences(task.game || gameOf(task), offset)
        .map((occurrence) => occurrence.start)
        .find((start) => start > fromKeyStr) || null;
    }

    return null;
  }

  /* ---------- storage ---------- */

  // Read tasks from localStorage. Backfills missing fields so older saved data
  // still validates against the current task shape.
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.map((t) => ({ date: null, repeat: null, weekday: null, monthDay: null, game: null, ...t }));
    } catch {
      return [];
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  }

  function loadCompletedCharacters() {
    try {
      const raw = localStorage.getItem(CHARACTER_DONE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveCompletedCharacters() {
    localStorage.setItem(CHARACTER_DONE_KEY, JSON.stringify(completedCharacters));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ---------- dialogs ---------- */

  // Promise-based confirm/reminder modal. Resolves true on OK, false on cancel/
  // dismiss. When cancel:false, only the OK button is shown.
  const confirmModal = bootstrap.Modal.getOrCreateInstance(confirmModalEl);

  function showDialog({ title, body, okLabel = "OK", cancel = true }) {
    return new Promise((resolve) => {
      confirmTitle.textContent = title;
      confirmBody.textContent = body;
      confirmOk.textContent = okLabel;
      confirmCancel.classList.toggle("d-none", !cancel);

      let settled = false;
      const cleanup = () => {
        confirmOk.removeEventListener("click", onOk);
        confirmModalEl.removeEventListener("hidden.bs.modal", onHidden);
      };
      const onOk = () => {
        if (settled) return;
        settled = true;
        cleanup();
        confirmModal.hide();
        resolve(true);
      };
      const onHidden = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      };

      confirmOk.addEventListener("click", onOk);
      confirmModalEl.addEventListener("hidden.bs.modal", onHidden);
      confirmModal.show();
    });
  }

  /* ---------- theme ---------- */

  // Dark/light theme lives on <html data-bs-theme="..."> so Bootstrap's color
  // variables (and our CSS overrides) follow it. Persisted in localStorage.
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-bs-theme", theme);
    const dark = theme === "dark";
    themeIcon.className = "bi " + (dark ? "bi-sun" : "bi-moon-stars");
    themeLabel.textContent = dark ? "Day" : "Night";
    themeToggle.setAttribute("aria-pressed", String(dark));
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {}
  }

  function initTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem(THEME_KEY);
    } catch {}
    const theme =
      saved === "dark" || saved === "light"
        ? saved
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    applyTheme(theme);
  }

  themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-bs-theme");
    applyTheme(current === "dark" ? "light" : "dark");
  });

  /* ---------- repeat rules ----------
   * The "Repeat" dropdown on the add-task form sets a PENDING rule that is
   * applied when the next task is created (see addTask). */

  const WD_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function currentRep() {
    return repeat.type === "none" ? null : { type: repeat.type, weekday: repeat.weekday };
  }

  function setRepeat(type, weekday) {
    repeat.type = type;
    repeat.weekday = type === "weekly" ? weekday : null;
    updateRepeatUI();
  }

  function updateRepeatUI() {
    let label = "Repeat";
    if (repeat.type === "daily") label = "Every day";
    else if (repeat.type === "weekly") label = "Every " + WD_FULL[repeat.weekday];
    else if (repeat.type === "monthly") label = "Every month";

    repeatLabel.textContent = label;
    repeatToggle.classList.toggle("btn-repeat-on", repeat.type !== "none");

    repeatMenu.querySelectorAll("[data-repeat]").forEach((b) =>
      b.classList.toggle("active", b.dataset.repeat === repeat.type)
    );
    repeatMenu.querySelectorAll("[data-weekday]").forEach((b) =>
      b.classList.toggle(
        "active",
        repeat.type === "weekly" && Number(b.dataset.weekday) === repeat.weekday
      )
    );

    if (repeat.type === "none") {
      repeatHint.classList.add("d-none");
      repeatHint.textContent = "";
    } else {
      repeatHint.classList.remove("d-none");
      if (repeat.type === "daily") {
        repeatHint.textContent = "Repeats once a day.";
      } else if (repeat.type === "weekly") {
        repeatHint.textContent = `Repeats every ${WD_FULL[repeat.weekday]}.`;
      } else {
        const day = dueDate.value ? fromKey(dueDate.value).getDate() : new Date().getDate();
        repeatHint.textContent = `Repeats on the ${ordinal(day)} of every month.`;
      }
    }
  }

  function repeatText(task) {
    if (task.repeat === "daily") return "Every day";
    if (task.repeat === "weekly")
      return "Every " + WD_FULL[task.weekday ?? fromKey(task.date || todayKey()).getDay()];
    if (task.repeat === "monthly")
      return "Every month" + (task.monthDay ? ` on the ${ordinal(task.monthDay)}` : "");
    return "";
  }

  repeatMenu.addEventListener("click", (e) => {
    const r = e.target.closest("[data-repeat]");
    if (r) {
      setRepeat(r.dataset.repeat, repeat.weekday);
      return;
    }
    const w = e.target.closest("[data-weekday]");
    if (w) {
      setRepeat("weekly", Number(w.dataset.weekday));
      bootstrap.Dropdown.getOrCreateInstance(repeatToggle).hide();
    }
  });

  dueDate.addEventListener("change", updateRepeatUI);

  /* ---------- quick-add suggestions ----------
   * Typing in the task input shows matching "game pack" suggestions below it.
   * Selecting one adds that game's scheduled activities from Gacha reminder.txt.
   * Daily/weekly tasks, reset-window activities, and patch schedules share one
   * pack definition so the calendar and task boxes stay in sync.
   * Suggestions match the display name OR any alias (e.g. "hsr"). */

  const GAME_PACKS = {
    "Genshin Impact": {
      aliases: ["genshin", "gi"],
      dailies: [
        "Spend energy and complete daily quests",
        "Expeditions",
        "Miliastra wonderland",
        "Collect serenitea pot currency",
      ],
      weeklies: ["Weekly boss"],
      schedules: [
        { activity: "Imaginarium Theater", type: "monthly", monthDay: 1, label: "Monthly" },
        { activity: "Spiral Abyss", type: "monthly", monthDay: 15, label: "Monthly" },
        { activity: "Stygian Onslaught", type: "patch", offsetDays: 7, label: "Each patch" },
      ],
      // Activities that award the premium currency (Gacha reminder.txt).
      premium: ["Spend energy and complete daily quests"],
    },
    "Honkai: Star Rail": {
      aliases: ["hsr"],
      dailies: ["Spend energy and complete daily quests", "Collect assignments"],
      weeklies: ["Simulated universe / Currency war", "Weekly boss"],
      schedules: [
        {
          activity: "Memory of chaos",
          type: "interval",
          intervalDays: 42,
          anchor: "2026-09-28",
          label: "Every 6 weeks",
        },
        {
          activity: "Pure fiction",
          type: "interval",
          intervalDays: 42,
          anchor: "2026-09-14",
          label: "Every 6 weeks",
        },
        {
          activity: "Apocalyptic shadow",
          type: "interval",
          intervalDays: 42,
          anchor: "2026-10-05",
          label: "Every 6 weeks",
        },
      ],
      premium: ["Spend energy and complete daily quests", "Simulated universe / Currency war"],
    },
    "Zenless Zone Zero": {
      aliases: ["zzz", "zenless"],
      dailies: [
        "Spend energy and complete daily quests",
        "Video-store revenue / Scratch card / Coffee",
      ],
      weeklies: ["Weekly boss", "Hollow zero / Enigmatic labyrinth"],
      schedules: [
        {
          activity: "Shiyu defense",
          type: "interval",
          intervalDays: 14,
          anchor: "2026-10-02",
          label: "Fortnightly",
        },
        {
          activity: "Deadly assault",
          type: "interval",
          intervalDays: 14,
          anchor: "2026-10-16",
          label: "Fortnightly",
        },
      ],
      premium: [
        "Spend energy and complete daily quests",
        "Video-store revenue / Scratch card / Coffee",
        "Hollow zero / Enigmatic labyrinth",
      ],
    },
    "Wuthering Waves": {
      aliases: ["ww"],
      dailies: ["Spend energy and complete daily quests"],
      weeklies: ["Weekly boss"],
      schedules: [
        {
          activity: "Tower of adversity",
          type: "interval",
          intervalDays: 14,
          anchor: "2026-09-14",
          label: "Fortnightly",
        },
        {
          activity: "Whimpering waste",
          type: "interval",
          intervalDays: 14,
          anchor: "2026-09-28",
          label: "Fortnightly",
        },
        { activity: "Endstate matrix", type: "patch", offsetDays: 7, label: "Each patch" },
      ],
      premium: ["Spend energy and complete daily quests"],
    },
    "Arknights: Endfield": {
      aliases: ["endfield"],
      dailies: [
        "Spend energy and complete daily quests",
        "Factory (buy stock and sell factory items)",
      ],
      weeklies: ["Weekly shops"],
      schedules: [
        { activity: "Echoes of war", type: "weekly", weekday: 4, label: "Weekly · Thursday" },
      ],
      premium: ["Spend energy and complete daily quests"],
    },
    "Neverness to Everness": {
      aliases: ["nte"],
      dailies: ["Spend energy and complete daily quests", "Collect cafe income"],
      weeklies: [
        "Weekly boss",
        "Property (Realm of greed, claim gift items)",
        "Auction items",
        "Complete city stamina for fons",
      ],
      schedules: [
        {
          activity: "Tycoon fund",
          type: "interval",
          intervalDays: 14,
          anchor: "2026-09-28",
          label: "Fortnightly",
        },
        {
          activity: "Beyond the rails",
          type: "interval",
          intervalDays: 14,
          anchor: "2026-10-08",
          label: "Fortnightly",
        },
      ],
      premium: ["Spend energy and complete daily quests"],
      // Activities that award the cosmetics currency (Fons) — Gacha reminder.txt.
      cosmetics: [
        "Collect cafe income",
        "Property (Realm of greed, claim gift items)",
        "Complete city stamina for fons",
        "Tycoon fund",
      ],
    },
    Arknights: {
      aliases: [],
      dailies: [
        "Spend energy and complete daily quests",
        "Collect base production",
        "Use recruitment permits",
      ],
      weeklies: ["Reach the Annihilation Orundum cap"],
      premium: ["Spend energy and complete daily quests", "Reach the Annihilation Orundum cap"],
    },
    "Girls' Frontline 2: Exilium": {
      aliases: ["gfl2"],
      dailies: [
        "Spend energy and complete daily quests",
        "Perform commission loop",
        "Crew deck",
      ],
      weeklies: ["Weekly boss", "Weekly shops"],
      premium: ["Spend energy and complete daily quests"],
    },
  };

  // Suggestions list, in the order shown in the dropdown.
  const SUGGEST_ORDER = Object.keys(GAME_PACKS);

  /* ---------- icons & live game metadata ----------
   * Icons and patch/character data live in gamedata.js (loaded before this
   * file). Missing file or fields degrade gracefully: unknown games fall back
   * to a controller glyph, missing <img> assets are hidden on error. Premium
   * activities (GAME_PACKS.premium) show the game's premium-currency icon. */

  const GAME_META_DATA = (typeof GAME_META !== "undefined" && GAME_META) || {};

  function metaOf(game) {
    return GAME_META_DATA[game] || {};
  }

  function assetImg(src, alt, cls) {
    const img = document.createElement("img");
    img.src = src;
    img.alt = alt;
    img.className = cls || "";
    img.loading = "lazy";
    return img;
  }

  // Game icon element, or a controller glyph fallback when the asset is absent.
  function gameIconEl(game, cls) {
    const meta = metaOf(game);
    const fallback = () => {
      const i = document.createElement("i");
      i.className = "bi bi-controller " + (cls || "");
      return i;
    };
    if (!meta.icon) return fallback();
    const img = assetImg(meta.icon, game, cls);
    img.addEventListener("error", () => img.replaceWith(fallback()));
    return img;
  }

  // Character portraits are optional metadata. A game icon keeps the layout
  // complete while a portrait is unavailable or fails to load.
  function characterPortraitEl(game, character, cls) {
    if (!character.portrait) return gameIconEl(game, `${cls} portrait-fallback`);
    const img = assetImg(character.portrait, character.name, cls);
    img.addEventListener("error", () => img.replaceWith(gameIconEl(game, `${cls} portrait-fallback`)));
    return img;
  }

  // Currency icon element for a game, or null when unknown. `key` selects the
  // entry in GAME_META (defaults to the premium "currency"; "cosmetics" selects
  // the secondary/cosmetics currency, e.g. NTE's Fons).
  function currencyIconEl(game, cls, key) {
    const cur = metaOf(game)[key || "currency"];
    if (!cur || !cur.icon) return null;
    const img = assetImg(cur.icon, cur.name || "currency", cls);
    if (cur.name) img.title = cur.name;
    img.addEventListener("error", () => img.remove());
    return img;
  }

  // Whether a game-pack activity awards the premium currency.
  function isPremiumActivity(game, activity) {
    const pack = GAME_PACKS[game];
    return !!(pack && pack.premium && pack.premium.includes(activity));
  }

  // Whether a game-pack activity awards the game's cosmetics currency (e.g. Fons).
  function isCosmeticsActivity(game, activity) {
    const pack = GAME_PACKS[game];
    return !!(pack && pack.cosmetics && pack.cosmetics.includes(activity));
  }

  function updateSuggestions() {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      hideSuggestions();
      return;
    }
    const matches = SUGGEST_ORDER.filter((name) => {
      const pack = GAME_PACKS[name];
      const aliasMatch = (pack.aliases || []).some((a) => a.toLowerCase().includes(q));
      return name.toLowerCase().includes(q) || aliasMatch;
    });
    if (!matches.length) {
      hideSuggestions();
      return;
    }
    suggestBox.innerHTML = "";
    matches.forEach((name) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "suggest-item";
      btn.textContent = name;
      btn.addEventListener("click", () => applyGamePack(name));
      suggestBox.appendChild(btn);
    });
    suggestBox.classList.remove("d-none");
  }

  function hideSuggestions() {
    suggestBox.classList.add("d-none");
    suggestBox.innerHTML = "";
  }

  function packActivityDefinitions(pack) {
    return [
      ...(pack.dailies || []).map((activity) => ({ activity, rule: { type: "daily" } })),
      ...(pack.weeklies || []).map((activity) => ({ activity, rule: { type: "weekly", weekday: 1 } })),
      ...(pack.schedules || []).map((rule) => ({ activity: rule.activity, rule, managed: true })),
    ];
  }

  // Patch schedules only have a usable end date when the next patch is known.
  function patchOccurrences(game, offsetDays) {
    const patches = (metaOf(game).patches || []).slice().sort();
    const out = [];
    for (let i = 0; i + 1 < patches.length; i++) {
      const start = addDaysKey(patches[i], offsetDays);
      const end = addDaysKey(patches[i + 1], -1);
      if (start <= end) out.push({ start, end });
    }
    return out;
  }

  function patchOccurrenceFor(game, offsetDays, key) {
    return patchOccurrences(game, offsetDays).find((occurrence) => occurrence.end >= key) || null;
  }

  function createGamePackTask(game, activity, rule, managed) {
    const tKey = todayKey();
    const task = {
      id: uid(),
      text: `${game} · ${activity}`,
      done: false,
      date: tKey,
      repeat: rule.type,
      weekday: null,
      monthDay: null,
      game,
      createdAt: Date.now(),
    };

    if (rule.type === "weekly") {
      task.weekday = rule.weekday ?? 1;
      task.date = weekStartKey(tKey, task.weekday);
    } else if (rule.type === "monthly") {
      task.monthDay = rule.monthDay;
      task.date = latestMonthlyStartKey(tKey, task.monthDay);
    } else if (rule.type === "interval") {
      task.intervalDays = rule.intervalDays;
      task.anchorDate = rule.anchor;
      task.date = latestIntervalStartKey(rule.anchor, rule.intervalDays, tKey);
    } else if (rule.type === "patch") {
      const occurrence = patchOccurrenceFor(game, rule.offsetDays || 0, tKey);
      if (!occurrence) return null;
      task.patchOffsetDays = rule.offsetDays || 0;
      task.date = occurrence.start;
      task.periodEnd = occurrence.end;
    }

    if (managed) {
      task.managedSchedule = true;
      task.scheduleLabel = rule.label;
    }
    return task;
  }

  function addMissingGamePackActivities(name) {
    const pack = GAME_PACKS[name];
    if (!pack) return 0;
    const existing = new Set(
      tasks.filter((task) => gameOf(task) === name).map((task) => activityLabel(task, name))
    );
    const added = [];
    packActivityDefinitions(pack).forEach(({ activity, rule, managed }) => {
      if (existing.has(activity)) return;
      const task = createGamePackTask(name, activity, rule, managed);
      if (!task) return;
      existing.add(activity);
      added.push(task);
    });
    if (added.length) tasks.unshift(...added);
    return added.length;
  }

  // Adds every missing activity in a game pack. This also avoids duplicate pack
  // tasks when a suggestion is selected a second time.
  function applyGamePack(name) {
    if (addMissingGamePackActivities(name)) {
      save();
      render();
    }
    hideSuggestions();
    input.value = "";
    input.focus();
  }

  /* ---------- game tasks ----------
   * Tasks added from a game pack are grouped into a per-game box. */

  // Resolves which game pack a task belongs to (stored `game`, or the
  // "<Game> · " text prefix for older / hand-entered tasks). Null if none.
  function gameOf(task) {
    if (task.game && GAME_PACKS[task.game]) return task.game;
    const i = task.text.indexOf(" · ");
    if (i > 0) {
      const name = task.text.slice(0, i);
      if (GAME_PACKS[name]) return name;
    }
    return null;
  }

  // Display text without the "<Game> · " prefix (the box header already shows it).
  function activityLabel(task, game) {
    const prefix = game + " · ";
    return task.text.startsWith(prefix) ? task.text.slice(prefix.length) : task.text;
  }

  function periodEndKey(task, start) {
    const occurrenceStart = start || task.date;
    if (!occurrenceStart) return null;
    if (task.repeat === "weekly") return addDaysKey(occurrenceStart, 6);
    if (task.repeat === "interval") return addDaysKey(occurrenceStart, (task.intervalDays || 14) - 1);
    if (task.repeat === "monthly" && task.managedSchedule) {
      return addDaysKey(nextOccurrenceKey(occurrenceStart, task), -1);
    }
    if (task.repeat === "patch") {
      const match = patchOccurrences(gameOf(task), task.patchOffsetDays || 0).find(
        (occurrence) => occurrence.start === occurrenceStart
      );
      return match ? match.end : task.periodEnd || null;
    }
    return occurrenceStart;
  }

  function occursDuringPeriod(task, key) {
    if (!task.date) return false;
    const end = periodEndKey(task);
    return task.date <= key && (!end || key <= end);
  }

  function expiryTooltip(task) {
    if (!task.repeat || task.repeat === "daily") return "";
    const end = periodEndKey(task);
    return end ? `Expires ${formatLong(end)}` : "";
  }

  // Scheduled monthly, interval, and patch tasks retain one current occurrence.
  // If a reset was missed, that occurrence is advanced instead of accumulating
  // overdue copies.
  function rollManagedSchedules() {
    const tKey = todayKey();
    let changed = false;
    tasks.forEach((task) => {
      if (!task.managedSchedule || !task.date) return;

      if (task.repeat === "patch") {
        if (task.date > tKey) return;
        const next = patchOccurrenceFor(gameOf(task), task.patchOffsetDays || 0, tKey);
        const hasChild = tasks.some((candidate) => candidate.spawnOf === task.id && !candidate.done);
        if (next && tKey >= next.start && next.start !== task.date && !hasChild) {
          task.date = next.start;
          task.periodEnd = next.end;
          task.done = false;
          delete task.spawnOf;
          changed = true;
        }
        return;
      }

      if (task.done || task.repeat === "weekly") return;
      let end = periodEndKey(task);
      while (end && tKey > end) {
        const next = nextOccurrenceKey(task.date, task);
        if (!next || next === task.date) break;
        task.date = next;
        end = periodEndKey(task);
        changed = true;
      }
    });
    if (changed) save();
  }

  // A single migration fills in new Gacha reminder.txt activities for game packs
  // already saved in this browser. Existing tasks are left untouched.
  function syncExistingGamePacks() {
    if (localStorage.getItem(GAME_PACK_SYNC_KEY)) return;
    const games = [...new Set(tasks.map(gameOf).filter(Boolean))];
    let changed = false;
    games.forEach((game) => {
      if (addMissingGamePackActivities(game)) changed = true;
    });
    localStorage.setItem(GAME_PACK_SYNC_KEY, "1");
    if (changed) save();
  }

  /* A weekly task is active from its selected weekday through the day before
   * that weekday recurs. It remains visible until checked off, then refreshes
   * for the next weekly period. */
  function rollWeeklyTasks() {
    const tKey = todayKey();
    let changed = false;
    tasks.forEach((t) => {
      if (t.repeat !== "weekly" || t.done || !t.date) return;
      const weekStart = weekStartKey(tKey, t.weekday ?? 1);
      if (t.spawnOf) {
        if (tKey > addDaysKey(t.date, 6)) {
          t.date = weekStart;
          changed = true;
        }
      } else if (t.date !== weekStart) {
        t.date = weekStart;
        changed = true;
      }
    });
    if (changed) save();
  }

  // One game box: header (name + done/total) and a checkbox list of activities.
  function buildGameBox(game, gameTasks) {
    const box = document.createElement("section");
    box.className = "game-box";

    const head = document.createElement("div");
    head.className = "game-box-head";
    const heading = document.createElement("span");
    heading.className = "game-box-heading";
    const title = document.createElement("span");
    title.className = "game-box-title";
    title.textContent = game;
    heading.append(gameIconEl(game, "game-icon"), title);
    const count = document.createElement("span");
    count.className = "game-box-count";
    count.textContent = `${gameTasks.filter((t) => t.done).length}/${gameTasks.length}`;
    head.append(heading, count);

    const ul = document.createElement("ul");
    ul.className = "game-box-list";
    gameTasks
      .slice()
      .sort((a, b) => (a.repeat === b.repeat ? 0 : a.repeat === "daily" ? -1 : 1))
      .forEach((t) => ul.appendChild(buildGameTask(t, game)));

    box.append(head, ul);
    return box;
  }

  function buildGameTask(task, game) {
    const li = document.createElement("li");
    li.className = "game-task" + (task.done ? " done" : "");
    li.dataset.id = task.id;

    const label = document.createElement("label");
    label.className = "game-check";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "game-check-input";
    cb.checked = task.done;
    cb.addEventListener("change", () => toggleTask(task.id));

    const mark = document.createElement("span");
    mark.className = "game-check-mark";
    mark.innerHTML = '<i class="bi bi-check-lg"></i>';

    const activity = activityLabel(task, game);
    const text = document.createElement("span");
    text.className = "game-task-text";
    text.textContent = activity;
    const expiry = expiryTooltip(task);
    if (expiry) {
      label.title = expiry;
      text.title = expiry;
    }

    label.append(cb, mark, text);

    // Currency-earning activities show the matching currency icon: the premium
    // currency, and/or the cosmetics currency (e.g. NTE Fons).
    if (isPremiumActivity(game, activity)) {
      const cur = currencyIconEl(game, "game-cur-icon", "currency");
      if (cur) label.appendChild(cur);
    }
    if (isCosmeticsActivity(game, activity)) {
      const cur = currencyIconEl(game, "game-cur-icon", "cosmetics");
      if (cur) label.appendChild(cur);
    }

    const tag = document.createElement("span");
    tag.className = "game-tag";
    tag.textContent = task.scheduleLabel || (task.repeat === "weekly" ? "Weekly" : "Daily");

    const del = document.createElement("button");
    del.type = "button";
    del.className = "task-delete";
    del.setAttribute("aria-label", "Delete task");
    del.innerHTML = '<i class="bi bi-x-lg"></i>';
    del.addEventListener("click", () => removeTask(task.id));

    li.append(label, tag, del);
    return li;
  }

  /* ---------- tasks ----------
   * Core task operations. Every mutation calls save() + render():
   * mutate `tasks`, persist, re-render. */

  // Creates a task (newest first). `rep` is the pending repeat rule (see above).
  // `game` links the task to a game pack (used to group it into a game box).
  function addTask(text, date, rep, game) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const task = {
      id: uid(),
      text: trimmed,
      done: false,
      date: date || null,
      repeat: null,
      weekday: null,
      monthDay: null,
      game: game || null,
      createdAt: Date.now(),
    };
    if (rep) {
      task.repeat = rep.type;
      if (rep.type === "weekly") {
        // A weekly task always represents the current Mon→Sun week: it is due by
        // the end of that week (Sunday), shown every day until checked off, then
        // refreshed the next Monday. See rollWeeklyTasks().
        task.weekday = rep.weekday;
        task.date = weekStartKey(task.date || todayKey(), rep.weekday);
      } else if (rep.type === "monthly") {
        if (!task.date) task.date = todayKey();
        task.monthDay = fromKey(task.date).getDate();
      } else if (rep.type === "daily" && !task.date) {
        task.date = todayKey();
      }
    }
    tasks.unshift(task);
    save();
    render();
  }

  /* Creates the next occurrence of a completed recurring task and links it back
   * via spawnOf. It's given the next date per the repeat rule and unshifted to
   * the top of the list; render() hides it from the main list until that day. */
  function spawnNext(task) {
    const tKey = todayKey();
    const keepsAnchor = task.managedSchedule && ["monthly", "interval", "patch"].includes(task.repeat);
    const ref = keepsAnchor ? task.date : task.date && task.date > tKey ? task.date : tKey;
    const nextKey = nextOccurrenceKey(ref, task);
    if (!nextKey) return;
    tasks.unshift({
      id: uid(),
      text: task.text,
      done: false,
      date: nextKey,
      repeat: task.repeat,
      weekday: task.weekday,
      monthDay: task.monthDay,
      game: gameOf(task),
      intervalDays: task.intervalDays,
      anchorDate: task.anchorDate,
      managedSchedule: task.managedSchedule,
      scheduleLabel: task.scheduleLabel,
      patchOffsetDays: task.patchOffsetDays,
      periodEnd: task.repeat === "patch" ? periodEndKey(task, nextKey) : undefined,
      spawnOf: task.id,
      createdAt: Date.now(),
    });
  }

  /* Complete / un-complete a task (see header for the completion rules).
   * Un-completing a recurring task removes its spawned next occurrence. */
  function toggleTask(id) {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;

    if (task.done) {
      setDone(task, false);
      return;
    }

    const tKey = todayKey();
    const future = task.date && task.date > tKey;

    if (future && task.repeat) {
      showDialog({
        title: "Not due yet",
        body: `"${task.text}" is a recurring task scheduled for ${formatLong(task.date)}. Recurring tasks can only be completed on the day itself.`,
        okLabel: "Got it",
        cancel: false,
      });
      return;
    }

    if (future) {
      showDialog({
        title: "Complete ahead of time?",
        body: `"${task.text}" is scheduled for ${formatLong(task.date)}. Mark it as completed now?`,
        okLabel: "Complete anyway",
      }).then((ok) => {
        if (ok) setDone(task, true);
      });
      return;
    }

    setDone(task, true);
  }

  function setDone(task, done) {
    if (task.repeat) {
      if (done) {
        task.done = true;
        spawnNext(task);
      } else {
        task.done = false;
        const child = tasks.find((t) => t.spawnOf === task.id && !t.done);
        if (child) tasks = tasks.filter((t) => t.id !== child.id);
      }
    } else {
      task.done = done;
    }
    save();
    render();
  }

  // Animates the row out before actually deleting (see finishRemove).
  function removeTask(id) {
    const els = document.querySelectorAll(`:is(.task-item, .game-task)[data-id="${id}"]`);
    if (!els.length) {
      finishRemove(id);
      return;
    }
    let pending = els.length;
    els.forEach((el) => {
      el.classList.add("removing");
      el.addEventListener(
        "transitionend",
        () => {
          if (--pending <= 0) finishRemove(id);
        },
        { once: true }
      );
    });
    setTimeout(() => finishRemove(id), 350);
  }

  function finishRemove(id) {
    if (!tasks.some((t) => t.id === id)) return;
    tasks = tasks.filter((t) => t.id !== id);
    save();
    render();
  }

  function clearCompleted() {
    tasks = tasks.filter((t) => !t.done);
    save();
    render();
  }

  function visibleTasks() {
    if (filter === "active") return tasks.filter((t) => !t.done);
    if (filter === "completed") return tasks.filter((t) => t.done);
    return tasks;
  }

  /* ---------- rendering ----------
   * buildTaskItem builds a full interactive row; buildProjectionItem builds a
   * read-only row used for future recurring occurrences shown in the calendar. */

  function buildTaskItem(task, compact, label) {
    const li = document.createElement("li");
    li.className = "task-item" + (task.done ? " done" : "") + (compact ? " compact" : "");
    li.dataset.id = task.id;

    const check = document.createElement("button");
    check.type = "button";
    check.className = "task-check" + (task.done ? " checked" : "");
    check.setAttribute("aria-label", task.done ? "Mark as active" : "Mark as completed");
    check.innerHTML = '<i class="bi bi-check-lg"></i>';
    check.addEventListener("click", () => toggleTask(task.id));

    const body = document.createElement("div");
    body.className = "task-body";

    const text = document.createElement("span");
    text.className = "task-text";
    text.textContent = label || task.text;
    text.setAttribute("role", "button");
    text.tabIndex = 0;
    const expiry = expiryTooltip(task);
    text.title = expiry ? `${expiry} · Click to toggle` : "Click to toggle";
    text.addEventListener("click", () => toggleTask(task.id));
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleTask(task.id);
      }
    });
    body.appendChild(text);

    const metaWrap = document.createElement("div");
    metaWrap.className = "task-meta";

    if (task.date) {
      const weekly = task.repeat === "weekly";
      // A weekly is due by the end of its Mon→Sun week (Sunday).
      const dueKey = weekly ? addDaysKey(task.date, 6) : task.date;
      const isToday = dueKey === todayKey();
      const overdue = !task.done && !weekly && dueKey < todayKey();
      const chip = document.createElement("span");
      chip.className = "task-date" + (overdue ? " overdue" : isToday ? " today" : "");
      chip.innerHTML = '<i class="bi bi-calendar3"></i> ';
      chip.appendChild(
        document.createTextNode(
          overdue
            ? `Overdue · ${formatShort(dueKey)}`
            : weekly
              ? `Due by ${formatShort(dueKey)}`
              : formatShort(dueKey)
        )
      );
      metaWrap.appendChild(chip);
    }

    if (task.repeat) {
      const chip = document.createElement("span");
      chip.className = "task-repeat";
      chip.innerHTML = '<i class="bi bi-arrow-repeat"></i> ';
      chip.appendChild(document.createTextNode(repeatText(task)));
      metaWrap.appendChild(chip);
    }

    if (metaWrap.children.length) body.appendChild(metaWrap);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "task-delete";
    del.setAttribute("aria-label", "Delete task");
    del.innerHTML = '<i class="bi bi-x-lg"></i>';
    del.addEventListener("click", () => removeTask(task.id));

    li.append(check, body, del);
    return li;
  }

  function buildProjectionItem(task, label) {
    const li = document.createElement("li");
    li.className = "task-item compact projected";
    li.title = expiryTooltip(task);

    const mark = document.createElement("span");
    mark.className = "task-check projected-mark";
    mark.innerHTML = '<i class="bi bi-arrow-repeat"></i>';

    const body = document.createElement("div");
    body.className = "task-body";

    const text = document.createElement("span");
    text.className = "task-text";
    text.textContent = label || task.text;

    const meta = document.createElement("div");
    meta.className = "task-meta";
    const chip = document.createElement("span");
    chip.className = "task-repeat";
    chip.innerHTML = '<i class="bi bi-arrow-repeat"></i> ';
    chip.appendChild(document.createTextNode(repeatText(task)));
    meta.appendChild(chip);

    body.append(text, meta);
    li.append(mark, body);
    return li;
  }

  /* Calendar day list: folds every activity of one game into a single row that
   * expands on click, so a busy day stays tidy. Open/closed state is kept in
   * expandedCalGames (keyed by day + game) so it survives re-renders. */
  function buildCalGameGroup(game, items) {
    const wrap = document.createElement("li");
    wrap.className = "cal-game";

    const key = `${selectedKey}::${game}`;
    const open = expandedCalGames.has(key);

    const head = document.createElement("button");
    head.type = "button";
    head.className = "cal-game-head" + (open ? " is-open" : "");
    head.setAttribute("aria-expanded", String(open));

    const icon = gameIconEl(game, "cal-game-icon");
    const name = document.createElement("span");
    name.className = "cal-game-name";
    name.textContent = game;
    const count = document.createElement("span");
    count.className = "cal-game-count";
    count.textContent = items.length;
    const chevron = document.createElement("i");
    chevron.className = "bi bi-chevron-down cal-game-chevron";
    head.append(icon, name, count, chevron);

    const body = document.createElement("ul");
    body.className = "cal-game-body" + (open ? "" : " d-none");
    items.forEach(({ task, projected }) =>
      body.appendChild(
        projected
          ? buildProjectionItem(task, activityLabel(task, game))
          : buildTaskItem(task, true, activityLabel(task, game))
      )
    );

    head.addEventListener("click", () => {
      const nowOpen = !body.classList.toggle("d-none");
      if (nowOpen) expandedCalGames.add(key);
      else expandedCalGames.delete(key);
      head.classList.toggle("is-open", nowOpen);
      head.setAttribute("aria-expanded", String(nowOpen));
    });

    wrap.append(head, body);
    return wrap;
  }

  /* ---------- patch events & character releases (from gamedata.js) ----------
   * These are NOT tasks: they come from GAME_META and are read-only overlays
   * shown in the calendar and the Reminders tab. */

  // Recurring patch-based activities for a game, expanded to date spans:
  // [{ name, start, end, category }]. "1 week after each patch" uses
  // startOffsetDays:7; endsAtNextPatch runs the event until the next patch.
  function gamePatchEvents(game) {
    const meta = metaOf(game);
    const patches = meta.patches || [];
    const out = [];
    patches.forEach((p, i) => {
      (meta.patchEvents || []).forEach((pe) => {
        const start = addDaysKey(p, pe.startOffsetDays || 0);
        const end =
          pe.endsAtNextPatch && patches[i + 1]
            ? addDaysKey(patches[i + 1], -1)
            : addDaysKey(start, (pe.durationDays || (pe.endsAtNextPatch ? 42 : 1)) - 1);
        out.push({ name: pe.name, start, end, category: "End-game content" });
      });
    });
    return out;
  }

  // Character releases for a game, sorted by date.
  function gameCharacters(game) {
    return (metaOf(game).characters || [])
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  // Per-day event/character maps for the visible month.
  function monthMeta(monthStart, monthEnd) {
    const events = {};
    const chars = {};
    Object.keys(GAME_META_DATA).forEach((game) => {
      gamePatchEvents(game).forEach((e) => {
        if (e.end < monthStart || e.start > monthEnd) return;
        let day = e.start < monthStart ? monthStart : e.start;
        for (let guard = 0; guard < 400 && day <= e.end && day <= monthEnd; guard++) {
          (events[day] = events[day] || []).push({
            type: "event",
            game,
            name: e.name,
            date: e.start,
            end: e.end,
            category: e.category,
          });
          day = addDaysKey(day, 1);
        }
      });
      gameCharacters(game).forEach((c) => {
        if (c.date < monthStart || c.date > monthEnd) return;
        (chars[c.date] = chars[c.date] || []).push({
          type: "character",
          game,
          name: c.name,
          date: c.date,
          portrait: c.portrait,
          note: c.note,
        });
      });
    });
    return { events, chars };
  }

  // Read-only calendar row for a character release / patch event.
  function buildCalEventRow(ev) {
    const li = document.createElement("li");
    li.className = "cal-event " + (ev.type === "character" ? "cal-event-char" : "cal-event-patch");

    const badge = document.createElement("span");
    badge.className = "cal-event-badge";
    badge.append(
      ev.type === "character"
        ? characterPortraitEl(ev.game, ev, "character-portrait cal-character-portrait")
        : gameIconEl(ev.game, "cal-event-game")
    );

    const body = document.createElement("div");
    body.className = "cal-event-body";

    const title = document.createElement("span");
    title.className = "cal-event-title";
    title.textContent = ev.name;

    const meta = document.createElement("span");
    meta.className = "cal-event-meta";
    meta.textContent =
      (ev.type === "character" ? "New character · " : "End-game · ") +
      ev.game +
      (ev.note ? " · " + ev.note : "") +
      (ev.type === "event" && ev.end && ev.end !== ev.date
        ? ` · ${formatShort(ev.date)}–${formatShort(ev.end)}`
        : "");

    body.append(title, meta);
    li.append(badge, body);
    return li;
  }

  /* Full re-render of the whole UI. Game-pack tasks are grouped into per-game
   * boxes (top); every other task is split into Recurring (left) and One-time
   * (right). Future recurring occurrences are excluded from the lists both to
   * reduce clutter and so a task completed for today doesn't keep showing as
   * active — the calendar is where they stay visible until the day arrives. */
  function render() {
    rollWeeklyTasks();
    rollManagedSchedules();
    const tKey = todayKey();
    const visible = visibleTasks();

    // Game-pack tasks: only the current occurrence of a completed recurring
    // task stays visible (today's dailies, this week's weeklies); future ones
    // are hidden until their day.
    const gameTasks = visible.filter((t) => {
      if (!gameOf(t)) return false;
      if (t.done) {
        if (!t.date) return true;
        if (t.repeat) return occursDuringPeriod(t, tKey);
        return true;
      }
      if (t.managedSchedule) return occursDuringPeriod(t, tKey);
      return !(t.repeat && t.date && t.date > tKey);
    });

    const shown = visible
      .filter((t) => !gameOf(t))
      .filter((t) => !(t.repeat && t.date && t.date > tKey));

    const recurring = shown.filter((t) => t.repeat);
    const oneshot = shown.filter((t) => !t.repeat);

    // Per-game boxes (in pack order).
    gameBoxes.innerHTML = "";
    const games = [...new Set(gameTasks.map((t) => gameOf(t)))];
    games.sort((a, b) => SUGGEST_ORDER.indexOf(a) - SUGGEST_ORDER.indexOf(b));
    games.forEach((g) =>
      gameBoxes.appendChild(buildGameBox(g, gameTasks.filter((t) => gameOf(t) === g)))
    );
    gameBoxes.classList.toggle("d-none", games.length === 0);

    recurringList.innerHTML = "";
    oneshotList.innerHTML = "";
    recurringCount.textContent = recurring.length;
    oneshotCount.textContent = oneshot.length;
    recurringColumn.classList.toggle("d-none", recurring.length === 0);
    oneshotColumn.classList.toggle("d-none", oneshot.length === 0);
    list.classList.toggle("single", recurring.length === 0 || oneshot.length === 0);

    recurring.forEach((task) => recurringList.appendChild(buildTaskItem(task, false)));
    oneshot.forEach((task) => oneshotList.appendChild(buildTaskItem(task, false)));

    const showEmpty = shown.length === 0 && gameTasks.length === 0;
    emptyState.classList.toggle("d-none", !showEmpty);
    list.classList.toggle("d-none", showEmpty);

    if (showEmpty) {
      const hiddenRecurring = visible.filter((t) => t.repeat && t.date && t.date > tKey).length;
      if (filter === "active") {
        emptyTitle.textContent = "Nothing active";
        emptyMsg.textContent = "No active tasks. Nice work!";
      } else if (filter === "completed") {
        emptyTitle.textContent = "Nothing completed";
        emptyMsg.textContent = "Check off a task to see it here.";
      } else {
        emptyTitle.textContent = "All clear";
        emptyMsg.textContent = hiddenRecurring
          ? "Recurring tasks will appear on their scheduled day."
          : "Add a task above to get started.";
      }
    }

    const tracked = tasks.filter((t) => {
      if (t.repeat && t.date && t.date > tKey) return false;
      return !t.managedSchedule || occursDuringPeriod(t, tKey);
    });
    const remaining = tracked.filter((t) => !t.done).length;
    counter.textContent = `${remaining} task${remaining === 1 ? "" : "s"} left`;

    const done = tracked.length - remaining;
    const pct = tracked.length ? Math.round((done / tracked.length) * 100) : 0;
    progressLabel.textContent = `${pct}% done`;
    clearBtn.disabled = done === 0;
    clearBtn.classList.toggle("disabled", done === 0);

    renderCalendar();
    if (view === "reminders") renderReminders();
  }

  /* ---------- calendar ----------
   * Shows only ACTIVE tasks. Pass 1 counts non-recurring tasks on their exact
   * date. Pass 2 "projects" each active recurring task forward across the month
   * (via nextOccurrenceKey) so upcoming days get dots too. A weekly spans its
   * whole Monday→Sunday week (every day of that week is marked). */

  // Whether an active task "occurs" on a given day. Weeklies cover their whole
  // Mon→Sun week, so they show (and can be checked off) any day that week.
  function occursOn(task, key) {
    if (!task.date) return false;
    if (task.repeat === "weekly" || task.managedSchedule) return occursDuringPeriod(task, key);
    return task.date === key;
  }

  function renderCalendar() {
    calTitle.textContent = new Date(calYear, calMonth, 1).toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });

    const counts = {};
    const onDate = {};
    const monthStart = toKey(new Date(calYear, calMonth, 1));
    const monthEnd = toKey(new Date(calYear, calMonth + 1, 0));

    // Patch events / character releases overlaid from gamedata.js.
    const metaMaps = monthMeta(monthStart, monthEnd);
    const dayEvents = metaMaps.events;
    const dayChars = metaMaps.chars;

    const bump = (key) => {
      counts[key] = (counts[key] || 0) + 1;
      onDate[key] = onDate[key] || [];
    };

    tasks.forEach((t) => {
      if (!t.date || t.done || t.repeat) return;
      bump(t.date);
      onDate[t.date].push(t);
    });

    tasks.forEach((t) => {
      if (!t.repeat || t.done || !t.date) return;
      let cursor = t.date;
      for (let i = 0; i < 4000; i++) {
        if (!cursor || cursor > monthEnd) break;
        const periodEnd = periodEndKey(t, cursor);
        if (t.repeat === "weekly" || (t.managedSchedule && periodEnd && periodEnd !== cursor)) {
          // Weekly and reset-window activities stay active through their next reset.
          for (let day = cursor; day <= periodEnd; day = addDaysKey(day, 1)) {
            if (day < monthStart) continue;
            if (day > monthEnd) break;
            bump(day);
            onDate[day].push(t);
          }
        } else if (cursor >= monthStart) {
          bump(cursor);
          onDate[cursor].push(t);
        }
        const next = nextOccurrenceKey(cursor, t);
        if (!next || next === cursor) break;
        cursor = next;
      }
    });

    calDays.innerHTML = "";
    const firstDow = new Date(calYear, calMonth, 1).getDay();
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const tKey = todayKey();

    for (let i = 0; i < firstDow; i++) {
      const blank = document.createElement("div");
      blank.className = "cal-blank";
      calDays.appendChild(blank);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const key = toKey(new Date(calYear, calMonth, d));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cal-day";
      btn.innerHTML =
        `<span>${d}</span>` +
        `<span class="cal-dots">` +
        `<span class="cal-dot dot-task"></span>` +
        `<span class="cal-dot dot-event"></span>` +
        `<span class="cal-dot dot-char"></span>` +
        `</span>`;
      btn.setAttribute("aria-label", formatLong(key));
      if (key === tKey) btn.classList.add("is-today");
      if (key === selectedKey) btn.classList.add("is-selected");

      const evs = dayEvents[key] || [];
      const chs = dayChars[key] || [];
      const parts = [];
      if (counts[key]) parts.push(`${counts[key]} task${counts[key] === 1 ? "" : "s"}`);
      if (evs.length) parts.push(evs[0].name);
      if (chs.length) parts.push(`${chs.length} new character${chs.length === 1 ? "" : "s"}`);
      if (counts[key]) btn.classList.add("has-tasks");
      if (evs.length) btn.classList.add("has-events");
      if (chs.length) btn.classList.add("has-characters");
      if (parts.length) btn.title = parts.join(" · ");

      btn.addEventListener("click", () => {
        selectedKey = key;
        renderCalendar();
      });
      calDays.appendChild(btn);
    }

    calSelectedLabel.textContent = formatLong(selectedKey);
    // Character releases + patch events for the selected day (pinned at top),
    // then active tasks that occur that day (a weekly covers its whole week)
    // plus read-only projections for future recurrences.
    const selChars = dayChars[selectedKey] || [];
    const selEvents = dayEvents[selectedKey] || [];
    const dayTasks = tasks.filter((t) => !t.done && occursOn(t, selectedKey));
    const projected = (onDate[selectedKey] || []).filter(
      (t) => t.repeat && !dayTasks.some((s) => s.id === t.id)
    );
    const taskCount = dayTasks.length + projected.length;
    const metaCount = selChars.length + selEvents.length;
    const totalForDay = taskCount + metaCount;

    calSelectedCount.textContent = !totalForDay
      ? "No tasks"
      : !taskCount
        ? `${metaCount} upcoming`
        : `${totalForDay} item${totalForDay === 1 ? "" : "s"}`;

    calTaskList.innerHTML = "";
    if (!totalForDay) {
      const p = document.createElement("li");
      p.className = "small text-body-secondary py-2 mb-0";
      p.textContent = "Nothing scheduled for this day.";
      calTaskList.appendChild(p);
    } else {
      // Character releases first (top of the list), then patch events.
      selChars.forEach((c) => calTaskList.appendChild(buildCalEventRow(c)));
      selEvents.forEach((e) => calTaskList.appendChild(buildCalEventRow(e)));

      // Non-game tasks stay as individual rows; every game's activities for the
      // day are folded into one expandable row.
      const items = [
        ...dayTasks.map((task) => ({ task, projected: false })),
        ...projected.map((task) => ({ task, projected: true })),
      ];

      items
        .filter((it) => !gameOf(it.task))
        .forEach(({ task, projected }) =>
          calTaskList.appendChild(projected ? buildProjectionItem(task) : buildTaskItem(task, true))
        );

      const byGame = new Map();
      items.forEach((it) => {
        const g = gameOf(it.task);
        if (!g) return;
        if (!byGame.has(g)) byGame.set(g, []);
        byGame.get(g).push(it);
      });
      [...byGame.keys()]
        .sort((a, b) => SUGGEST_ORDER.indexOf(a) - SUGGEST_ORDER.indexOf(b))
        .forEach((g) => calTaskList.appendChild(buildCalGameGroup(g, byGame.get(g))));
    }
  }

  // Subtract one and bump to previous month (handles January -> December).
  calPrev.addEventListener("click", () => {
    calMonth--;
    if (calMonth < 0) {
      calMonth = 11;
      calYear--;
    }
    renderCalendar();
  });

  calNext.addEventListener("click", () => {
    calMonth++;
    if (calMonth > 11) {
      calMonth = 0;
      calYear++;
    }
    renderCalendar();
  });

  calToday.addEventListener("click", () => {
    const d = new Date();
    calYear = d.getFullYear();
    calMonth = d.getMonth();
    selectedKey = toKey(d);
    renderCalendar();
  });

  calForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!calInput.value.trim()) return;
    addTask(calInput.value, selectedKey, currentRep());
    calInput.value = "";
    calInput.focus();
    setRepeat("none");
  });

  /* ---------- reminders view ----------
   * Left-card tab for independently checkable character banners. Current banners
   * remain visible until the next dated banner for that game; completed entries
   * are retained in their own section. */

  function showView(next) {
    view = next;
    viewTabs.querySelectorAll("[data-view]").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === next)
    );
    const isTasks = next === "tasks";
    tasksView.classList.toggle("d-none", !isTasks);
    taskFooter.classList.toggle("d-none", !isTasks);
    remindersView.classList.toggle("d-none", isTasks);
    if (!isTasks) renderReminders();
  }

  function characterReminderKey(game, character) {
    return JSON.stringify([game, character.date, character.name]);
  }

  function characterEndKey(game, character) {
    const next = gameCharacters(game).find((candidate) => candidate.date > character.date);
    return next ? addDaysKey(next.date, -1) : null;
  }

  function appendCharacterGroups(entries, completed) {
    entries.forEach(({ game, character, end }) => {
      const groupKey = `${game}-${completed}`;
      let group = [...remindersView.querySelectorAll(".reminder-group")].find(
        (candidate) => candidate.dataset.reminderGroup === groupKey
      );
      if (!group) {
        group = document.createElement("section");
        group.className = "reminder-group";
        group.dataset.reminderGroup = groupKey;

        const ghead = document.createElement("h2");
        ghead.className = "reminder-group-head";
        ghead.append(gameIconEl(game, "reminder-game-icon"));
        const gname = document.createElement("span");
        gname.textContent = game;
        ghead.appendChild(gname);
        group.appendChild(ghead);

        const ul = document.createElement("ul");
        ul.className = "list-unstyled mb-0";
        group.appendChild(ul);
        remindersView.appendChild(group);
      }

      const li = document.createElement("li");
      li.className = "reminder-item is-char" + (completed ? " is-done" : "");

      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "reminder-check";
      check.checked = completed;
      check.setAttribute("aria-label", `Mark ${character.name} reminder as ${completed ? "active" : "completed"}`);
      check.addEventListener("change", () => {
        const key = characterReminderKey(game, character);
        if (check.checked) completedCharacters[key] = Date.now();
        else delete completedCharacters[key];
        saveCompletedCharacters();
        renderReminders();
      });

      const portrait = characterPortraitEl(
        game,
        character,
        "character-portrait reminder-character-portrait"
      );

      const body = document.createElement("div");
      body.className = "reminder-body";
      const title = document.createElement("span");
      title.className = "reminder-title";
      title.textContent = character.name;
      const meta = document.createElement("span");
      meta.className = "reminder-meta";
      meta.textContent = completed
        ? `Completed · released ${formatShort(character.date)}`
        : character.date > todayKey()
          ? `Starts ${formatShort(character.date)}`
          : end
            ? `Active through ${formatShort(end)}`
            : `Active since ${formatShort(character.date)}`;
      body.append(title, meta);
      li.append(check, portrait, body);
      group.querySelector("ul").appendChild(li);
    });
  }

  function renderReminders() {
    remindersView.innerHTML = "";
    const tKey = todayKey();
    const active = [];
    const completed = [];

    SUGGEST_ORDER.forEach((game) => {
      gameCharacters(game).forEach((character) => {
        const entry = { game, character, end: characterEndKey(game, character) };
        if (completedCharacters[characterReminderKey(game, character)]) completed.push(entry);
        else if (character.date >= tKey || !entry.end || tKey <= entry.end) active.push(entry);
      });
    });

    const head = document.createElement("div");
    head.className = "reminders-head";
    head.innerHTML = '<i class="bi bi-person-hearts"></i><span>Character reminders</span>';
    remindersView.appendChild(head);

    if (active.length) {
      appendCharacterGroups(active, false);
    } else {
      const p = document.createElement("p");
      p.className = "small text-body-secondary mb-0";
      p.textContent = "No active or upcoming character banners on record.";
      remindersView.appendChild(p);
    }

    if (completed.length) {
      const doneHead = document.createElement("h2");
      doneHead.className = "reminders-completed-head";
      doneHead.textContent = "Completed";
      remindersView.appendChild(doneHead);
      appendCharacterGroups(completed, true);
    }
  }

  viewTabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view]");
    if (btn) showView(btn.dataset.view);
  });

  /* ---------- events ---------- */

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    addTask(input.value, dueDate.value || null, currentRep());
    input.value = "";
    input.focus();
    dueDate.value = "";
    setRepeat("none");
    hideSuggestions();
  });

  input.addEventListener("input", updateSuggestions);

  // Clicking outside the suggestion area closes it.
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#suggestWrap")) hideSuggestions();
  });

  clearDue.addEventListener("click", () => {
    dueDate.value = "";
    dueDate.focus();
  });

  duePick.addEventListener("click", () => openDatePicker(dueDate));

  /* Open the native date picker for the due-date field. showPicker() needs a
   * user gesture and isn't universally supported, hence the fallback. */
  function openDatePicker(el) {
    if (typeof el.showPicker === "function") {
      try {
        el.showPicker();
        return;
      } catch {}
    }
    el.focus();
  }

  filters.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-filter]");
    if (!btn) return;
    filter = btn.dataset.filter;
    filters.querySelectorAll(".nav-link").forEach((l) => l.classList.remove("active"));
    btn.classList.add("active");
    render();
  });

  clearBtn.addEventListener("click", clearCompleted);

  // Wipe every task from the list + localStorage (confirm first).
  clearAll.addEventListener("click", () => {
    showDialog({
      title: "Clear all tasks?",
      body: "This permanently deletes every task (including recurring history) from this browser. This cannot be undone.",
      okLabel: "Delete all",
    }).then((ok) => {
      if (!ok) return;
      tasks = [];
      save();
      render();
      hideSuggestions();
    });
  });

  dateLine.textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  // ---- boot ----
  initTheme();
  syncExistingGamePacks();
  updateRepeatUI();
  render();
})();
