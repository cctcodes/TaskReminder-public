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
 *   Tasks and progress are persisted in versioned localStorage keys.
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

  // localStorage keys. V3 intentionally starts clean: the app was not yet in
  // active use, and the new occurrence history cannot be reconstructed from the
  // old mutable task records.
  const STORAGE_VERSION = "3";
  const STORAGE_VERSION_KEY = "task-reminder.schema";
  const STORAGE_KEY = "task-reminder.v3.tasks";
  const SELECTED_GAMES_KEY = "task-reminder.v3.selected-games";
  const PROGRESS_HISTORY_KEY = "task-reminder.v3.progress-history";
  const PROGRESS_RANGE_KEY = "task-reminder.v3.progress-range";
  const CHARACTER_DONE_KEY = "task-reminder.v3.character-reminders";
  const TODAY_REMINDER_DISMISSED_KEY = "task-reminder.v3.dismissed-today-reminders";
  const THEME_KEY = "elegant-todo.theme";
  let storageAvailable = true;

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
  const todayReminders = document.getElementById("todayReminders");
  const clearAll = document.getElementById("clearAll");
  const dateLine = document.getElementById("dateLine");
  const localStatus = document.getElementById("localStatus");
  const progressTabs = document.getElementById("progressTabs");
  const progressRangeLabel = document.getElementById("progressRangeLabel");
  const progressVisual = document.getElementById("progressVisual");
  const progressBreakdown = document.getElementById("progressBreakdown");

  const viewTabs = document.getElementById("viewTabs");
  const tasksView = document.getElementById("tasksView");
  const remindersView = document.getElementById("remindersView");
  const taskFooter = document.getElementById("taskFooter");

  const themeToggle = document.getElementById("themeToggle");
  const themeIcon = document.getElementById("themeIcon");
  const themeLabel = document.getElementById("themeLabel");

  const settingsToggle = document.getElementById("settingsToggle");
  const settingsPanel = document.getElementById("settingsPanel");
  const settingsClose = document.getElementById("settingsClose");
  const exportDataText = document.getElementById("exportDataText");
  const downloadData = document.getElementById("downloadData");
  const copyData = document.getElementById("copyData");
  const importDataFile = document.getElementById("importDataFile");
  const importDataText = document.getElementById("importDataText");
  const importData = document.getElementById("importData");
  const dataTransferStatus = document.getElementById("dataTransferStatus");

  const calTitle = document.getElementById("calTitle");
  const calDays = document.getElementById("calDays");
  const calPrev = document.getElementById("calPrev");
  const calNext = document.getElementById("calNext");
  const calToday = document.getElementById("calToday");
  const calDateJump = document.getElementById("calDateJump");
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
  prepareStorage();
  let tasks = load();
  let completedCharacters = loadCompletedCharacters();
  let dismissedTodayReminders = loadDismissedTodayReminders();
  let selectedGames = loadSelectedGames();
  let progressHistory = loadProgressHistory();
  let progressRange = loadProgressRange();
  let filter = "active"; // "all" | "active" | "completed"
  let repeat = { type: "none", weekday: null }; // pending repeat rule for the next added task
  let view = "tasks"; // left-card view: "tasks" | "reminders"
  let reminderRange = "upcoming"; // "upcoming" | "current"
  let suppressSuggestionOpen = false;

  // Calendar state (defaults to the current month/day)
  const now = new Date();
  let calYear = now.getFullYear();
  let calMonth = now.getMonth();
  let selectedKey = toKey(now);
  // Calendar game groups open by default. User-collapsed groups remain closed
  // across re-renders for the selected date.
  const collapsedCalGames = new Set();

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

  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      reportStorageFailure();
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      reportStorageFailure();
      return false;
    }
  }

  function storageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      reportStorageFailure();
    }
  }

  function reportStorageFailure() {
    if (!storageAvailable) return;
    storageAvailable = false;
    localStatus.classList.add("storage-failed");
    localStatus.innerHTML = '<i class="bi bi-exclamation-triangle"></i> Changes cannot be saved';
  }

  function prepareStorage() {
    if (storageGet(STORAGE_VERSION_KEY) === STORAGE_VERSION) return;
    [
      "elegant-todo.tasks",
      "elegant-todo.character-reminders",
      "elegant-todo.game-pack-sync.v2",
      STORAGE_KEY,
      SELECTED_GAMES_KEY,
      PROGRESS_HISTORY_KEY,
      PROGRESS_RANGE_KEY,
      CHARACTER_DONE_KEY,
      TODAY_REMINDER_DISMISSED_KEY,
    ].forEach(storageRemove);
    storageSet(STORAGE_VERSION_KEY, STORAGE_VERSION);
  }

  function load() {
    try {
      const raw = storageGet(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.map((t) => ({
        date: null,
        repeat: null,
        weekday: null,
        monthDay: null,
        game: null,
        seriesId: t.id || uid(),
        ...t,
      }));
    } catch {
      return [];
    }
  }

  function save() {
    storageSet(STORAGE_KEY, JSON.stringify(tasks));
  }

  function loadCompletedCharacters() {
    try {
      const raw = storageGet(CHARACTER_DONE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveCompletedCharacters() {
    storageSet(CHARACTER_DONE_KEY, JSON.stringify(completedCharacters));
  }

  function loadDismissedTodayReminders() {
    try {
      const parsed = JSON.parse(storageGet(TODAY_REMINDER_DISMISSED_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveDismissedTodayReminders() {
    storageSet(TODAY_REMINDER_DISMISSED_KEY, JSON.stringify(dismissedTodayReminders));
  }

  function loadSelectedGames() {
    try {
      const parsed = JSON.parse(storageGet(SELECTED_GAMES_KEY) || "[]");
      return new Set(Array.isArray(parsed) ? parsed.filter((game) => typeof game === "string") : []);
    } catch {
      return new Set();
    }
  }

  function saveSelectedGames() {
    storageSet(SELECTED_GAMES_KEY, JSON.stringify([...selectedGames]));
  }

  function loadProgressHistory() {
    try {
      const parsed = JSON.parse(storageGet(PROGRESS_HISTORY_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveProgressHistory() {
    storageSet(PROGRESS_HISTORY_KEY, JSON.stringify(progressHistory));
  }

  function loadProgressRange() {
    const saved = storageGet(PROGRESS_RANGE_KEY);
    return ["day", "week", "month"].includes(saved) ? saved : "day";
  }

  const EXPORT_APP = "task-reminder";
  const MAX_IMPORT_SIZE = 10 * 1024 * 1024;
  const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const isRecordArray = (value) => Array.isArray(value) && value.every(isRecord);
  const EXPORT_FIELDS = [
    { key: STORAGE_VERSION_KEY, fallback: STORAGE_VERSION, valid: (value) => value === STORAGE_VERSION },
    { key: STORAGE_KEY, fallback: [], valid: isRecordArray },
    {
      key: SELECTED_GAMES_KEY,
      fallback: [],
      valid: (value) => Array.isArray(value) && value.every((game) => typeof game === "string"),
    },
    { key: PROGRESS_HISTORY_KEY, fallback: [], valid: isRecordArray },
    {
      key: PROGRESS_RANGE_KEY,
      fallback: "day",
      valid: (value) => ["day", "week", "month"].includes(value),
    },
    { key: CHARACTER_DONE_KEY, fallback: {}, valid: isRecord },
    { key: TODAY_REMINDER_DISMISSED_KEY, fallback: {}, valid: isRecord },
    {
      key: THEME_KEY,
      fallback: "light",
      valid: (value) => value === "light" || value === "dark",
    },
  ];

  function exportFieldValue({ key, fallback, valid }) {
    const raw = storageGet(key);
    if (raw === null) return fallback;
    if ([STORAGE_VERSION_KEY, PROGRESS_RANGE_KEY, THEME_KEY].includes(key)) {
      return valid(raw) ? raw : fallback;
    }
    try {
      const parsed = JSON.parse(raw);
      return valid(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function buildExportText() {
    const data = {};
    EXPORT_FIELDS.forEach((field) => {
      data[field.key] = exportFieldValue(field);
    });
    return JSON.stringify(
      {
        app: EXPORT_APP,
        schema: STORAGE_VERSION,
        exportedAt: new Date().toISOString(),
        data,
      },
      null,
      2
    );
  }

  function setTransferStatus(message, type = "") {
    dataTransferStatus.textContent = message;
    dataTransferStatus.className = `data-transfer-status${type ? ` is-${type}` : ""}`;
  }

  function refreshExportText() {
    exportDataText.value = buildExportText();
  }

  function parseImportText(text) {
    if (!text.trim()) throw new Error("Paste backup text or choose a backup file first.");
    if (text.length > MAX_IMPORT_SIZE) throw new Error("This backup is too large to import.");

    let bundle;
    try {
      bundle = JSON.parse(text);
    } catch {
      throw new Error("This is not valid JSON backup text.");
    }

    if (!isRecord(bundle)) throw new Error("This backup has an invalid format.");
    if (bundle.app !== EXPORT_APP) throw new Error("This backup was not created by Task Reminder.");
    if (bundle.schema !== STORAGE_VERSION) {
      throw new Error(`Only Task Reminder schema ${STORAGE_VERSION} backups can be imported.`);
    }
    if (!isRecord(bundle.data)) throw new Error("This backup does not contain a valid data section.");

    EXPORT_FIELDS.forEach((field) => {
      if (!Object.prototype.hasOwnProperty.call(bundle.data, field.key)) {
        throw new Error(`This backup is missing required data: ${field.key}.`);
      }
      if (!field.valid(bundle.data[field.key])) {
        throw new Error(`This backup contains invalid data for: ${field.key}.`);
      }
    });
    return bundle.data;
  }

  function serializedImportData(data) {
    const values = new Map();
    EXPORT_FIELDS.forEach(({ key }) => {
      const value = data[key];
      values.set(
        key,
        [STORAGE_VERSION_KEY, PROGRESS_RANGE_KEY, THEME_KEY].includes(key)
          ? value
          : JSON.stringify(value)
      );
    });
    return values;
  }

  function replaceStoredData(values) {
    const previous = new Map(EXPORT_FIELDS.map(({ key }) => [key, storageGet(key)]));
    const written = [];
    for (const [key, value] of values) {
      if (storageSet(key, value)) {
        written.push(key);
        continue;
      }
      written.forEach((writtenKey) => {
        const oldValue = previous.get(writtenKey);
        if (oldValue === null) storageRemove(writtenKey);
        else storageSet(writtenKey, oldValue);
      });
      return false;
    }
    return true;
  }

  async function confirmImport(text) {
    let data;
    try {
      data = parseImportText(text);
    } catch (error) {
      setTransferStatus(error.message, "error");
      return;
    }

    const ok = await showDialog({
      title: "Replace all saved data?",
      body: "This import will replace every task, reminder, game selection, progress record, setting, and theme currently saved on this device. This cannot be undone unless you export a backup first.",
      okLabel: "Replace data",
    });
    if (!ok) return;

    if (!replaceStoredData(serializedImportData(data))) {
      setTransferStatus("The import could not be saved. Your previous data was restored.", "error");
      return;
    }
    window.location.reload();
  }

  function selectedGameNames() {
    return SUGGEST_ORDER.filter((game) => selectedGames.has(game));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ---------- dialogs ---------- */

  // Promise-based confirm/reminder modal. Resolves true on OK, false on cancel/
  // dismiss. When cancel:false, only the OK button is shown.
  const confirmModal =
    typeof bootstrap !== "undefined" && bootstrap.Modal
      ? bootstrap.Modal.getOrCreateInstance(confirmModalEl)
      : null;

  function showDialog({ title, body, okLabel = "OK", cancel = true }) {
    if (!confirmModal) {
      if (!cancel) {
        window.alert(`${title}\n\n${body}`);
        return Promise.resolve(true);
      }
      return Promise.resolve(window.confirm(`${title}\n\n${body}`));
    }
    return new Promise((resolve) => {
      const opener = document.activeElement;
      confirmTitle.textContent = title;
      confirmBody.textContent = body;
      confirmOk.textContent = okLabel;
      confirmCancel.classList.toggle("d-none", !cancel);

      let settled = false;
      const cleanup = () => {
        confirmOk.removeEventListener("click", onOk);
        confirmModalEl.removeEventListener("hidden.bs.modal", onHidden);
      };
      const restoreFocus = () => {
        const target = opener && opener.isConnected && opener !== document.body ? opener : input;
        if (target === input) suppressSuggestionOpen = true;
        target.focus({ preventScroll: true });
      };
      const onOk = () => {
        if (settled) return;
        settled = true;
        cleanup();
        confirmModalEl.addEventListener("hidden.bs.modal", restoreFocus, { once: true });
        confirmModal.hide();
        resolve(true);
      };
      const onHidden = () => {
        if (settled) return;
        settled = true;
        cleanup();
        restoreFocus();
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
      storageSet(THEME_KEY, theme);
    } catch {}
  }

  function initTheme() {
    let saved = null;
    try {
      saved = storageGet(THEME_KEY);
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

  function setSettingsOpen(open) {
    settingsPanel.classList.toggle("d-none", !open);
    settingsToggle.setAttribute("aria-expanded", String(open));
    settingsToggle.setAttribute("aria-label", open ? "Close data settings" : "Open data settings");
    settingsToggle.classList.toggle("active", open);
    if (open) {
      refreshExportText();
      setTransferStatus("");
      settingsPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  settingsToggle.addEventListener("click", () => {
    setSettingsOpen(settingsPanel.classList.contains("d-none"));
  });

  settingsClose.addEventListener("click", () => {
    setSettingsOpen(false);
    settingsToggle.focus();
  });

  downloadData.addEventListener("click", () => {
    const text = buildExportText();
    exportDataText.value = text;
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `task-reminder-export-${todayKey()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setTransferStatus("Backup file downloaded.", "success");
  });

  copyData.addEventListener("click", async () => {
    refreshExportText();
    try {
      await navigator.clipboard.writeText(exportDataText.value);
      setTransferStatus("Backup text copied to the clipboard.", "success");
    } catch {
      exportDataText.focus();
      exportDataText.select();
      setTransferStatus("Clipboard access was blocked. The backup text is selected for you to copy.", "error");
    }
  });

  importDataFile.addEventListener("change", async () => {
    const [file] = importDataFile.files;
    if (!file) return;
    if (file.size > MAX_IMPORT_SIZE) {
      setTransferStatus("This backup file is too large to import.", "error");
      importDataFile.value = "";
      return;
    }
    try {
      const text = await file.text();
      importDataText.value = text;
      await confirmImport(text);
    } catch {
      setTransferStatus("The selected backup file could not be read.", "error");
    } finally {
      importDataFile.value = "";
    }
  });

  importData.addEventListener("click", () => confirmImport(importDataText.value));

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
    dueDate.required = repeat.type === "none";
    dueDate.setAttribute("aria-required", String(dueDate.required));
    if (!dueDate.required) dueDate.setCustomValidity("");

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
      if (typeof bootstrap !== "undefined" && bootstrap.Dropdown) {
        bootstrap.Dropdown.getOrCreateInstance(repeatToggle).hide();
      }
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
    const matches = SUGGEST_ORDER.filter((name) => {
      const pack = GAME_PACKS[name];
      const aliasMatch = (pack.aliases || []).some((a) => a.toLowerCase().includes(q));
      return !q || name.toLowerCase().includes(q) || aliasMatch;
    });
    if (!matches.length) {
      hideSuggestions();
      return;
    }
    suggestBox.innerHTML = "";

    const head = document.createElement("div");
    head.className = "game-picker-head";
    const title = document.createElement("span");
    title.textContent = "Choose your games";
    const actions = document.createElement("span");
    actions.className = "game-picker-actions";
    const count = document.createElement("span");
    count.textContent = `${selectedGameNames().length}/${SUGGEST_ORDER.length} selected`;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "game-picker-close";
    close.setAttribute("aria-label", "Close game picker");
    close.innerHTML = '<i class="bi bi-x-lg"></i>';
    close.addEventListener("click", () => {
      hideSuggestions();
      suppressSuggestionOpen = true;
      input.focus();
    });
    actions.append(count, close);
    head.append(title, actions);
    suggestBox.appendChild(head);

    matches.forEach((name) => {
      const pack = GAME_PACKS[name];
      const option = document.createElement("label");
      option.className = "suggest-item game-option";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedGames.has(name);
      checkbox.dataset.game = name;
      checkbox.setAttribute("aria-label", `Select ${name}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          const scrollTop = suggestBox.scrollTop;
          selectGame(name);
          input.value = "";
          updateSuggestions();
          const replacement = [...suggestBox.querySelectorAll("input[data-game]")].find(
            (candidate) => candidate.dataset.game === name
          );
          if (replacement) {
            replacement.focus({ preventScroll: true });
            suggestBox.scrollTop = scrollTop;
          }
          return;
        }
        confirmDeselectGame(name).then((removed) => {
          if (!removed) checkbox.checked = true;
        });
      });

      const copy = document.createElement("span");
      copy.className = "game-option-copy";
      const gameName = document.createElement("span");
      gameName.className = "game-option-name";
      gameName.textContent = name;
      const activityCount =
        (pack.dailies || []).length + (pack.weeklies || []).length + (pack.schedules || []).length;
      const detail = document.createElement("span");
      detail.className = "game-option-detail";
      detail.textContent = `${activityCount} activities`;
      copy.append(gameName, detail);

      option.append(checkbox, gameIconEl(name, "game-option-icon"), copy);
      suggestBox.appendChild(option);
    });
    suggestBox.classList.remove("d-none");
    input.setAttribute("aria-expanded", "true");
  }

  function hideSuggestions() {
    suggestBox.classList.add("d-none");
    suggestBox.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
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
      seriesId: uid(),
      packTask: true,
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

  function selectGame(name) {
    if (!GAME_PACKS[name]) return;
    selectedGames.add(name);
    addMissingGamePackActivities(name);
    saveSelectedGames();
    save();
    syncProgressOccurrences();
    render();
  }

  function confirmDeselectGame(name) {
    return showDialog({
      title: `Remove ${name}?`,
      body: `This removes ${name}'s tasks, character reminder state, and saved progress from this browser.`,
      okLabel: "Remove game",
    }).then((ok) => {
      if (!ok) return false;
      selectedGames.delete(name);
      tasks = tasks.filter((task) => !(task.packTask && task.game === name));
      progressHistory = progressHistory.filter((entry) => entry.game !== name);
      Object.keys(completedCharacters).forEach((key) => {
        try {
          if (JSON.parse(key)[0] === name) delete completedCharacters[key];
        } catch {}
      });
      Object.keys(dismissedTodayReminders).forEach((key) => {
        try {
          if (JSON.parse(key)[0] === name) delete dismissedTodayReminders[key];
        } catch {}
      });
      saveSelectedGames();
      saveProgressHistory();
      saveCompletedCharacters();
      saveDismissedTodayReminders();
      save();
      render();
      return true;
    });
  }

  /* ---------- game tasks ----------
   * Tasks added from a game pack are grouped into a per-game box. */

  // Game ownership is explicit. Personal tasks that happen to begin with a
  // game's name must remain personal when that game is deselected.
  function gameOf(task) {
    return task.game && GAME_PACKS[task.game] ? task.game : null;
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

  /* ---------- progress history ----------
   * Task rows are disposable UI state; these compact occurrence records retain
   * twelve months of completed/missed/pending outcomes for the charts. */

  function taskProgressStart(task, start) {
    if (start || task.date) return start || task.date;
    if (task.progressStart) return task.progressStart;
    const created = new Date(task.createdAt || Date.now());
    return toKey(created);
  }

  function occurrenceId(task, start) {
    return `${task.seriesId || task.id}::${taskProgressStart(task, start)}`;
  }

  function writeProgressStatus(task, status, start, completedAt, force) {
    const scheduledStart = taskProgressStart(task, start);
    const id = occurrenceId(task, scheduledStart);
    const seriesId = task.seriesId || task.id;
    progressHistory.forEach((entry) => {
      if (entry.seriesId === seriesId && entry.repeat === undefined) {
        entry.repeat = task.repeat || null;
      }
    });
    let record = progressHistory.find((entry) => entry.id === id);
    if (!record) {
      const game = gameOf(task);
      record = {
        id,
        seriesId,
        game,
        activity: game ? activityLabel(task, game) : task.text,
        repeat: task.repeat || null,
        scheduledStart,
        scheduledEnd: periodEndKey(task, scheduledStart) || scheduledStart,
        status: "pending",
        completedAt: null,
      };
      progressHistory.push(record);
    }
    if (
      force ||
      (record.status !== "completed" && !(status === "pending" && record.status === "missed"))
    ) {
      record.status = status;
      record.completedAt = status === "completed" ? completedAt || Date.now() : null;
    }
    return record;
  }

  function markMissed(task, start) {
    writeProgressStatus(task, "missed", start, null, false);
  }

  function pruneProgressHistory() {
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setMonth(cutoff.getMonth() - 12);
    const cutoffKey = toKey(cutoff);
    progressHistory = progressHistory.filter((entry) => entry.scheduledStart >= cutoffKey);
  }

  function syncProgressOccurrences() {
    const tKey = todayKey();
    let tasksChanged = false;
    tasks.forEach((task) => {
      if (!task.seriesId) {
        task.seriesId = task.id || uid();
        tasksChanged = true;
      }
      const start = taskProgressStart(task);
      if (start > tKey) return;
      writeProgressStatus(
        task,
        task.done ? "completed" : "pending",
        start,
        task.completedAt,
        false
      );
    });
    pruneProgressHistory();
    saveProgressHistory();
    if (tasksChanged) save();
  }

  // Scheduled monthly, interval, and patch tasks retain one current occurrence.
  // If a reset was missed, that occurrence is advanced instead of accumulating
  // overdue copies.
  function rollManagedSchedules() {
    const tKey = todayKey();
    let changed = false;
    tasks.forEach((task) => {
      if (!task.managedSchedule || !task.date) return;
      if (task.done) return;

      if (task.repeat === "patch") {
        if (task.date > tKey) return;
        const next = patchOccurrenceFor(gameOf(task), task.patchOffsetDays || 0, tKey);
        const hasChild = tasks.some((candidate) => candidate.spawnOf === task.id && !candidate.done);
        if (periodEndKey(task) < tKey) markMissed(task, task.date);
        if (next && tKey >= next.start && next.start !== task.date && !hasChild) {
          markMissed(task, task.date);
          task.date = next.start;
          task.periodEnd = next.end;
          task.done = false;
          delete task.spawnOf;
          changed = true;
        }
        return;
      }

      if (task.repeat === "weekly") return;
      let end = periodEndKey(task);
      while (end && tKey > end) {
        markMissed(task, task.date);
        const next = nextOccurrenceKey(task.date, task);
        if (!next || next === task.date) break;
        task.date = next;
        end = periodEndKey(task);
        changed = true;
      }
    });
    if (changed) save();
  }

  function rollDailyTasks() {
    const tKey = todayKey();
    let changed = false;
    tasks.forEach((task) => {
      if (task.repeat !== "daily" || task.done || !task.date) return;
      while (task.date < tKey) {
        markMissed(task, task.date);
        task.date = addDaysKey(task.date, 1);
        changed = true;
      }
    });
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
      while (t.date < weekStart) {
        markMissed(t, t.date);
        t.date = addDaysKey(t.date, 7);
        changed = true;
      }
    });
    if (changed) save();
  }

  function rollMonthlyTasks() {
    const tKey = todayKey();
    let changed = false;
    tasks.forEach((task) => {
      if (task.repeat !== "monthly" || task.managedSchedule || task.done || !task.date) return;
      while (task.date < tKey) {
        markMissed(task, task.date);
        const next = nextOccurrenceKey(task.date, task);
        if (!next || next === task.date) break;
        task.date = next;
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
    if (!trimmed || (!rep && !date)) return false;
    const task = {
      id: uid(),
      text: trimmed,
      done: false,
      date: date || null,
      repeat: null,
      weekday: null,
      monthDay: null,
      game: game || null,
      seriesId: uid(),
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
    return true;
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
    const seriesId = task.seriesId || task.id;
    if (tasks.some((candidate) => candidate.seriesId === seriesId && candidate.date === nextKey)) return;
    tasks.unshift({
      id: uid(),
      text: task.text,
      done: false,
      date: nextKey,
      repeat: task.repeat,
      weekday: task.weekday,
      monthDay: task.monthDay,
      game: gameOf(task),
      seriesId,
      packTask: task.packTask,
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
    refreshOccurrences();
    const task = tasks.find((t) => t.id === id);
    if (!task) return;

    if (task.done) {
      const start = taskProgressStart(task);
      const hasLaterCompletion = progressHistory.some(
        (entry) =>
          entry.seriesId === (task.seriesId || task.id) &&
          entry.scheduledStart > start &&
          entry.status === "completed"
      );
      if (task.repeat && hasLaterCompletion) {
        showDialog({
          title: "Later progress already exists",
          body: "This occurrence cannot be reopened because a later occurrence has already been completed.",
          okLabel: "Got it",
          cancel: false,
        });
        return;
      }
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
    const completedAt = done ? Date.now() : null;
    if (task.repeat) {
      if (done) {
        task.done = true;
        task.completedAt = completedAt;
        writeProgressStatus(task, "completed", taskProgressStart(task), completedAt, true);
        spawnNext(task);
      } else {
        task.done = false;
        delete task.completedAt;
        writeProgressStatus(task, "pending", taskProgressStart(task), null, true);
        const child = tasks.find((t) => t.spawnOf === task.id && !t.done);
        if (child) {
          progressHistory = progressHistory.filter((entry) => entry.id !== occurrenceId(child));
          tasks = tasks.filter((t) => t.id !== child.id);
        }
      }
    } else {
      task.done = done;
      if (done) {
        task.completedAt = completedAt;
        writeProgressStatus(task, "completed", taskProgressStart(task), completedAt, true);
      } else {
        delete task.completedAt;
        writeProgressStatus(task, "pending", taskProgressStart(task), null, true);
      }
    }
    saveProgressHistory();
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
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task) return;
    if (!task.done) {
      progressHistory = progressHistory.filter((entry) => entry.id !== occurrenceId(task));
      saveProgressHistory();
    }
    tasks = tasks.filter((t) => t.id !== id);
    save();
    render();
  }

  function visibleTasks() {
    const available = tasks.filter((task) => {
      const game = gameOf(task);
      return !game || selectedGames.has(game);
    });
    if (filter === "active") return available.filter((t) => !t.done);
    if (filter === "completed") return available.filter((t) => t.done);
    return available;
  }

  /* ---------- rendering ----------
   * buildTaskItem builds a full interactive row; buildProjectionItem builds a
   * read-only row used for future recurring occurrences shown in the calendar. */

  function renamePersonalTask(id, text) {
    const task = tasks.find((candidate) => candidate.id === id);
    const trimmed = text.trim();
    if (!task || gameOf(task) || !trimmed) return false;

    const seriesId = task.seriesId || task.id;
    tasks.forEach((candidate) => {
      if (!gameOf(candidate) && (candidate.seriesId || candidate.id) === seriesId) {
        candidate.text = trimmed;
      }
    });
    progressHistory.forEach((entry) => {
      if (!entry.game && entry.seriesId === seriesId) entry.activity = trimmed;
    });
    save();
    saveProgressHistory();
    render();
    return true;
  }

  function beginTaskEdit(task, body, check, actions) {
    check.disabled = true;
    actions.classList.add("d-none");
    body.innerHTML = "";

    const form = document.createElement("form");
    form.className = "task-edit-form";

    const editInput = document.createElement("input");
    editInput.type = "text";
    editInput.className = "task-edit-input";
    editInput.value = task.text;
    editInput.maxLength = 160;
    editInput.setAttribute("aria-label", "Edit task name");

    const controls = document.createElement("div");
    controls.className = "task-edit-controls";
    const saveEdit = document.createElement("button");
    saveEdit.type = "submit";
    saveEdit.className = "task-edit-confirm";
    saveEdit.setAttribute("aria-label", "Save task name");
    saveEdit.innerHTML = '<i class="bi bi-check-lg"></i>';
    const cancelEdit = document.createElement("button");
    cancelEdit.type = "button";
    cancelEdit.className = "task-edit-cancel";
    cancelEdit.setAttribute("aria-label", "Cancel editing");
    cancelEdit.innerHTML = '<i class="bi bi-x-lg"></i>';
    controls.append(saveEdit, cancelEdit);
    form.append(editInput, controls);
    body.appendChild(form);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!editInput.value.trim()) {
        editInput.setCustomValidity("Task name cannot be empty.");
        editInput.reportValidity();
        return;
      }
      renamePersonalTask(task.id, editInput.value);
    });
    editInput.addEventListener("input", () => editInput.setCustomValidity(""));
    editInput.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      render();
    });
    cancelEdit.addEventListener("click", render);
    editInput.focus();
    editInput.select();
  }

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

    if (!compact && !gameOf(task)) {
      const actions = document.createElement("div");
      actions.className = "task-row-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "task-edit";
      edit.setAttribute("aria-label", `Edit ${task.text}`);
      edit.innerHTML = '<i class="bi bi-pencil"></i>';
      edit.addEventListener("click", () => beginTaskEdit(task, body, check, actions));
      actions.append(edit, del);
      li.append(check, body, actions);
    } else {
      li.append(check, body, del);
    }
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

  /* Calendar day list: folds every activity of one game into a single row.
   * Groups open by default now that daily and weekly entries are omitted. */
  function buildCalGameGroup(game, items) {
    const wrap = document.createElement("li");
    wrap.className = "cal-game";

    const key = `${selectedKey}::${game}`;
    const open = !collapsedCalGames.has(key);

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
      if (nowOpen) collapsedCalGames.delete(key);
      else collapsedCalGames.add(key);
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
    selectedGameNames().forEach((game) => {
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

  /* ---------- progress visuals ---------- */

  function completionDateKey(task) {
    return task.completedAt ? toKey(new Date(task.completedAt)) : null;
  }

  function currentTasksForToday() {
    const tKey = todayKey();
    return tasks.filter((task) => {
      const game = gameOf(task);
      if (game && !selectedGames.has(game)) return false;
      if (task.repeat === "weekly" || task.managedSchedule) return occursDuringPeriod(task, tKey);
      if (task.repeat === "daily") return task.date === tKey;
      if (task.date) {
        if (task.done) return task.date === tKey || completionDateKey(task) === tKey;
        return task.date <= tKey;
      }
      return task.done ? completionDateKey(task) === tKey : true;
    });
  }

  function tasksForDayProgress(key) {
    const tKey = todayKey();
    if (key !== tKey) {
      const recorded = progressHistory.filter((entry) => {
        if (entry.repeat !== "daily" || entry.scheduledStart !== key) return false;
        return !entry.game || selectedGames.has(entry.game);
      });
      if (key < tKey) return recorded;

      const recordedSeries = new Set(recorded.map((entry) => entry.seriesId));
      const projected = new Map();
      tasks.forEach((task) => {
        const game = gameOf(task);
        const seriesId = task.seriesId || task.id;
        if (
          task.repeat !== "daily" ||
          task.done ||
          !task.date ||
          task.date > key ||
          (game && !selectedGames.has(game)) ||
          recordedSeries.has(seriesId) ||
          projected.has(seriesId)
        ) return;
        projected.set(seriesId, {
          id: `${seriesId}::${key}`,
          seriesId,
          game,
          activity: game ? activityLabel(task, game) : task.text,
          repeat: "daily",
          scheduledStart: key,
          status: "pending",
        });
      });
      return [...recorded, ...projected.values()];
    }

    const current = currentTasksForToday().filter((task) => task.repeat === "daily");
    const currentIds = new Set(current.map((task) => occurrenceId(task)));
    const retainedCompletions = progressHistory.filter((entry) => {
      if (
        entry.repeat !== "daily" ||
        entry.status !== "completed" ||
        currentIds.has(entry.id)
      ) return false;
      if (entry.game && !selectedGames.has(entry.game)) return false;
      return entry.scheduledStart === tKey;
    });
    return [...current, ...retainedCompletions];
  }

  function progressStats(entries) {
    const total = entries.length;
    const completed = entries.filter((entry) =>
      entry.done !== undefined ? entry.done : entry.status === "completed"
    ).length;
    return { total, completed, percent: total ? Math.round((completed / total) * 100) : 0 };
  }

  function historyInRange(start, end) {
    return progressHistory.filter(
      (entry) => entry.scheduledStart >= start && entry.scheduledStart <= end
    );
  }

  function makeProgressEmpty(message) {
    const empty = document.createElement("div");
    empty.className = "progress-empty";
    empty.innerHTML = '<i class="bi bi-bar-chart-line"></i>';
    const text = document.createElement("span");
    text.textContent = message;
    empty.appendChild(text);
    return empty;
  }

  function renderDayProgress(entries, key) {
    const stats = progressStats(entries);
    const complete = stats.total > 0 && stats.completed === stats.total;
    const isToday = key === todayKey();
    const layout = document.createElement("div");
    layout.className = "day-progress";

    const ring = document.createElement("div");
    ring.className = "progress-ring" + (complete ? " is-complete" : "");
    ring.style.setProperty("--progress", `${stats.percent * 3.6}deg`);
    ring.setAttribute("role", "img");
    ring.setAttribute(
      "aria-label",
      `${stats.percent}% complete, ${stats.completed} of ${stats.total} daily tasks`
    );
    const ringCore = document.createElement("div");
    ringCore.className = "progress-ring-core";
    if (complete) {
      const tick = document.createElement("i");
      tick.className = "bi bi-check-lg progress-complete-tick";
      tick.setAttribute("aria-hidden", "true");
      ringCore.appendChild(tick);
    }
    const percent = document.createElement("strong");
    percent.textContent = `${stats.percent}%`;
    const fraction = document.createElement("span");
    fraction.textContent = `${stats.completed}/${stats.total}`;
    ringCore.append(percent, fraction);
    ring.appendChild(ringCore);

    const copy = document.createElement("div");
    copy.className = "progress-copy";
    const title = document.createElement("h3");
    title.textContent = complete
      ? "All dailies complete"
      : stats.total
        ? isToday ? "Today's dailies" : "Dailies for this day"
        : isToday ? "No dailies today" : "No dailies on this day";
    const detail = document.createElement("p");
    detail.textContent = complete
      ? "Everything scheduled daily is checked off."
      : stats.total
        ? `${stats.total - stats.completed} daily task${stats.total - stats.completed === 1 ? "" : "s"} remaining across your active lists.`
        : "Select a game or add a repeating daily task to begin tracking momentum.";
    copy.append(title, detail);
    layout.append(ring, copy);
    progressVisual.appendChild(layout);
    return stats;
  }

  function renderWeekProgress(entries, start, selected) {
    const chart = document.createElement("div");
    chart.className = "week-progress";
    chart.setAttribute("aria-hidden", "true");
    const summary = document.createElement("ul");
    summary.className = "visually-hidden";
    const tKey = todayKey();
    const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

    for (let i = 0; i < 7; i++) {
      const key = addDaysKey(start, i);
      const dayEntries = entries.filter((entry) => entry.scheduledStart === key);
      const stats = progressStats(dayEntries);
      const column = document.createElement("div");
      column.className = "week-progress-day" +
        (key > tKey ? " is-future" : "") +
        (key === selected ? " is-selected" : "");
      column.title = `${formatLong(key)} · ${stats.completed}/${stats.total} completed`;

      const value = document.createElement("span");
      value.className = "week-progress-value";
      value.textContent = stats.total ? `${stats.percent}%` : "–";
      const track = document.createElement("div");
      track.className = "week-progress-track";
      const fill = document.createElement("span");
      fill.className = "week-progress-fill";
      fill.style.setProperty("--bar-scale", String(stats.percent / 100));
      track.appendChild(fill);
      const day = document.createElement("span");
      day.className = "week-progress-label";
      day.textContent = labels[i];
      column.append(value, track, day);
      chart.appendChild(column);

      const summaryItem = document.createElement("li");
      summaryItem.textContent = `${formatLong(key)}: ${stats.completed} of ${stats.total} completed`;
      summary.appendChild(summaryItem);
    }
    progressVisual.append(chart, summary);
    return progressStats(entries);
  }

  function renderMonthProgress(entries, year, month, selected) {
    const wrap = document.createElement("div");
    wrap.className = "month-progress-wrap";
    const grid = document.createElement("div");
    grid.className = "month-progress";
    grid.setAttribute("aria-hidden", "true");
    const summary = document.createElement("ul");
    summary.className = "visually-hidden";
    ["M", "T", "W", "T", "F", "S", "S"].forEach((label) => {
      const weekday = document.createElement("span");
      weekday.className = "month-progress-weekday";
      weekday.textContent = label;
      grid.appendChild(weekday);
    });

    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const days = new Date(year, month + 1, 0).getDate();
    const tKey = todayKey();
    for (let i = 0; i < offset; i++) {
      const blank = document.createElement("span");
      blank.className = "month-progress-blank";
      grid.appendChild(blank);
    }
    for (let day = 1; day <= days; day++) {
      const key = toKey(new Date(year, month, day));
      const dayEntries = entries.filter((entry) => entry.scheduledStart === key);
      const stats = progressStats(dayEntries);
      const level = !stats.total ? 0 : stats.percent === 100 ? 4 : stats.percent >= 67 ? 3 : stats.percent >= 34 ? 2 : 1;
      const cell = document.createElement("span");
      cell.className = `month-progress-day level-${level}` +
        (key === tKey ? " is-today" : "") +
        (key > tKey ? " is-future" : "") +
        (key === selected ? " is-selected" : "");
      cell.textContent = day;
      cell.title = `${formatLong(key)} · ${stats.completed}/${stats.total} completed`;
      cell.setAttribute("aria-label", cell.title);
      grid.appendChild(cell);
      if (stats.total) {
        const summaryItem = document.createElement("li");
        summaryItem.textContent = `${formatLong(key)}: ${stats.completed} of ${stats.total} completed`;
        summary.appendChild(summaryItem);
      }
    }

    const legend = document.createElement("div");
    legend.className = "month-progress-legend";
    legend.append(document.createTextNode("Less"));
    for (let level = 0; level <= 4; level++) {
      const swatch = document.createElement("span");
      swatch.className = `level-${level}`;
      legend.appendChild(swatch);
    }
    legend.append(document.createTextNode("More"));
    wrap.append(grid, legend);
    progressVisual.append(wrap, summary);
    return progressStats(entries);
  }

  function renderProgressBreakdown(entries) {
    progressBreakdown.innerHTML = "";
    if (!entries.length) return;

    const title = document.createElement("h3");
    title.textContent = "By list";
    progressBreakdown.appendChild(title);

    const groups = [];
    selectedGameNames().forEach((game) => {
      const items = entries.filter((entry) =>
        entry.game !== undefined ? entry.game === game : gameOf(entry) === game
      );
      if (items.length) groups.push({ name: game, game, items });
    });
    const personal = entries.filter((entry) =>
      entry.game !== undefined ? !entry.game : !gameOf(entry)
    );
    if (personal.length) groups.push({ name: "Personal", game: null, items: personal });

    groups.forEach((group) => {
      const stats = progressStats(group.items);
      const gameComplete =
        progressRange === "day" && group.game && stats.total && stats.completed === stats.total;
      const row = document.createElement("div");
      row.className = "progress-breakdown-row";
      const identity = document.createElement("span");
      identity.className = "progress-breakdown-name";
      if (group.game) identity.appendChild(gameIconEl(group.game, "progress-game-icon"));
      else {
        const icon = document.createElement("i");
        icon.className = "bi bi-person progress-game-icon";
        identity.appendChild(icon);
      }
      identity.appendChild(document.createTextNode(group.name));

      const track = document.createElement("span");
      track.className = "progress-breakdown-track";
      const fill = document.createElement("span");
      fill.className = "progress-breakdown-fill";
      fill.style.setProperty("--bar-scale", String(stats.percent / 100));
      track.appendChild(fill);
      const value = document.createElement("span");
      value.className = "progress-breakdown-value";
      value.textContent = `${stats.completed}/${stats.total}`;
      if (gameComplete) {
        const complete = document.createElement("i");
        complete.className = "bi bi-check-lg progress-list-complete";
        complete.setAttribute("aria-label", "All dailies complete");
        value.appendChild(complete);
      }
      row.append(identity, track, value);

      if (group.game) {
        const taskSummary = new Map();
        group.items.forEach((entry) => {
          const name = entry.activity || (entry.text ? activityLabel(entry, group.game) : "Unnamed task");
          const item = taskSummary.get(name) || { total: 0, completed: 0 };
          item.total++;
          if (entry.done !== undefined ? entry.done : entry.status === "completed") item.completed++;
          taskSummary.set(name, item);
        });

        const details = document.createElement("div");
        details.className = "progress-task-details";
        const detailTitle = document.createElement("strong");
        detailTitle.textContent = "Tasks in this period";
        const detailList = document.createElement("ul");
        taskSummary.forEach((item, name) => {
          const detail = document.createElement("li");
          const status = document.createElement("i");
          status.className = `bi ${item.completed === item.total ? "bi-check-circle-fill" : "bi-circle"}`;
          const label = document.createElement("span");
          label.textContent = name;
          const count = document.createElement("small");
          count.textContent = `${item.completed}/${item.total}`;
          detail.append(status, label, count);
          detailList.appendChild(detail);
        });
        details.append(detailTitle, detailList);
        row.classList.add("has-task-details");
        row.tabIndex = 0;
        row.setAttribute("aria-label", `${group.name}: ${stats.completed} of ${stats.total} complete. Focus to show tasks.`);
        row.appendChild(details);
      }
      progressBreakdown.appendChild(row);
    });
  }

  function renderProgress() {
    progressVisual.innerHTML = "";
    progressBreakdown.innerHTML = "";
    progressTabs.querySelectorAll("[data-progress-range]").forEach((button) => {
      const active = button.dataset.progressRange === progressRange;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });

    const focusKey = selectedKey;
    let entries;
    let stats;
    if (progressRange === "day") {
      entries = tasksForDayProgress(focusKey);
      progressRangeLabel.textContent = formatLong(focusKey);
      stats = renderDayProgress(entries, focusKey);
    } else if (progressRange === "week") {
      const start = weekStartKey(focusKey, 1);
      const end = addDaysKey(start, 6);
      entries = historyInRange(start, end);
      progressRangeLabel.textContent = `${formatShort(start)}–${formatShort(end)}`;
      stats = renderWeekProgress(entries, start, focusKey);
    } else {
      const selected = fromKey(focusKey);
      const start = toKey(new Date(selected.getFullYear(), selected.getMonth(), 1));
      const end = toKey(new Date(selected.getFullYear(), selected.getMonth() + 1, 0));
      entries = historyInRange(start, end);
      progressRangeLabel.textContent = selected.toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      });
      stats = renderMonthProgress(entries, selected.getFullYear(), selected.getMonth(), focusKey);
    }

    if (!entries.length && progressRange !== "day") {
      progressVisual.prepend(makeProgressEmpty("No progress has been recorded for this period yet."));
    }
    renderProgressBreakdown(entries);
    progressLabel.textContent = `${stats.percent}% ${progressRange}`;
  }

  function renderTodayCharacterReminders() {
    const tKey = todayKey();
    let dismissalsChanged = false;
    Object.keys(dismissedTodayReminders).forEach((key) => {
      if (dismissedTodayReminders[key] !== tKey) {
        delete dismissedTodayReminders[key];
        dismissalsChanged = true;
      }
    });
    if (dismissalsChanged) saveDismissedTodayReminders();

    const releases = [];
    selectedGameNames().forEach((game) => {
      gameCharacters(game).forEach((character) => {
        if (character.date !== tKey) return;
        const key = characterReminderKey(game, character);
        if (completedCharacters[key] || dismissedTodayReminders[key]) return;
        releases.push({ game, character, key });
      });
    });
    releases.sort(
      (a, b) =>
        SUGGEST_ORDER.indexOf(a.game) - SUGGEST_ORDER.indexOf(b.game) ||
        a.character.name.localeCompare(b.character.name)
    );

    todayReminders.innerHTML = "";
    todayReminders.classList.toggle("d-none", releases.length === 0);
    releases.forEach(({ game, character, key }) => {
      const reminder = document.createElement("section");
      reminder.className = "today-reminder";

      const portrait = characterPortraitEl(
        game,
        character,
        "character-portrait today-reminder-portrait"
      );
      const body = document.createElement("div");
      body.className = "today-reminder-body";
      const kicker = document.createElement("span");
      kicker.className = "today-reminder-kicker";
      kicker.textContent = `Releases today · ${game}`;
      const title = document.createElement("strong");
      title.className = "today-reminder-title";
      title.textContent = `${character.name} is available today`;
      body.append(kicker, title);

      const close = document.createElement("button");
      close.type = "button";
      close.className = "today-reminder-close";
      close.setAttribute("aria-label", `Dismiss ${character.name} release reminder`);
      close.innerHTML = '<i class="bi bi-x-lg"></i>';
      close.addEventListener("click", () => {
        dismissedTodayReminders[key] = tKey;
        saveDismissedTodayReminders();
        renderTodayCharacterReminders();
      });

      reminder.append(portrait, body, close);
      todayReminders.appendChild(reminder);
    });
  }

  /* Full re-render of the whole UI. Personal tasks are split into Recurring
   * (left) and One-time (right), followed by grouped game-pack activity boxes.
   * (right). Future recurring occurrences are excluded from the lists both to
   * reduce clutter and so a task completed for today doesn't keep showing as
   * active — the calendar is where they stay visible until the day arrives. */
  function refreshOccurrences() {
    rollDailyTasks();
    rollWeeklyTasks();
    rollMonthlyTasks();
    rollManagedSchedules();
    syncProgressOccurrences();
  }

  function render() {
    refreshOccurrences();
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

    const tracked = currentTasksForToday();
    const todayStats = progressStats(tracked);
    const remaining = todayStats.total - todayStats.completed;
    counter.textContent = `${remaining} task${remaining === 1 ? "" : "s"} left`;

    renderTodayCharacterReminders();
    renderProgress();
    renderCalendar();
    if (view === "reminders") renderReminders();
  }

  /* ---------- calendar ----------
   * Daily and weekly activities are omitted. One-time and longer-cycle recurring
   * tasks appear only on their occurrence start date. */

  // Calendar rows represent schedule starts, not the full availability window.
  function occursOn(task, key) {
    return !!task.date && !["daily", "weekly"].includes(task.repeat) && task.date === key;
  }

  function renderCalendar() {
    calDateJump.value = selectedKey;
    calTitle.textContent = new Date(calYear, calMonth, 1).toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });

    const gameCounts = {};
    const personalCounts = {};
    const onDate = {};
    const monthStart = toKey(new Date(calYear, calMonth, 1));
    const monthEnd = toKey(new Date(calYear, calMonth + 1, 0));

    // Patch events / character releases overlaid from gamedata.js.
    const metaMaps = monthMeta(monthStart, monthEnd);
    const dayEvents = metaMaps.events;
    const dayChars = metaMaps.chars;

    const bump = (key, task) => {
      const categoryCounts = gameOf(task) ? gameCounts : personalCounts;
      categoryCounts[key] = (categoryCounts[key] || 0) + 1;
      onDate[key] = onDate[key] || [];
    };

    tasks.forEach((t) => {
      if (!t.date || t.repeat || (t.done && gameOf(t))) return;
      bump(t.date, t);
      onDate[t.date].push(t);
    });

    // Completed personal recurring occurrences remain visible on their actual
    // calendar date, while game recurrence projections stay uncluttered.
    tasks.forEach((t) => {
      if (!t.date || !t.done || !t.repeat || gameOf(t)) return;
      bump(t.date, t);
      onDate[t.date].push(t);
    });

    tasks.forEach((t) => {
      if (!t.repeat || ["daily", "weekly"].includes(t.repeat) || t.done || !t.date) return;
      let cursor = t.date;
      for (let i = 0; i < 4000; i++) {
        if (!cursor || cursor > monthEnd) break;
        if (cursor >= monthStart) {
          bump(cursor, t);
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
         `<span class="cal-dot dot-personal"></span>` +
         `<span class="cal-dot dot-event"></span>` +
        `<span class="cal-dot dot-char"></span>` +
        `</span>`;
      btn.setAttribute("aria-label", formatLong(key));
      if (key === tKey) btn.classList.add("is-today");
      if (key === selectedKey) btn.classList.add("is-selected");

      const evs = dayEvents[key] || [];
      const chs = dayChars[key] || [];
      const parts = [];
      if (gameCounts[key]) {
        parts.push(`${gameCounts[key]} game activit${gameCounts[key] === 1 ? "y" : "ies"}`);
      }
      if (personalCounts[key]) {
        parts.push(`${personalCounts[key]} personal task${personalCounts[key] === 1 ? "" : "s"}`);
      }
      if (evs.length) parts.push(evs[0].name);
      if (chs.length) parts.push(`${chs.length} new character${chs.length === 1 ? "" : "s"}`);
      if (gameCounts[key]) btn.classList.add("has-tasks");
      if (personalCounts[key]) btn.classList.add("has-personal");
      if (evs.length) btn.classList.add("has-events");
      if (chs.length) btn.classList.add("has-characters");
      if (parts.length) {
        btn.title = parts.join(" · ");
        btn.setAttribute("aria-label", `${formatLong(key)} · ${parts.join(" · ")}`);
      }

      btn.addEventListener("click", () => {
        selectedKey = key;
        renderCalendar();
        renderProgress();
      });
      calDays.appendChild(btn);
    }

    calSelectedLabel.textContent = formatLong(selectedKey);
    // Character releases + patch events for the selected day (pinned at top),
    // then tasks whose occurrence starts that day and future projections.
    const selChars = dayChars[selectedKey] || [];
    const selEvents = dayEvents[selectedKey] || [];
    const dayTasks = tasks.filter((t) =>
      (!t.done && occursOn(t, selectedKey)) ||
      (t.done && !gameOf(t) && t.date === selectedKey)
    );
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
    const day = fromKey(selectedKey).getDate();
    calMonth--;
    if (calMonth < 0) {
      calMonth = 11;
      calYear--;
    }
    selectedKey = monthlyKey(calYear, calMonth, day);
    renderCalendar();
    renderProgress();
  });

  calNext.addEventListener("click", () => {
    const day = fromKey(selectedKey).getDate();
    calMonth++;
    if (calMonth > 11) {
      calMonth = 0;
      calYear++;
    }
    selectedKey = monthlyKey(calYear, calMonth, day);
    renderCalendar();
    renderProgress();
  });

  calToday.addEventListener("click", () => {
    const d = new Date();
    calYear = d.getFullYear();
    calMonth = d.getMonth();
    selectedKey = toKey(d);
    renderCalendar();
    renderProgress();
  });

  calDateJump.addEventListener("change", () => {
    if (!calDateJump.value) {
      calDateJump.value = selectedKey;
      return;
    }
    const date = fromKey(calDateJump.value);
    calYear = date.getFullYear();
    calMonth = date.getMonth();
    selectedKey = calDateJump.value;
    renderCalendar();
    renderProgress();
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

  function appendCharacterList(entries, groupByEnd) {
    const list = document.createElement("ul");
    list.className = "list-unstyled reminder-timeline mb-0";
    let previousDate = null;

    entries.forEach(({ game, character, end, completed }) => {
      const headingKey = groupByEnd ? end || "unknown" : character.date;
      if (headingKey !== previousDate) {
        const dateHead = document.createElement("li");
        dateHead.className = "reminder-date-head";
        dateHead.textContent = groupByEnd
          ? end
            ? `Ends ${formatLong(end)}`
            : "No known end date"
          : formatLong(character.date);
        list.appendChild(dateHead);
        previousDate = headingKey;
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
        renderTodayCharacterReminders();
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
      meta.appendChild(gameIconEl(game, "reminder-inline-game-icon"));
      const timing = completed
        ? `Completed · released ${formatShort(character.date)}`
        : character.date > todayKey()
          ? `Starts ${formatShort(character.date)}`
          : character.date === todayKey()
            ? "Released today"
          : end
            ? `Active through ${formatShort(end)}`
            : `Released ${formatShort(character.date)}`;
      meta.appendChild(document.createTextNode(`${game} · ${timing}`));
      body.append(title, meta);
      li.append(check, portrait, body);
      list.appendChild(li);
    });
    remindersView.appendChild(list);
  }

  function renderReminders() {
    remindersView.innerHTML = "";
    const tKey = todayKey();
    const upcoming = [];
    const current = [];

    selectedGameNames().forEach((game) => {
      gameCharacters(game).forEach((character) => {
        const entry = {
          game,
          character,
          end: characterEndKey(game, character),
          completed: !!completedCharacters[characterReminderKey(game, character)],
        };
        if (character.date > tKey) upcoming.push(entry);
        else if (!entry.end || tKey <= entry.end) current.push(entry);
      });
    });
    const chronological = (a, b) =>
      a.character.date.localeCompare(b.character.date) ||
      a.game.localeCompare(b.game) ||
      a.character.name.localeCompare(b.character.name);
    upcoming.sort(chronological);
    current.sort(
      (a, b) =>
        (a.end || "9999-12-31").localeCompare(b.end || "9999-12-31") || chronological(a, b)
    );

    const head = document.createElement("div");
    head.className = "reminders-head";
    head.innerHTML = '<i class="bi bi-person-hearts"></i><span>Character reminders</span>';
    remindersView.appendChild(head);

    const tabs = document.createElement("div");
    tabs.className = "reminder-range-tabs";
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "Character banner range");
    [
      { value: "upcoming", label: "Upcoming", count: upcoming.length },
      { value: "current", label: "Current", count: current.length },
    ].forEach(({ value, label, count }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = reminderRange === value ? "active" : "";
      button.setAttribute("aria-pressed", String(reminderRange === value));
      button.innerHTML = `<span>${label}</span><small>${count}</small>`;
      button.addEventListener("click", () => {
        reminderRange = value;
        renderReminders();
      });
      tabs.appendChild(button);
    });
    remindersView.appendChild(tabs);

    const shown = reminderRange === "current" ? current : upcoming;
    if (shown.length) {
      appendCharacterList(shown, reminderRange === "current");
    } else {
      const p = document.createElement("p");
      p.className = "small text-body-secondary mb-0";
      p.textContent =
        reminderRange === "current"
          ? "No current character banners on record."
          : "No upcoming character banners on record.";
      remindersView.appendChild(p);
    }
  }

  viewTabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view]");
    if (btn) showView(btn.dataset.view);
  });

  /* ---------- events ---------- */

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const rep = currentRep();
    if (!rep && !dueDate.value) {
      dueDate.setCustomValidity("Set a date for a non-recurring task.");
      dueDate.reportValidity();
      dueDate.focus();
      return;
    }
    if (!addTask(input.value, dueDate.value || null, rep)) return;
    input.value = "";
    input.focus();
    dueDate.value = "";
    setRepeat("none");
    hideSuggestions();
  });

  input.addEventListener("input", updateSuggestions);
  input.addEventListener("focus", () => {
    if (suppressSuggestionOpen) {
      suppressSuggestionOpen = false;
      return;
    }
    updateSuggestions();
  });
  input.addEventListener("click", updateSuggestions);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideSuggestions();
  });
  suggestBox.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    hideSuggestions();
    suppressSuggestionOpen = true;
    input.focus();
  });

  // Clicking outside the suggestion area closes it.
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#suggestWrap")) hideSuggestions();
  });

  clearDue.addEventListener("click", () => {
    dueDate.value = "";
    dueDate.setCustomValidity("");
    dueDate.focus();
  });

  dueDate.addEventListener("input", () => dueDate.setCustomValidity(""));
  dueDate.addEventListener("invalid", () => {
    if (repeat.type === "none") {
      dueDate.setCustomValidity("Set a date for a non-recurring task.");
    }
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

  progressTabs.addEventListener("click", (e) => {
    const button = e.target.closest("[data-progress-range]");
    if (!button) return;
    progressRange = button.dataset.progressRange;
    storageSet(PROGRESS_RANGE_KEY, progressRange);
    renderProgress();
  });

  // Wipe all app data except the display theme (confirm first).
  clearAll.addEventListener("click", () => {
    showDialog({
      title: "Clear all data?",
      body: "This permanently deletes all tasks, selected games, character reminders, and progress history from this browser. Your theme is kept.",
      okLabel: "Delete all",
    }).then((ok) => {
      if (!ok) return;
      tasks = [];
      selectedGames = new Set();
      completedCharacters = {};
      dismissedTodayReminders = {};
      progressHistory = [];
      progressRange = "day";
      save();
      saveSelectedGames();
      saveCompletedCharacters();
      saveDismissedTodayReminders();
      saveProgressHistory();
      storageRemove(PROGRESS_RANGE_KEY);
      render();
      hideSuggestions();
    });
  });

  function updateDateLine() {
    dateLine.textContent = new Date().toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }

  let lastRenderedDay = todayKey();
  let midnightTimer;

  function refreshAfterDateChange() {
    const current = todayKey();
    if (current === lastRenderedDay) return;
    const previous = lastRenderedDay;
    const previousDate = fromKey(previous);
    const currentDate = fromKey(current);
    if (selectedKey === previous) selectedKey = current;
    if (calYear === previousDate.getFullYear() && calMonth === previousDate.getMonth()) {
      calYear = currentDate.getFullYear();
      calMonth = currentDate.getMonth();
    }
    lastRenderedDay = current;
    updateDateLine();
    render();
  }

  function scheduleMidnightRefresh() {
    window.clearTimeout(midnightTimer);
    const next = new Date();
    next.setHours(24, 0, 0, 100);
    midnightTimer = window.setTimeout(() => {
      refreshAfterDateChange();
      scheduleMidnightRefresh();
    }, next.getTime() - Date.now());
  }

  window.addEventListener("focus", refreshAfterDateChange);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshAfterDateChange();
  });

  // ---- boot ----
  initTheme();
  updateRepeatUI();
  updateDateLine();
  render();
  scheduleMidnightRefresh();
})();
