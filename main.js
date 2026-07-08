"use strict";
var obsidian = require("obsidian");

// ---- Constants ----

var WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
var MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];
var CELL_SIZE = 20;
var CELL_GAP = 3;
var LABEL_COLUMN_WIDTH = 34;
var CARD_PADDING = 28;
var MIN_WEEKS = 4;
var DEFAULT_WEEKS_CAP = 53;
var RESIZE_DEBOUNCE_MS = 120;
var SAVE_DEBOUNCE_MS = 400;

// ---- Date utilities (pure) ----
// All local-timezone based (never UTC methods), so toDateKey/mondayOf/startOfDay
// agree on the same wall-clock notion of "day".

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, amount) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + amount);
  return copy;
}

function mondayOf(date) {
  const daysSinceMonday = (date.getDay() + 6) % 7;
  return addDays(date, -daysSinceMonday);
}

// ---- Color utilities (pure) ----

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const expanded = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const value = parseInt(expanded, 16);
  return { r: value >> 16 & 255, g: value >> 8 & 255, b: value & 255 };
}

function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0")).join("");
}

function interpolateColor(colors, t) {
  if (colors.length === 1) return colors[0];
  const clamped = Math.min(1, Math.max(0, t));
  const scaled = clamped * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const fraction = scaled - index;
  const from = hexToRgb(colors[index]);
  const to = hexToRgb(colors[index + 1]);
  return rgbToHex(
    from.r + (to.r - from.r) * fraction,
    from.g + (to.g - from.g) * fraction,
    from.b + (to.b - from.b) * fraction
  );
}

function interpolateFGradient(stops, value) {
  if (value <= stops[0].value) return stops[0].color;
  const last = stops[stops.length - 1];
  if (value >= last.value) return last.color;
  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i];
    const to = stops[i + 1];
    if (value >= from.value && value <= to.value) {
      const t = to.value === from.value ? 0 : (value - from.value) / (to.value - from.value);
      return interpolateColor([from.color, to.color], t);
    }
  }
  return last.color;
}

function colorForValue(config, value, range) {
  if (config.colorMode === "categorical") {
    const index = Math.round(value) - config.min;
    const clamped = Math.max(0, Math.min(config.colors.length - 1, index));
    return config.colors[clamped];
  }
  if (config.fgradient) {
    return interpolateFGradient(config.fgradient, value);
  }
  const spread = range.max - range.min;
  const t = spread === 0 ? 0 : (value - range.min) / spread;
  return interpolateColor(config.colors, t);
}

// ---- Duration utilities (pure) ----
// "1h30" -> 90, "45m" -> 45, "3m05" -> 3m05s, plain numbers are minutes.

function formatDuration(totalMinutes) {
  const totalSeconds = Math.round(totalMinutes * 60);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h${String(minutes).padStart(2, "0")}` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}` : `${minutes}m`;
  return `${seconds}s`;
}

function parseDuration(raw) {
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (cleaned === "") return NaN;
  if (/^\d+(\.\d+)?$/.test(cleaned)) return parseFloat(cleaned);
  let normalized = cleaned;
  const hourShorthand = normalized.match(/^(\d+(?:\.\d+)?)h(\d+(?:\.\d+)?)$/);
  if (hourShorthand) {
    normalized = `${hourShorthand[1]}h${hourShorthand[2]}m`;
  } else {
    const minuteShorthand = normalized.match(/^(\d+(?:\.\d+)?)m(\d+(?:\.\d+)?)$/);
    if (minuteShorthand) normalized = `${minuteShorthand[1]}m${minuteShorthand[2]}s`;
  }
  const full = normalized.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!full || !full[1] && !full[2] && !full[3]) return NaN;
  const hours = full[1] ? parseFloat(full[1]) : 0;
  const minutes = full[2] ? parseFloat(full[2]) : 0;
  const seconds = full[3] ? parseFloat(full[3]) : 0;
  return hours * 60 + minutes + seconds / 60;
}

// ---- Value formatting & coercion (pure) ----

function formatCellValue(config, value) {
  return config.type === "time" ? formatDuration(value) : String(value);
}

function formatStatValue(config, average) {
  return config.type === "time" ? formatDuration(average) : average.toFixed(2);
}

// For type: "time" trackers, config.min/max are in raw minutes (default 0-100)
// unless the tracker author overrides them.
function coerceValue(config, raw) {
  const parsed = config.type === "time" ? parseDuration(raw) : Number(raw);
  if (Number.isNaN(parsed)) {
    return config.type === "time" ? { ok: false, reason: "Not a valid duration (try 1h30, 45m, 3m05)" } : { ok: false, reason: "Not a valid number" };
  }
  if (config.type === "int" && !Number.isInteger(parsed)) {
    return { ok: false, reason: `Must be a whole number between ${config.min} and ${config.max}` };
  }
  if (parsed < config.min || parsed > config.max) {
    return { ok: false, reason: `Must be between ${config.min} and ${config.max}` };
  }
  return { ok: true, value: parsed };
}

// ---- Config parsing & validation (pure; throws on invalid input) ----

function buildFGradient(raw) {
  if (raw.fgradient === void 0) return void 0;
  if (!Array.isArray(raw.fgradient) || raw.fgradient.length < 2) {
    throw new Error(`Tracker '${raw.id}' fgradient requires at least 2 stops`);
  }
  const stops = raw.fgradient.map((entry) => {
    if (typeof entry.value !== "number" || typeof entry.color !== "string") {
      throw new Error(`Tracker '${raw.id}' fgradient entries need a numeric 'value' and string 'color'`);
    }
    return { value: entry.value, color: entry.color };
  });
  return [...stops].sort((a, b) => a.value - b.value);
}

function buildTrackerConfig(raw) {
  if (!raw.id || typeof raw.id !== "string") {
    throw new Error("Each calendar-heatmap tracker requires a unique 'id' field");
  }
  const type = ["int", "float", "time"].includes(raw.type) ? raw.type : "float";
  const colorMode = raw.colorMode === "gradient" ? "gradient" : "categorical";
  const fgradient = colorMode === "gradient" ? buildFGradient(raw) : void 0;
  const needsColors = !fgradient;
  if (needsColors && (!Array.isArray(raw.colors) || raw.colors.length === 0)) {
    throw new Error(`Tracker '${raw.id}' requires a non-empty 'colors' array`);
  }
  if (needsColors && colorMode === "gradient" && raw.colors.length < 2) {
    throw new Error(`Tracker '${raw.id}' colorMode: gradient requires at least 2 colors`);
  }
  return Object.freeze({
    id: raw.id,
    title: typeof raw.title === "string" ? raw.title : raw.id,
    icon: typeof raw.icon === "string" ? raw.icon : "activity",
    type,
    min: typeof raw.min === "number" ? raw.min : 0,
    max: typeof raw.max === "number" ? raw.max : 100,
    colorMode,
    colors: Array.isArray(raw.colors) ? raw.colors : [],
    fgradient,
    egradient: typeof raw.egradient === "boolean" ? raw.egradient : false,
    unit: typeof raw.unit === "string" ? raw.unit : "",
    weeks: typeof raw.weeks === "number" && raw.weeks > 0 ? Math.floor(raw.weeks) : DEFAULT_WEEKS_CAP,
    showNumbers: typeof raw.showNumbers === "boolean" ? raw.showNumbers : true
  });
}

function parseTrackerConfigs(source) {
  const raw = obsidian.parseYaml(source) ?? {};
  if (Array.isArray(raw.trackers)) {
    if (raw.trackers.length === 0) {
      throw new Error("'trackers' list is empty");
    }
    return raw.trackers.map(buildTrackerConfig);
  }
  return [buildTrackerConfig(raw)];
}

// ---- Card view-model builder (pure) — the functional core ----
// Turns (config, fetched entries/averages, today, layout) into one frozen,
// plain-data description of everything a card needs to render. No DOM here.

function buildMonthGroups(weeks, gridStart) {
  const groups = [];
  let currentMonth = -1;
  let groupStartCol = 2;
  for (let week = 0; week < weeks; week++) {
    const weekMonday = addDays(gridStart, week * 7);
    const col = week + 2;
    const month = weekMonday.getMonth();
    if (month !== currentMonth) {
      if (currentMonth >= 0) {
        groups.push(Object.freeze({ label: MONTH_LABELS[currentMonth], startCol: groupStartCol, endCol: col }));
      }
      currentMonth = month;
      groupStartCol = col;
    }
  }
  if (currentMonth >= 0) {
    groups.push(Object.freeze({ label: MONTH_LABELS[currentMonth], startCol: groupStartCol, endCol: weeks + 2 }));
  }
  return Object.freeze(groups);
}

function buildGridCell(config, weekMonday, row, col, today, todayKey, valueByDate, gradientRange) {
  const date = addDays(weekMonday, row);
  const dateKey = toDateKey(date);
  const value = valueByDate.get(dateKey);
  const isEmpty = value === void 0 || date > today;
  return Object.freeze({
    col,
    row: row + 2,
    dateKey,
    isEmpty,
    isToday: dateKey === todayKey,
    color: isEmpty ? null : colorForValue(config, value, gradientRange),
    displayText: !isEmpty && config.showNumbers ? formatCellValue(config, value) : "",
    title: isEmpty ? dateKey : `${dateKey}: ${formatCellValue(config, value)}`
  });
}

function buildGridCells(config, weeks, gridStart, today, valueByDate, gradientRange) {
  const todayKey = toDateKey(today);
  const cells = [];
  for (let week = 0; week < weeks; week++) {
    const weekMonday = addDays(gridStart, week * 7);
    const col = week + 2;
    for (let row = 0; row < 7; row++) {
      cells.push(buildGridCell(config, weekMonday, row, col, today, todayKey, valueByDate, gradientRange));
    }
  }
  return Object.freeze(cells);
}

function buildStatsViewModel(config, currentAvg, prevAvg) {
  const valueText = currentAvg === null ? "–" : `${formatStatValue(config, currentAvg)}${config.unit ? " " + config.unit : ""}`;
  if (currentAvg === null || prevAvg === null || prevAvg === 0) {
    return { valueText, change: null };
  }
  const percent = (currentAvg - prevAvg) / prevAvg * 100;
  return {
    valueText,
    change: {
      direction: percent >= 0 ? "up" : "down",
      text: `${percent >= 0 ? "+" : ""}${Math.round(percent)}%`
    }
  };
}

function buildInputViewModel(config, existingToday) {
  if (config.type === "time") {
    return {
      type: "text",
      step: null,
      min: null,
      max: null,
      placeholder: "e.g. 1h30, 45m, 3m05",
      value: existingToday !== void 0 ? formatDuration(existingToday) : "",
      unit: config.unit
    };
  }
  return {
    type: "number",
    step: config.type === "int" ? "1" : "0.01",
    min: String(config.min),
    max: String(config.max),
    placeholder: existingToday !== void 0 ? "" : "–",
    value: existingToday !== void 0 ? String(existingToday) : "",
    unit: config.unit
  };
}

function buildCardViewModel(config, entries, currentAvg, prevAvg, today, weeksToShow, gradientRange) {
  const valueByDate = new Map(entries.map((entry) => [entry.date, entry.value]));
  const gridStart = addDays(mondayOf(today), -(weeksToShow - 1) * 7);
  const existingToday = valueByDate.get(toDateKey(today));
  return Object.freeze({
    header: Object.freeze({ icon: config.icon, title: config.title }),
    grid: Object.freeze({
      weeks: weeksToShow,
      year: String(today.getFullYear()),
      weekdayLabels: WEEKDAY_LABELS,
      monthGroups: buildMonthGroups(weeksToShow, gridStart),
      cells: buildGridCells(config, weeksToShow, gridStart, today, valueByDate, gradientRange)
    }),
    stats: Object.freeze(buildStatsViewModel(config, currentAvg, prevAvg)),
    input: Object.freeze(buildInputViewModel(config, existingToday))
  });
}

// ---- DOM render functions (impure) — apply a view model, one section each ----

function renderHeader(cardEl, header) {
  const headerEl = cardEl.createDiv({ cls: "cht-header" });
  const iconEl = headerEl.createSpan({ cls: "cht-icon" });
  obsidian.setIcon(iconEl, header.icon);
  headerEl.createSpan({ cls: "cht-title", text: header.title });
}

function renderGrid(cardEl, grid) {
  const gridEl = cardEl.createDiv({ cls: "cht-grid" });
  gridEl.style.gridTemplateColumns = `auto repeat(${grid.weeks}, var(--cht-cell-size))`;
  const yearLabel = gridEl.createDiv({ cls: "cht-year-label", text: grid.year });
  yearLabel.style.gridColumn = "1";
  yearLabel.style.gridRow = "1";
  grid.weekdayLabels.forEach((label, row) => {
    const weekdayEl = gridEl.createDiv({ cls: "cht-weekday-label", text: label });
    weekdayEl.style.gridColumn = "1";
    weekdayEl.style.gridRow = String(row + 2);
  });
  for (const group of grid.monthGroups) {
    const labelEl = gridEl.createDiv({ cls: "cht-month-label", text: group.label });
    labelEl.style.gridColumn = `${group.startCol} / ${group.endCol}`;
    labelEl.style.gridRow = "1";
  }
  for (const cell of grid.cells) {
    const cellEl = gridEl.createDiv({ cls: "cht-cell" });
    cellEl.style.gridColumn = String(cell.col);
    cellEl.style.gridRow = String(cell.row);
    cellEl.setAttr("title", cell.title);
    if (cell.isEmpty) {
      cellEl.addClass("cht-cell--empty");
    } else {
      cellEl.style.backgroundColor = cell.color;
      if (cell.displayText) cellEl.setText(cell.displayText);
    }
    if (cell.isToday) cellEl.addClass("cht-cell--today");
  }
}

function renderStats(cardEl, stats) {
  const statsEl = cardEl.createDiv({ cls: "cht-stats" });
  statsEl.createSpan({ cls: "cht-stats-value", text: stats.valueText });
  if (!stats.change) return;
  statsEl.createSpan({ cls: "cht-stats-sep", text: " | " });
  statsEl.createSpan({
    cls: `cht-stats-pct cht-stats-pct--${stats.change.direction}`,
    text: stats.change.text
  });
}

function renderInputRow(cardEl, input, config, { onValidCommit }) {
  const rowEl = cardEl.createDiv({ cls: "cht-input-row" });
  rowEl.createSpan({ cls: "cht-input-label", text: "Today" });
  const inputEl = rowEl.createEl("input", { cls: "cht-input" });
  inputEl.type = input.type;
  if (input.step !== null) inputEl.step = input.step;
  if (input.min !== null) inputEl.min = input.min;
  if (input.max !== null) inputEl.max = input.max;
  inputEl.placeholder = input.placeholder;
  inputEl.value = input.value;
  if (input.unit) rowEl.createSpan({ cls: "cht-input-unit", text: input.unit });
  const commit = () => {
    if (inputEl.value === "") return;
    const result = coerceValue(config, inputEl.value);
    if (!result.ok) {
      inputEl.addClass("cht-input--invalid");
      inputEl.setAttr("title", result.reason);
      return;
    }
    onValidCommit(result.value);
  };
  inputEl.addEventListener("input", () => {
    inputEl.removeClass("cht-input--invalid");
    inputEl.removeAttribute("title");
  });
  inputEl.addEventListener("change", commit);
  inputEl.addEventListener("keydown", (evt) => {
    evt.stopPropagation();
    if (evt.key === "Enter") {
      evt.preventDefault();
      commit();
    }
  });
  inputEl.addEventListener("keyup", (evt) => evt.stopPropagation());
  inputEl.addEventListener("keypress", (evt) => evt.stopPropagation());
  inputEl.addEventListener("mousedown", (evt) => evt.stopPropagation());
  inputEl.addEventListener("click", (evt) => evt.stopPropagation());
}

function renderCard(cardEl, viewModel, config, callbacks) {
  cardEl.empty();
  cardEl.addClass("cht-card");
  renderHeader(cardEl, viewModel.header);
  renderGrid(cardEl, viewModel.grid);
  renderStats(cardEl, viewModel.stats);
  renderInputRow(cardEl, viewModel.input, config, callbacks);
}

// ---- Store (pure functional core over immutable JSON data) ----
// Shape: { entries: { [trackerId]: { [dateKey]: value } } }. Every function
// here either reads a store value or returns a brand new frozen one — none
// of them mutate the store passed in.

function createEmptyStore() {
  return Object.freeze({ entries: {} });
}

function normalizeStore(raw) {
  if (!raw || typeof raw.entries !== "object" || raw.entries === null) return createEmptyStore();
  return Object.freeze({ entries: raw.entries });
}

function upsertEntry(store, trackerId, date, value) {
  const trackerEntries = Object.freeze({ ...store.entries[trackerId], [date]: value });
  return Object.freeze({ entries: Object.freeze({ ...store.entries, [trackerId]: trackerEntries }) });
}

function getEntries(store, trackerId, startDate, endDate) {
  const trackerEntries = store.entries[trackerId] ?? {};
  return Object.keys(trackerEntries).filter((date) => date >= startDate && date <= endDate).sort().map((date) => ({ date, value: trackerEntries[date] }));
}

function averageInRange(store, trackerId, startDate, endDate) {
  const values = getEntries(store, trackerId, startDate, endDate).map((entry) => entry.value);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getMinMax(store, trackerId) {
  const values = Object.values(store.entries[trackerId] ?? {});
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

// ---- TrackerCard factory — owns one card's DOM lifecycle ----

function needsMinMaxLookup(config) {
  return config.colorMode === "gradient" && config.egradient && !config.fgradient;
}

function resolveGradientRange(config, minMax) {
  return minMax ?? { min: config.min, max: config.max };
}

function createTrackerCard(cardEl, config, plugin) {
  let resizeObserver = null;
  let resizeTimeoutId = null;
  let lastWeeksShown = 0;
  function computeWeeksToShow() {
    const cap = config.weeks;
    const available = cardEl.getBoundingClientRect().width;
    if (!available) return Math.min(cap, DEFAULT_WEEKS_CAP, 9);
    const usable = available - LABEL_COLUMN_WIDTH - CARD_PADDING;
    const fit = Math.floor(usable / (CELL_SIZE + CELL_GAP));
    return Math.max(MIN_WEEKS, Math.min(cap, fit));
  }
  function fetchCardData(today, weeks) {
    const todayKey = toDateKey(today);
    const currentMonday = mondayOf(today);
    const gridStart = addDays(currentMonday, -(weeks - 1) * 7);
    const gridEnd = addDays(currentMonday, 6);
    const entries = getEntries(plugin.store, config.id, toDateKey(gridStart), toDateKey(gridEnd));
    const currentAvg = averageInRange(plugin.store, config.id, toDateKey(gridStart), todayKey);
    const windowDays = Math.round((today.getTime() - gridStart.getTime()) / 864e5) + 1;
    const prevEnd = addDays(gridStart, -1);
    const prevStart = addDays(prevEnd, -(windowDays - 1));
    const prevAvg = averageInRange(plugin.store, config.id, toDateKey(prevStart), toDateKey(prevEnd));
    const gradientRange = resolveGradientRange(
      config,
      needsMinMaxLookup(config) ? getMinMax(plugin.store, config.id) : null
    );
    return { entries, currentAvg, prevAvg, gradientRange };
  }
  function handleCommit(value) {
    const todayKey = toDateKey(startOfDay(/* @__PURE__ */ new Date()));
    plugin.commitEntry(config.id, todayKey, value);
    renderNow();
  }
  function renderNow() {
    const weeks = computeWeeksToShow();
    lastWeeksShown = weeks;
    const today = startOfDay(/* @__PURE__ */ new Date());
    const { entries, currentAvg, prevAvg, gradientRange } = fetchCardData(today, weeks);
    const viewModel = buildCardViewModel(config, entries, currentAvg, prevAvg, today, weeks, gradientRange);
    renderCard(cardEl, viewModel, config, { onValidCommit: handleCommit });
  }
  function scheduleResize() {
    if (resizeTimeoutId !== null) window.clearTimeout(resizeTimeoutId);
    resizeTimeoutId = window.setTimeout(() => {
      resizeTimeoutId = null;
      if (computeWeeksToShow() !== lastWeeksShown) renderNow();
    }, RESIZE_DEBOUNCE_MS);
  }
  function mount() {
    resizeObserver = new ResizeObserver(() => scheduleResize());
    resizeObserver.observe(cardEl);
    renderNow();
  }
  function destroy() {
    resizeObserver?.disconnect();
    if (resizeTimeoutId !== null) window.clearTimeout(resizeTimeoutId);
    resizeObserver = null;
    resizeTimeoutId = null;
  }
  return Object.freeze({ mount, destroy });
}

// ---- HeatmapWidget (must extend MarkdownRenderChild — Obsidian API) ----

class HeatmapWidget extends obsidian.MarkdownRenderChild {
  constructor(containerEl, configs, plugin) {
    super(containerEl);
    this.configs = configs;
    this.plugin = plugin;
    this.cards = [];
  }
  onload() {
    this.containerEl.empty();
    if (this.configs.length === 1) {
      this.cards = [createTrackerCard(this.containerEl, this.configs[0], this.plugin)];
    } else {
      this.containerEl.addClass("cht-row");
      this.cards = this.configs.map((config) => {
        const cardEl = this.containerEl.createDiv();
        return createTrackerCard(cardEl, config, this.plugin);
      });
    }
    for (const card of this.cards) card.mount();
  }
  onunload() {
    for (const card of this.cards) card.destroy();
  }
}

// ---- CalendarHeatmapPlugin (must extend Plugin — Obsidian API) ----

class CalendarHeatmapPlugin extends obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.store = createEmptyStore();
    this.saveTimeoutId = null;
  }
  async onload() {
    this.store = normalizeStore(await this.loadData());
    this.registerMarkdownCodeBlockProcessor("calendar-heatmap", (source, el, ctx) => {
      try {
        const configs = parseTrackerConfigs(source);
        const widget = new HeatmapWidget(el, configs, this);
        ctx.addChild(widget);
      } catch (err) {
        el.createDiv({ cls: "cht-error", text: `Calendar heatmap error: ${err.message}` });
      }
    });
  }
  async onunload() {
    if (this.saveTimeoutId !== null) {
      window.clearTimeout(this.saveTimeoutId);
      this.saveTimeoutId = null;
    }
    await this.saveData(this.store);
  }
  requestSave() {
    if (this.saveTimeoutId !== null) window.clearTimeout(this.saveTimeoutId);
    this.saveTimeoutId = window.setTimeout(() => {
      this.saveTimeoutId = null;
      void this.saveData(this.store);
    }, SAVE_DEBOUNCE_MS);
  }
  commitEntry(trackerId, date, value) {
    this.store = upsertEntry(this.store, trackerId, date, value);
    this.requestSave();
  }
}

module.exports = CalendarHeatmapPlugin;
