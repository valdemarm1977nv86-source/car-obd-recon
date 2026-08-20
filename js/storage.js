// История сканирований — localStorage, без сервера (см. план, раздел 2).
const KEY = "obd_scan_history";
const MAX_ENTRIES = 50;

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeAll(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch (e) {
    console.warn("Не удалось сохранить историю:", e);
  }
}

export function saveScan(snapshot) {
  const list = readAll();
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: Date.now(),
    ...snapshot,
  };
  list.unshift(entry);
  if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
  writeAll(list);
  return entry.id;
}

export function getHistory() {
  return readAll();
}

export function getScan(id) {
  return readAll().find(e => e.id === id) || null;
}

export function deleteScan(id) {
  writeAll(readAll().filter(e => e.id !== id));
}

export function clearHistory() {
  writeAll([]);
}
