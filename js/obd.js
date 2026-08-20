// Слой связи с ELM327-адаптером по BLE. Протокол подтверждён живым тестом на KW901
// (см. LESSONS.md / DEVELOPMENT_LOG_CURRENT.md за 2026-08-20): сервис fff0, запись в fff2,
// ответы (notify) из fff1, ответ всегда завершается символом '>'.

const SERVICE_UUID = "0000fff0-0000-1000-8000-00805f9b34fb";
const WRITE_UUID = "0000fff2-0000-1000-8000-00805f9b34fb";
const NOTIFY_UUID = "0000fff1-0000-1000-8000-00805f9b34fb";
const CMD_TIMEOUT_MS = 4000;

export class ObdLink {
  constructor() {
    this.device = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.connected = false;
    this.buffer = "";
    this._pending = null; // { resolve, reject, timer }
    this._queue = Promise.resolve();
    this.onDisconnect = null;
    this.deviceName = "";
  }

  async connect() {
    if (!navigator.bluetooth) {
      throw new Error("Web Bluetooth недоступен в этом браузере (нужен Chrome на Android)");
    }
    this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [SERVICE_UUID],
    });
    this.deviceName = this.device.name || "OBD-адаптер";
    this.device.addEventListener("gattserverdisconnected", () => {
      this.connected = false;
      if (this.onDisconnect) this.onDisconnect();
    });

    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.writeChar = await service.getCharacteristic(WRITE_UUID);
    this.notifyChar = await service.getCharacteristic(NOTIFY_UUID);

    await this.notifyChar.startNotifications();
    this.notifyChar.addEventListener("characteristicvaluechanged", (ev) => {
      const bytes = new Uint8Array(ev.target.value.buffer);
      this.buffer += new TextDecoder().decode(bytes);
      this._checkPrompt();
    });

    this.connected = true;
    await this._initSequence();
    return this.deviceName;
  }

  disconnect() {
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
    this.connected = false;
  }

  async _initSequence() {
    const boot = await this.sendCommand("ATZ", 3000);
    if (!/ELM327/i.test(boot)) {
      throw new Error(`Адаптер не отозвался как ELM327 (получено: "${boot}"). Возможно, это другой чип.`);
    }
    await this.sendCommand("ATE0");   // выключить эхо команд
    await this.sendCommand("ATL0");   // без лишних переводов строк
    await this.sendCommand("ATS0");   // без пробелов в hex-ответах
    await this.sendCommand("ATH0");   // без заголовков CAN
    await this.sendCommand("ATSP0");  // автоопределение протокола ЭБУ
  }

  _checkPrompt() {
    const idx = this.buffer.indexOf(">");
    if (idx === -1 || !this._pending) return;
    const raw = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + 1);
    clearTimeout(this._pending.timer);
    const { resolve } = this._pending;
    this._pending = null;
    resolve(raw);
  }

  // Отправляет "сырую" команду, ждёт ответа до символа '>'. Команды сериализуются очередью.
  sendCommand(cmd, timeoutMs = CMD_TIMEOUT_MS) {
    const run = () => new Promise((resolve, reject) => {
      if (!this.connected) { reject(new Error("Нет подключения")); return; }
      this.buffer = "";
      const timer = setTimeout(() => {
        this._pending = null;
        reject(new Error(`Таймаут ответа на команду "${cmd}"`));
      }, timeoutMs);
      this._pending = { resolve, reject, timer };

      const bytes = new TextEncoder().encode(cmd + "\r");
      const p = this.writeChar.properties.write
        ? this.writeChar.writeValueWithResponse(bytes)
        : this.writeChar.writeValueWithoutResponse(bytes);
      p.catch((e) => {
        clearTimeout(timer);
        this._pending = null;
        reject(e);
      });
    }).then((raw) => cleanResponse(raw, cmd));

    // Сериализация: следующая команда стартует только после завершения предыдущей.
    this._queue = this._queue.then(run, run);
    return this._queue;
  }

  // Запрашивает PID (mode — 2 hex-символа, напр. "01", "02"; pid — 2 hex-символа).
  // Возвращает массив байт данных или null (нет данных/не поддерживается).
  async requestPid(mode, pid) {
    const resp = await this.sendCommand(mode + pid);
    return parsePidBytes(resp, mode, pid);
  }

  // Заводские параметры (не Mode 01) требуют адресации конкретного блока управления.
  // header — 6 hex-символов (напр. "8212F1"), command — 4 hex-символа (mode+pid, напр. "2143").
  async requestCustomPid(header, command) {
    await this.sendCommand("ATSH" + header);
    const resp = await this.sendCommand(command);
    return parsePidBytes(resp, command.slice(0, 2), command.slice(2, 4));
  }

  // Возвращает адаптер к автоматическому выбору заголовка после заводских запросов.
  async restoreAutoHeader() {
    await this.sendCommand("ATSP0");
  }

  // Версия чипа (ATI) и его собственное напряжение питания (ATRV) — не от машины, от адаптера.
  async getAdapterInfo() {
    let version = "", voltage = "";
    try { version = await this.sendCommand("ATI"); } catch { /* не критично */ }
    try { voltage = await this.sendCommand("ATRV"); } catch { /* не критично */ }
    return { version: version.trim(), voltage: voltage.trim() };
  }

  // Опрашивает у машины битовые маски поддерживаемых PID (Mode 01, PID 00/20/40/...),
  // чтобы не тратить время на запрос параметров, которых у этой машины физически нет.
  // Возвращает Set строк "0C", "0D" и т.д. Пустой Set = определить не удалось (запрашивать всё).
  async detectSupportedPids() {
    const supported = new Set();
    let start = 0x00;
    for (let guard = 0; guard < 8; guard++) {
      const pidHex = start.toString(16).padStart(2, "0").toUpperCase();
      let bytes;
      try {
        bytes = await this.requestPid("01", pidHex);
      } catch {
        break;
      }
      if (!bytes || bytes.length < 4) break;
      let bitIndex = 0;
      let hasNext = false;
      for (const byte of bytes.slice(0, 4)) {
        for (let b = 7; b >= 0; b--) {
          const pidNum = start + bitIndex + 1;
          if (byte & (1 << b)) {
            supported.add(pidNum.toString(16).padStart(2, "0").toUpperCase());
            if (pidNum === start + 0x20) hasNext = true;
          }
          bitIndex++;
        }
      }
      if (!hasNext) break;
      start += 0x20;
    }
    return supported;
  }
}

function cleanResponse(raw, cmd) {
  let s = raw.replace(/\r/g, "\n").split("\n").map(l => l.trim()).filter(Boolean).join("\n");
  const echoPrefix = cmd.trim();
  if (s.startsWith(echoPrefix)) s = s.slice(echoPrefix.length).trim();
  return s.trim();
}

const NO_DATA_MARKERS = ["NO DATA", "NODATA", "UNABLE TO CONNECT", "STOPPED", "SEARCHING", "?", "ERROR", "CAN ERROR"];

function parsePidBytes(resp, mode, pid) {
  if (!resp) return null;
  const upper = resp.toUpperCase();
  if (NO_DATA_MARKERS.some(m => upper.includes(m))) return null;

  const expectedHeader = (parseInt(mode, 16) + 0x40).toString(16).toUpperCase().padStart(2, "0") + pid.toUpperCase();
  // Ответ может прийти в несколько строк — берём первую, где есть ожидаемый заголовок.
  const lines = upper.split("\n").map(l => l.replace(/\s+/g, ""));
  const line = lines.find(l => l.includes(expectedHeader)) || lines[0];
  if (!line) return null;
  const hexIdx = line.indexOf(expectedHeader);
  const dataHex = hexIdx >= 0 ? line.slice(hexIdx + expectedHeader.length) : null;
  if (!dataHex || dataHex.length < 2) return null;

  const bytes = [];
  for (let i = 0; i + 1 < dataHex.length; i += 2) {
    const b = parseInt(dataHex.slice(i, i + 2), 16);
    if (Number.isNaN(b)) break;
    bytes.push(b);
  }
  return bytes.length ? bytes : null;
}

export { SERVICE_UUID, WRITE_UUID, NOTIFY_UUID };
