// Постоянный журнал приложения — переживает закрытие/краш вкладки (в отличие от лога
// команд/ответов в obd.js, который живёт только в памяти текущей сессии). Пишет
// автоматически (запуск приложения, попытки подключения, обрывы связи, JS-ошибки),
// без участия пользователя — на случай "что-то пошло не так, а разобраться не с чем".
// Хранится только локально (localStorage), никуда не отправляется.
const KEY = "obd_app_log";
const MAX_ENTRIES = 300;

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
  } catch { /* localStorage переполнен/недоступен — теряем самую свежую запись, не критично */ }
}

export function logEvent(type, detail) {
  const list = readAll();
  list.push({ ts: Date.now(), type, detail: detail != null ? String(detail) : "" });
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
  writeAll(list);
}

export function getAppLogText() {
  const list = readAll();
  if (!list.length) return "Журнал приложения пуст.";
  return list.map((e) => {
    const t = new Date(e.ts).toLocaleString("ru-RU");
    return `[${t}] ${e.type}${e.detail ? ": " + e.detail : ""}`;
  }).join("\n");
}

export function clearAppLog() {
  writeAll([]);
}
