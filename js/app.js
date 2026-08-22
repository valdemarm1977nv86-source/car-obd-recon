import { ObdLink } from "./obd.js";
import { PID_LIST, GAUGE_PIDS, CARD_PIDS, byName, decodePidResponse, decodeReadiness, parseDtcBytes } from "./pids.js";
import { describeDtc } from "./dtc-db.js";
import { saveScan, getHistory, getScan, deleteScan, clearHistory } from "./storage.js";
import { downloadReport, shareReport } from "./report.js";
import { getBrands, getModelsForBrand, getPackNames, getProfileGroups, getPackGroups } from "./kia-pids.js";
import { logEvent, getAppLogText } from "./applog.js";

const $ = (id) => document.getElementById(id);
const obd = new ObdLink();

// ── Постоянный журнал приложения (переживает закрытие/краш, см. applog.js) ──
logEvent("app-start", navigator.userAgent);
window.addEventListener("error", (e) => logEvent("js-error", `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => logEvent("promise-error", (e.reason && e.reason.message) || String(e.reason)));

const state = {
  connected: false,
  live: {},        // name -> { value, label, unit, verdict }
  spark: {},        // name -> number[]
  lastDtc: [],       // [{code, desc}]
  lastFreeze: null,
  lastReadiness: null,
  lastVin: null,
  lastMode6: [],
  pollActive: false,
  pollGen: 0,
  pollPaused: false,
  adapterInfo: null,
  supportedPids: new Set(),
};

// ── Тосты ─────────────────────────────────────────────────────────────────
function toast(msg, kind = "") {
  const host = $("toast-host");
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ── Тема (светлая/тёмная) ────────────────────────────────────────────────
const THEME_KEY = "obd-theme";
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("btn-theme").textContent = theme === "light" ? "🌙" : "☀️";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#eef2f7" : "#070b14");
}
function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || "dark");
  $("btn-theme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}
initTheme();

// ── Настройки: масштаб / яркость / не гасить экран ───────────────────────
const SCALE_KEY = "obd-ui-scale", BRIGHTNESS_KEY = "obd-ui-brightness", WAKELOCK_KEY = "obd-wakelock";
let wakeLock = null;

function applyScale(scale) {
  document.documentElement.style.setProperty("--ui-zoom", scale);
  $("scale-value").textContent = Math.round(scale * 100) + "%";
}
function applyBrightness(pct) {
  $("brightness-overlay").style.opacity = String(Math.max(0, (100 - pct) / 100 * 0.65));
}
async function setWakeLock(on) {
  try {
    if (on && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* API недоступен (не Chrome/Android) или вкладка не видна — не критично */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && localStorage.getItem(WAKELOCK_KEY) === "1") setWakeLock(true);
});

function initSettings() {
  let scale = parseFloat(localStorage.getItem(SCALE_KEY)) || 1;
  applyScale(scale);
  let brightness = parseInt(localStorage.getItem(BRIGHTNESS_KEY), 10);
  if (!Number.isFinite(brightness)) brightness = 100;
  $("brightness-range").value = brightness;
  applyBrightness(brightness);
  const wakeOn = localStorage.getItem(WAKELOCK_KEY) === "1";
  $("wakelock-toggle").checked = wakeOn;
  if (wakeOn) setWakeLock(true);

  $("btn-settings").addEventListener("click", () => { $("settings-overlay").hidden = false; });
  $("settings-close").addEventListener("click", () => { $("settings-overlay").hidden = true; });
  $("settings-overlay").addEventListener("click", (e) => { if (e.target.id === "settings-overlay") $("settings-overlay").hidden = true; });

  $("scale-down").addEventListener("click", () => {
    scale = Math.max(0.85, Math.round((scale - 0.05) * 100) / 100);
    localStorage.setItem(SCALE_KEY, scale);
    applyScale(scale);
  });
  $("scale-up").addEventListener("click", () => {
    scale = Math.min(1.3, Math.round((scale + 0.05) * 100) / 100);
    localStorage.setItem(SCALE_KEY, scale);
    applyScale(scale);
  });

  $("brightness-range").addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10);
    localStorage.setItem(BRIGHTNESS_KEY, v);
    applyBrightness(v);
  });

  $("wakelock-toggle").addEventListener("change", async (e) => {
    localStorage.setItem(WAKELOCK_KEY, e.target.checked ? "1" : "0");
    await setWakeLock(e.target.checked);
  });

  $("btn-reset-cache").addEventListener("click", async () => {
    const ok = await confirmModal("Сбросить кэш приложения?", "Приложение перезагрузится и заново скачает файлы. История сканирований не удаляется.");
    if (!ok) return;
    try {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    } catch { /* сервис-воркер недоступен — просто перезагрузим */ }
    location.reload();
  });
}
initSettings();

// ── Модалка подтверждения ────────────────────────────────────────────────
function confirmModal(title, text) {
  return new Promise((resolve) => {
    const overlay = $("modal-overlay");
    $("modal-title").textContent = title;
    $("modal-text").textContent = text;
    overlay.hidden = false;
    const onYes = () => { cleanup(); resolve(true); };
    const onNo = () => { cleanup(); resolve(false); };
    function cleanup() {
      overlay.hidden = true;
      $("modal-yes").removeEventListener("click", onYes);
      $("modal-no").removeEventListener("click", onNo);
    }
    $("modal-yes").addEventListener("click", onYes);
    $("modal-no").addEventListener("click", onNo);
  });
}

// ── Список выбора снизу (bottom sheet) — марка/модель/пакет ──────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function openPicker(title, items, currentValue) {
  return new Promise((resolve) => {
    const overlay = $("picker-overlay");
    const list = $("picker-list");
    const search = $("picker-search");
    $("picker-title").textContent = title;
    search.value = "";

    function render(filter) {
      const q = (filter || "").trim().toLowerCase();
      const shown = q ? items.filter((it) => it.toLowerCase().includes(q)) : items;
      list.innerHTML = shown.length
        ? shown.map((it) => `<button type="button" class="picker-item${it === currentValue ? " selected" : ""}" data-value="${escapeHtml(it)}">${escapeHtml(it)}</button>`).join("")
        : `<div class="hint" style="padding:16px;text-align:center">Ничего не найдено</div>`;
    }
    render("");

    function onInput() { render(search.value); }
    function onListClick(e) {
      const btn = e.target.closest(".picker-item");
      if (!btn) return;
      cleanup();
      resolve(btn.dataset.value);
    }
    function onClose() { cleanup(); resolve(null); }
    function onOverlayClick(e) { if (e.target === overlay) onClose(); }
    function cleanup() {
      overlay.hidden = true;
      search.removeEventListener("input", onInput);
      list.removeEventListener("click", onListClick);
      $("picker-close").removeEventListener("click", onClose);
      overlay.removeEventListener("click", onOverlayClick);
    }

    search.addEventListener("input", onInput);
    list.addEventListener("click", onListClick);
    $("picker-close").addEventListener("click", onClose);
    overlay.addEventListener("click", onOverlayClick);
    overlay.hidden = false;
    search.focus();
  });
}

// ── Навигация по экранам ─────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.id === "screen-" + id));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.screen === id));
}
document.querySelectorAll(".nav-btn").forEach(b => {
  b.addEventListener("click", () => showScreen(b.dataset.screen));
});

// ── Подключение ───────────────────────────────────────────────────────────
function setConnUi(mode) {
  const dot = $("conn-dot");
  const statusText = $("conn-status-text");
  const btnConnect = $("btn-connect");
  const btnDisconnect = $("btn-disconnect");
  dot.className = "dot" + (mode === "connected" ? " connected" : mode === "connecting" ? " connecting" : "");
  if (mode === "connected") {
    statusText.textContent = obd.deviceName;
    btnConnect.style.display = "none";
    btnDisconnect.style.display = "";
  } else if (mode === "connecting") {
    statusText.textContent = "Подключение…";
    btnConnect.disabled = true;
  } else {
    statusText.textContent = "Не подключено";
    btnConnect.style.display = "";
    btnConnect.disabled = false;
    btnDisconnect.style.display = "none";
  }
}

$("btn-connect").addEventListener("click", async () => {
  setConnUi("connecting");
  try {
    const name = await obd.connect();
    state.connected = true;
    setConnUi("connected");
    toast(`Подключено: ${name}`, "ok");
    logEvent("ble-connect", name);
    buildDashboard();
    startPolling();

    obd.getAdapterInfo().then((info) => {
      state.adapterInfo = info;
      const el = $("adapter-info");
      if (el) el.textContent = [info.version, info.voltage].filter(Boolean).join(" · ");
    }).catch(() => {});
    obd.detectSupportedPids().then((set) => {
      state.supportedPids = set;
      if (set.size) toast(`Определено поддерживаемых параметров: ${set.size}`, "ok");
    }).catch(() => {});
  } catch (e) {
    setConnUi("idle");
    toast(e.message || "Не удалось подключиться", "err");
    logEvent("ble-connect-error", e.message || String(e));
  }
});

$("btn-disconnect").addEventListener("click", () => {
  obd.disconnect();
  logEvent("ble-disconnect-manual");
});

obd.onDisconnect = () => {
  state.connected = false;
  state.pollActive = false;
  setConnUi("idle");
  toast("Соединение потеряно", "err");
  logEvent("ble-disconnect-lost");
};

// ── Дуговой SVG-датчик ────────────────────────────────────────────────────
function polar(angleDeg, r, cx, cy) {
  const rad = (angleDeg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}
function arcPath(fromDeg, toDeg, r, cx, cy) {
  const [x1, y1] = polar(fromDeg, r, cx, cy);
  const [x2, y2] = polar(toDeg, r, cx, cy);
  const large = (toDeg - fromDeg) > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}
const GAUGE_R = 48, GAUGE_CX = 60, GAUGE_CY = 65, START = -225, SWEEP = 270;

const VERDICT_COLOR = { ok: "#4ade80", warn: "#fb923c", crit: "#ef4444", info: "#60a5fa", neutral: "#22d3ee" };
const VERDICT_LABEL = { ok: "Норма", warn: "Внимание", crit: "Критично", info: "Инфо", neutral: "" };

function gaugeSvg(name, def) {
  const track = arcPath(START, START + SWEEP, GAUGE_R, GAUGE_CX, GAUGE_CY);
  return `
    <svg viewBox="0 0 120 130">
      <path d="${track}" fill="none" stroke="#1e293b" stroke-width="9" stroke-linecap="round"/>
      <path id="fill-${name}" d="" fill="none" stroke="${VERDICT_COLOR.neutral}" stroke-width="9" stroke-linecap="round"/>
      <text id="val-${name}" x="60" y="70" text-anchor="middle" font-size="18" font-weight="bold" fill="white" font-family="monospace">—</text>
      <text x="60" y="85" text-anchor="middle" font-size="9" fill="#64748b">${def.unit}</text>
    </svg>
    <div class="gauge-label">${def.label}</div>
    <span id="badge-${name}" class="gauge-badge" style="display:none"></span>
    <svg class="sparkline" id="spark-${name}" viewBox="0 0 100 30" preserveAspectRatio="none" style="display:none"></svg>
  `;
}

function updateGauge(name, value, verdict, note) {
  const def = byName(name);
  const fillPath = $("fill-" + name);
  const valText = $("val-" + name);
  const badge = $("badge-" + name);
  if (!fillPath) return;

  if (value == null) {
    valText.textContent = "—";
    fillPath.setAttribute("d", "");
    badge.style.display = "none";
    return;
  }
  const clamped = Math.min(Math.max(value, def.min), def.max);
  const pct = (clamped - def.min) / (def.max - def.min);
  const endAngle = START + SWEEP * pct;
  const color = verdict ? (VERDICT_COLOR[verdict] || VERDICT_COLOR.neutral) : VERDICT_COLOR.neutral;
  fillPath.setAttribute("stroke", color);
  fillPath.setAttribute("d", pct > 0.004 ? arcPath(START, endAngle, GAUGE_R, GAUGE_CX, GAUGE_CY) : "");
  valText.textContent = Number.isInteger(value) ? value : value.toFixed(1);

  if (verdict && verdict !== "neutral" && VERDICT_LABEL[verdict]) {
    badge.style.display = "";
    badge.className = "gauge-badge badge-" + verdict;
    badge.textContent = VERDICT_LABEL[verdict];
    badge.title = note || "";
  } else {
    badge.style.display = "none";
  }
}

function updateSparkline(name, arr) {
  const svg = $("spark-" + name);
  if (!svg || arr.length < 2) return;
  svg.style.display = "";
  const min = Math.min(...arr), max = Math.max(...arr);
  const span = (max - min) || 1;
  const pts = arr.map((v, i) => {
    const x = (i / (arr.length - 1)) * 100;
    const y = 28 - ((v - min) / span) * 26;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  svg.innerHTML = `<polyline points="${pts}" fill="none" stroke="#22d3ee" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>`;
}

function metricCardHtml(name, def) {
  return `
    <div class="glass metric-card" id="card-${name}">
      <div class="m-label">${def.label}</div>
      <div class="m-value dash" id="mval-${name}">— <span class="unit">${def.unit}</span></div>
      <span id="mbadge-${name}" class="gauge-badge" style="display:none"></span>
    </div>
  `;
}

function updateMetricCard(name, value, verdict, note) {
  const el = $("mval-" + name);
  const badge = $("mbadge-" + name);
  if (!el) return;
  const def = byName(name);
  if (value == null) {
    el.className = "m-value dash";
    el.innerHTML = `— <span class="unit">${def.unit}</span>`;
    if (badge) badge.style.display = "none";
    return;
  }
  el.className = "m-value";
  el.innerHTML = `${Number.isInteger(value) ? value : value.toFixed(1)} <span class="unit">${def.unit}</span>`;
  if (badge && verdict && VERDICT_LABEL[verdict]) {
    badge.style.display = "";
    badge.className = "gauge-badge badge-" + verdict;
    badge.textContent = VERDICT_LABEL[verdict];
    badge.title = note || "";
  } else if (badge) {
    badge.style.display = "none";
  }
}

const SPARK_PIDS = ["RPM", "SPEED", "COOLANT_TEMP", "ENGINE_LOAD"];

function buildDashboard() {
  const gaugeHtml = GAUGE_PIDS.map(name => {
    const def = byName(name);
    return `<div class="glass gauge-card">${gaugeSvg(name, def)}</div>`;
  }).join("");
  const cardHtml = CARD_PIDS.map(name => metricCardHtml(name, byName(name))).join("");

  $("dashboard-content").innerHTML = `
    <div class="hint mb8" id="adapter-info">Определяю адаптер…</div>
    <div class="section-title">Основные параметры</div>
    <div class="gauge-grid">${gaugeHtml}</div>
    <div class="section-title">Остальные параметры</div>
    <div class="metric-grid">${cardHtml}</div>
    <div class="row mt16" style="justify-content:center">
      <button class="btn primary" id="btn-save-report">Сохранить отчёт</button>
    </div>
  `;
  SPARK_PIDS.forEach(n => { state.spark[n] = []; });
  $("btn-save-report").addEventListener("click", saveCurrentReport);
}

function saveCurrentReport() {
  const id = saveScan({
    deviceName: obd.deviceName,
    liveParams: state.live,
    dtcCodes: state.lastDtc,
    vin: state.lastVin,
  });
  toast("Отчёт сохранён в историю", "ok");
}

// ── Опрос параметров (poll loop) ─────────────────────────────────────────
let extraIdx = 0;

async function pollOnce() {
  if (state.pollPaused) return; // заводские параметры Kia временно меняют адрес ECU
  for (const name of GAUGE_PIDS) {
    if (state.pollPaused) return;
    await pollOne(name);
  }
  if (CARD_PIDS.length && !state.pollPaused) {
    const name = CARD_PIDS[extraIdx % CARD_PIDS.length];
    extraIdx++;
    await pollOne(name);
  }
}

async function pollOne(name) {
  const def = byName(name);
  if (state.supportedPids.size && !state.supportedPids.has(def.pid)) {
    state.live[name] = { value: null, label: def.label, unit: def.unit, verdict: null };
    return; // машина сама сказала, что этого параметра у неё нет — не тратим время на запрос
  }
  try {
    const bytes = await obd.requestPid("01", def.pid);
    const value = bytes ? decodePidResponse(def, bytes) : null;
    const verdict = value != null && def.verdict ? def.verdict(value) : null;
    const note = value != null && def.note ? def.note(value) : null;
    state.live[name] = { value, label: def.label, unit: def.unit, verdict };
    if (GAUGE_PIDS.includes(name)) {
      updateGauge(name, value, verdict, note);
      if (SPARK_PIDS.includes(name) && value != null) {
        const arr = state.spark[name] || (state.spark[name] = []);
        arr.push(value);
        if (arr.length > 30) arr.shift();
        updateSparkline(name, arr);
      }
    } else {
      updateMetricCard(name, value, verdict, note);
    }
  } catch {
    // тихо пропускаем — следующий тик попробует снова
  }
}

async function startPolling() {
  const gen = ++state.pollGen;
  state.pollActive = true;
  while (state.connected && state.pollGen === gen) {
    await pollOnce();
    await new Promise(r => setTimeout(r, 60));
  }
  state.pollActive = false;
}

// ── DTC (подтверждённые Mode 03 / ожидающие Mode 07 / постоянные Mode 0A) ──
const DTC_MODES = {
  confirmed: { cmd: "03", echo: "43", label: "Подтверждённые", clearable: true },
  pending: { cmd: "07", echo: "47", label: "Ожидающие", clearable: false },
  permanent: { cmd: "0A", echo: "4A", label: "Постоянные", clearable: false },
};
let dtcMode = "confirmed";

function renderDtcList(codes) {
  const host = $("dtc-list");
  const modeInfo = DTC_MODES[dtcMode];
  const canClear = modeInfo.clearable && codes.length > 0;
  $("btn-clear-dtc").disabled = !canClear;
  $("btn-clear-dtc").style.display = modeInfo.clearable ? "" : "none";

  if (!codes.length) {
    host.innerHTML = `<div class="empty-state glass"><div class="icon">✅</div><div class="title">Ошибок нет (${modeInfo.label.toLowerCase()})</div></div>`;
    return;
  }
  host.innerHTML = `
    ${dtcMode === "permanent" ? `<div class="hint mb8">Постоянные коды нельзя сбросить кнопкой — они пропадают сами после того, как связанная проверка пройдёт успешно несколько циклов поездки.</div>` : ""}
    ${codes.map(c => `
      <div class="glass dtc-item">
        <div class="dtc-code">${c.code}</div>
        <div class="dtc-desc">${c.desc}</div>
      </div>
    `).join("")}`;
}

async function loadDtc(mode) {
  if (!state.connected) { toast("Сначала подключитесь к сканеру", "err"); return; }
  dtcMode = mode;
  document.querySelectorAll(".dtc-mode-btn").forEach(b => b.classList.toggle("primary", b.dataset.dtcMode === mode));
  const modeInfo = DTC_MODES[mode];
  $("dtc-list").innerHTML = `<div class="hint">Считываю…</div>`;
  try {
    const resp = await obd.sendCommand(modeInfo.cmd);
    const hex = resp.replace(/\s+/g, "").toUpperCase();
    let codes = [];
    if (!/NO ?DATA|UNABLE|STOPPED|ERROR|\?/i.test(hex)) {
      const bodyIdx = hex.indexOf(modeInfo.echo);
      const body = bodyIdx >= 0 ? hex.slice(bodyIdx + modeInfo.echo.length) : hex;
      const bytes = [];
      for (let i = 0; i + 1 < body.length; i += 2) {
        const b = parseInt(body.slice(i, i + 2), 16);
        if (Number.isNaN(b)) break;
        bytes.push(b);
      }
      codes = parseDtcBytes(bytes).map(code => ({ code, desc: describeDtc(code) }));
    }
    if (mode === "confirmed") state.lastDtc = codes;
    renderDtcList(codes);
    toast(`${modeInfo.label}: ${codes.length}`, codes.length ? "" : "ok");
  } catch (e) {
    $("dtc-list").innerHTML = `<div class="hint" style="color:#fca5a5">${e.message || "Ошибка чтения"}</div>`;
  }
}

document.querySelectorAll(".dtc-mode-btn").forEach(b => {
  b.addEventListener("click", () => loadDtc(b.dataset.dtcMode));
});

$("btn-clear-dtc").addEventListener("click", async () => {
  const ok = await confirmModal("Сбросить коды ошибок?", "Это также сбросит адаптированные значения (топливные коррекции и т.д.) в блоке управления. Действие необратимо.");
  if (!ok) return;
  try {
    await obd.sendCommand("04");
    state.lastDtc = [];
    if (dtcMode === "confirmed") renderDtcList([]);
    toast("Коды ошибок сброшены", "ok");
  } catch (e) {
    toast(e.message || "Не удалось сбросить коды", "err");
  }
});

// ── Freeze Frame ─────────────────────────────────────────────────────────
$("btn-read-freeze").addEventListener("click", async () => {
  if (!state.connected) { toast("Сначала подключитесь к сканеру", "err"); return; }
  $("btn-read-freeze").disabled = true;
  const host = $("freeze-content");
  host.innerHTML = `<div class="hint">Считываю…</div>`;
  try {
    let dtcCode = null;
    try {
      const bytes = await obd.requestPid("02", "02");
      if (bytes) { const codes = parseDtcBytes(bytes); dtcCode = codes[0] || null; }
    } catch { /* нет данных */ }

    const rows = [];
    for (const def of PID_LIST) {
      try {
        const bytes = await obd.requestPid("02", def.pid);
        const value = bytes ? decodePidResponse(def, bytes) : null;
        if (value != null) rows.push({ label: def.label, unit: def.unit, value });
      } catch { /* пропуск */ }
    }

    if (!rows.length) {
      host.innerHTML = `<div class="empty-state glass"><div class="icon">🧊</div><div class="title">Нет данных Freeze Frame</div><div class="sub">Ошибок не было, либо адаптер их не сохранил</div></div>`;
    } else {
      host.innerHTML = `
        ${dtcCode ? `<div class="glass panel mb8"><div class="section-title" style="margin-top:0">Код, вызвавший сохранение</div><div class="dtc-code">${dtcCode}</div><div class="dtc-desc">${describeDtc(dtcCode)}</div></div>` : ""}
        <div class="metric-grid">
          ${rows.map(r => `<div class="glass metric-card"><div class="m-label">${r.label}</div><div class="m-value">${Number.isInteger(r.value) ? r.value : r.value.toFixed(1)} <span class="unit">${r.unit}</span></div></div>`).join("")}
        </div>`;
    }
    state.lastFreeze = { dtcCode, rows };
  } catch (e) {
    host.innerHTML = `<div class="hint" style="color:#fca5a5">${e.message || "Ошибка чтения"}</div>`;
  } finally {
    $("btn-read-freeze").disabled = false;
  }
});

// ── Mode 06 ──────────────────────────────────────────────────────────────
$("btn-read-mode6").addEventListener("click", async () => {
  if (!state.connected) { toast("Сначала подключитесь к сканеру", "err"); return; }
  $("btn-read-mode6").disabled = true;
  const host = $("mode6-content");
  host.innerHTML = `<div class="hint">Считываю…</div>`;
  try {
    const results = [];
    for (let mid = 1; mid <= 8; mid++) {
      const midHex = mid.toString(16).padStart(2, "0").toUpperCase();
      try {
        const resp = await obd.sendCommand("06" + midHex);
        const hex = resp.replace(/\s+/g, "").toUpperCase();
        if (hex && !/NO ?DATA|UNABLE|STOPPED|\?/i.test(hex)) {
          results.push({ mid: "01" + midHex, raw: hex });
        }
      } catch { /* пропуск MID */ }
    }
    state.lastMode6 = results;
    if (!results.length) {
      host.innerHTML = `<div class="empty-state glass"><div class="icon">🔧</div><div class="title">Нет данных Mode 06</div><div class="sub">Не поддерживается адаптером/автомобилем</div></div>`;
    } else {
      host.innerHTML = `
        <div class="hint mb8">⚠ Сырые данные тестов компонентов — расшифровка единиц измерения зависит от производителя и здесь не выполняется.</div>
        ${results.map(r => `<div class="glass dtc-item"><div class="dtc-code" style="color:var(--info)">${r.mid}</div><div class="dtc-desc mono">${r.raw}</div></div>`).join("")}
      `;
    }
  } catch (e) {
    host.innerHTML = `<div class="hint" style="color:#fca5a5">${e.message || "Ошибка чтения"}</div>`;
  } finally {
    $("btn-read-mode6").disabled = false;
  }
});

// ── VIN ──────────────────────────────────────────────────────────────────
$("btn-read-vin").addEventListener("click", async () => {
  if (!state.connected) { toast("Сначала подключитесь к сканеру", "err"); return; }
  $("btn-read-vin").disabled = true;
  const host = $("vin-content");
  host.innerHTML = `<div class="hint">Считываю…</div>`;
  try {
    const resp = await obd.sendCommand("0902");
    const hex = resp.replace(/\s+/g, "").toUpperCase();
    const idx = hex.indexOf("4902");
    let body = idx >= 0 ? hex.slice(idx + 4) : hex;
    if (body.startsWith("01")) body = body.slice(2);
    let vin = "";
    for (let i = 0; i + 1 < body.length; i += 2) {
      const code = parseInt(body.slice(i, i + 2), 16);
      if (code >= 32 && code < 127) vin += String.fromCharCode(code);
    }
    vin = vin.trim();
    if (!vin) {
      host.innerHTML = `<div class="empty-state glass"><div class="icon">🚗</div><div class="title">VIN не считан</div><div class="sub">Автомобиль не вернул VIN — функция может не поддерживаться</div></div>`;
      state.lastVin = null;
      return;
    }
    let decoded = { vin };
    host.innerHTML = `<div class="glass panel"><div class="section-title" style="margin-top:0">VIN</div><div class="mono" style="font-size:16px;font-weight:700">${vin}</div><div class="hint mt8" id="vin-decode-status">Ищу расшифровку через NHTSA…</div></div>`;
    try {
      const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`);
      if (r.ok) {
        const data = await r.json();
        const fields = {};
        for (const item of (data.Results || [])) {
          if (item.Value && !["", "Not Applicable", "0"].includes(item.Value)) fields[item.Variable] = item.Value;
        }
        decoded = {
          vin,
          make: fields["Make"], model: fields["Model"], year: fields["Model Year"],
          engine: fields["Displacement (L)"], fuel: fields["Fuel Type - Primary"], country: fields["Plant Country"],
        };
        const statusEl = $("vin-decode-status");
        if (statusEl) {
          statusEl.outerHTML = `
            <div class="metric-grid mt12">
              ${decoded.make ? `<div class="glass metric-card"><div class="m-label">Марка/модель</div><div class="m-value">${decoded.make} ${decoded.model || ""}</div></div>` : ""}
              ${decoded.year ? `<div class="glass metric-card"><div class="m-label">Год</div><div class="m-value">${decoded.year}</div></div>` : ""}
              ${decoded.engine ? `<div class="glass metric-card"><div class="m-label">Двигатель</div><div class="m-value">${decoded.engine} л</div></div>` : ""}
              ${decoded.country ? `<div class="glass metric-card"><div class="m-label">Страна сборки</div><div class="m-value">${decoded.country}</div></div>` : ""}
            </div>`;
        }
      }
    } catch {
      const statusEl = $("vin-decode-status");
      if (statusEl) statusEl.textContent = "Нет интернета — расшифровка недоступна, VIN считан";
    }
    state.lastVin = decoded;
  } catch (e) {
    host.innerHTML = `<div class="hint" style="color:#fca5a5">${e.message || "Ошибка чтения VIN"}</div>`;
  } finally {
    $("btn-read-vin").disabled = false;
  }
});

// ── I/M Readiness ────────────────────────────────────────────────────────
async function readReadiness(pid, btnId, title) {
  if (!state.connected) { toast("Сначала подключитесь к сканеру", "err"); return; }
  $(btnId).disabled = true;
  const host = $("readiness-content");
  host.innerHTML = `<div class="hint">Считываю…</div>`;
  try {
    const bytes = await obd.requestPid("01", pid);
    const status = bytes ? decodeReadiness(bytes) : null;
    state.lastReadiness = status;
    if (!status) {
      host.innerHTML = `<div class="empty-state glass"><div class="icon">📋</div><div class="title">Нет данных</div></div>`;
      return;
    }
    host.innerHTML = `
      <div class="glass panel row between">
        <div>
          <div class="section-title" style="margin-top:0">${title}</div>
          <div style="font-size:16px;font-weight:700;color:${status.mil ? "var(--crit)" : "var(--ok)"}">MIL: ${status.mil ? "ГОРИТ" : "Выключен"}</div>
        </div>
        <div class="hint">Кодов ошибок: ${status.dtcCount}</div>
      </div>
      ${status.monitors.map(m => `
        <div class="glass dtc-item">
          <span class="gauge-badge ${m.complete ? "badge-ok" : "badge-warn"}" style="margin-top:2px">${m.complete ? "Готов" : "Не завершён"}</span>
          <div class="dtc-desc" style="padding-top:1px">${m.label}</div>
        </div>
      `).join("") || `<div class="hint">Нет доступных мониторов для этого автомобиля</div>`}
    `;
  } catch (e) {
    host.innerHTML = `<div class="hint" style="color:#fca5a5">${e.message || "Ошибка чтения"}</div>`;
  } finally {
    $(btnId).disabled = false;
  }
}
$("btn-read-readiness").addEventListener("click", () => readReadiness("01", "btn-read-readiness", "С момента сброса кодов"));
$("btn-read-readiness-cycle").addEventListener("click", () => readReadiness("41", "btn-read-readiness-cycle", "Текущий цикл движения"));

// ── Заводские параметры (любая марка, экспериментально, не Mode 01) ──────
// Данные из Car Scanner (см. LESSONS.md, 2026-08-21) — 337 моделей + 73 общих пакета
// протоколов, все формулы прошли компиляцию (не подобраны на глаз, см. kia-pids.js/formula.js).
const DEFAULT_MODEL = "Sorento XM 2.4 GDI"; // машина пользователя, см. PROJECT_CONTEXT.md

async function initFactoryPidsUI() {
  const brandSel = $("kia-brand"), modelSel = $("kia-model"), packSel = $("kia-pack");
  const brands = await getBrands();
  brandSel.innerHTML = brands.map((b) => `<option value="${b}">${b}</option>`).join("");
  const packs = await getPackNames();
  packSel.innerHTML = `<option value="">— не использовать —</option>` + packs.map((p) => `<option value="${p}">${p}</option>`).join("");

  function syncFactoryFieldLabels() {
    $("kia-brand-value").textContent = brandSel.value || "—";
    $("kia-model-value").textContent = modelSel.value || "—";
    $("kia-pack-value").textContent = packSel.value ? packSel.options[packSel.selectedIndex].textContent : "— не использовать —";
  }

  async function fillModels(brand) {
    const models = await getModelsForBrand(brand);
    modelSel.innerHTML = models.map((m) => `<option value="${m}">${m}</option>`).join("");
    if (models.includes(DEFAULT_MODEL)) modelSel.value = DEFAULT_MODEL;
    syncFactoryFieldLabels();
  }

  brandSel.addEventListener("change", () => fillModels(brandSel.value));
  brandSel.value = "Kia";
  await fillModels("Kia");
  syncFactoryFieldLabels();

  $("kia-brand-field").addEventListener("click", async () => {
    const choice = await openPicker("Марка", brands, brandSel.value);
    if (choice == null || choice === brandSel.value) return;
    brandSel.value = choice;
    await fillModels(choice);
  });
  $("kia-model-field").addEventListener("click", async () => {
    const models = Array.from(modelSel.options).map((o) => o.value);
    const choice = await openPicker("Модель", models, modelSel.value);
    if (choice == null) return;
    modelSel.value = choice;
    syncFactoryFieldLabels();
  });
  $("kia-pack-field").addEventListener("click", async () => {
    const items = ["— не использовать —", ...packs];
    const current = packSel.value ? packSel.options[packSel.selectedIndex].textContent : "— не использовать —";
    const choice = await openPicker("Пакет протокола", items, current);
    if (choice == null) return;
    packSel.value = choice === "— не использовать —" ? "" : choice;
    syncFactoryFieldLabels();
  });
}
const factoryPidsReady = initFactoryPidsUI();

$("btn-read-kia").addEventListener("click", async () => {
  if (!state.connected) { toast("Сначала подключитесь к сканеру", "err"); return; }
  $("btn-read-kia").disabled = true;
  const host = $("kia-content");
  host.innerHTML = `<div class="hint">Переключаюсь на блоки управления и считываю…</div>`;
  state.pollPaused = true;
  try {
    await factoryPidsReady;
    const packName = $("kia-pack").value;
    const groups = packName ? await getPackGroups(packName) : await getProfileGroups($("kia-model").value);
    const rows = [];
    for (const g of groups) {
      let bytes = null;
      try {
        bytes = g.before
          ? await obd.requestWithSequence(g.before, g.command)
          : await obd.requestCustomPid(g.header, g.command);
        if (g.after) await obd.runCommandSequence(g.after);
      } catch { /* пропуск группы — машина не ответила на этот блок управления */ }
      for (const f of g.fields) {
        let value = null;
        if (bytes) { try { value = f.decode(bytes); } catch { value = null; } }
        rows.push({ label: f.label, unit: f.unit, value: value != null ? Math.round(value * 100) / 100 : null });
      }
    }
    host.innerHTML = groups.length ? `
      <div class="hint mb8">⚠ Экспериментально: формулы извлечены из стороннего приложения, не проверены живым тестом. Единицы измерения предположительные.</div>
      <div class="metric-grid">
        ${rows.map(r => `
          <div class="glass metric-card">
            <div class="m-label">${r.label}</div>
            <div class="m-value ${r.value == null ? "dash" : ""}">${r.value != null ? r.value : "—"} <span class="unit">${r.unit}</span></div>
          </div>`).join("")}
      </div>` : `<div class="hint">Для этой модели нет параметров в базе</div>`;
  } catch (e) {
    host.innerHTML = `<div class="hint" style="color:#fca5a5">${e.message || "Ошибка чтения"}</div>`;
  } finally {
    try { await obd.restoreAutoHeader(); } catch { /* адаптер мог отключиться */ }
    state.pollPaused = false;
    $("btn-read-kia").disabled = false;
  }
});

// ── История ──────────────────────────────────────────────────────────────
function renderHistory() {
  const host = $("history-list");
  const items = getHistory();
  if (!items.length) {
    host.innerHTML = `<div class="empty-state glass"><div class="icon">🗂</div><div class="title">История пуста</div><div class="sub">Сохранённые отчёты появятся здесь</div></div>`;
    return;
  }
  host.innerHTML = items.map(e => {
    const date = new Date(e.timestamp).toLocaleString("ru-RU");
    const dtcCount = (e.dtcCodes || []).length;
    return `
      <div class="glass panel" data-id="${e.id}">
        <div class="row between">
          <div>
            <div style="font-weight:700;font-size:13px">${date}</div>
            <div class="hint">${dtcCount ? dtcCount + " ошибок" : "Ошибок нет"} · ${e.deviceName || ""}</div>
          </div>
          <div class="row">
            <button class="btn small" data-act="share">Поделиться</button>
            <button class="btn small" data-act="download">Скачать</button>
            <button class="btn small danger" data-act="delete">✕</button>
          </div>
        </div>
      </div>
    `;
  }).join("");

  host.querySelectorAll("[data-act]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.closest("[data-id]").dataset.id;
      const scan = getScan(id);
      if (!scan) return;
      if (btn.dataset.act === "download") downloadReport(scan);
      else if (btn.dataset.act === "share") await shareReport(scan);
      else if (btn.dataset.act === "delete") { deleteScan(id); renderHistory(); }
    });
  });
}
document.querySelector('[data-screen="history"]').addEventListener("click", renderHistory);

$("btn-clear-history").addEventListener("click", async () => {
  const ok = await confirmModal("Очистить всю историю?", "Все сохранённые отчёты будут удалены безвозвратно.");
  if (!ok) return;
  clearHistory();
  renderHistory();
});

// ── Лог команд/ответов адаптера + постоянный журнал приложения ─────────────
$("btn-download-log").addEventListener("click", () => {
  const cmdLog = obd.getLogText() || "Команд в этой сессии ещё не было.";
  const text = "── Журнал приложения (все запуски) ──\n" + getAppLogText()
    + "\n\n── Команды/ответы адаптера (текущая сессия) ──\n" + cmdLog;
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `obd-log-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

// ── Инициализация ────────────────────────────────────────────────────────
setConnUi("idle");
showScreen("dashboard");
