// Стандартные PID Mode 01 (SAE J1979) — формулы и диапазоны "норма/предупреждение/критично".
// verdict() возвращает 'ok' | 'warn' | 'crit' | 'info' | null (null = нет смысла оценивать).

function hex2(a) { return a; }

export const PID_LIST = [
  {
    name: "RPM", pid: "0C", bytes: 2, label: "Обороты двигателя", unit: "об/мин",
    min: 0, max: 8000, decode: (A, B) => ((A * 256) + B) / 4,
    verdict: () => null, // сильно зависит от режима движения — не оцениваем
  },
  {
    name: "SPEED", pid: "0D", bytes: 1, label: "Скорость", unit: "км/ч",
    min: 0, max: 220, decode: (A) => A,
    verdict: () => null,
  },
  {
    name: "COOLANT_TEMP", pid: "05", bytes: 1, label: "Температура ОЖ", unit: "°C",
    min: -40, max: 150, decode: (A) => A - 40,
    verdict: (v) => {
      if (v < 70) return "info";     // прогрев
      if (v <= 105) return "ok";
      if (v <= 115) return "warn";
      return "crit";
    },
    note: (v) => v > 105 ? "Возможен перегрев — проверьте уровень охлаждающей жидкости и работу вентилятора" : null,
  },
  {
    name: "ENGINE_LOAD", pid: "04", bytes: 1, label: "Нагрузка двигателя", unit: "%",
    min: 0, max: 100, decode: (A) => A * 100 / 255,
    verdict: () => null,
  },
  {
    name: "THROTTLE_POS", pid: "11", bytes: 1, label: "Положение дросселя", unit: "%",
    min: 0, max: 100, decode: (A) => A * 100 / 255,
    verdict: () => null,
  },
  {
    name: "FUEL_LEVEL", pid: "2F", bytes: 1, label: "Уровень топлива", unit: "%",
    min: 0, max: 100, decode: (A) => A * 100 / 255,
    verdict: (v) => {
      if (v <= 5) return "crit";
      if (v <= 15) return "warn";
      return "ok";
    },
    note: (v) => v <= 15 ? "Низкий уровень топлива" : null,
  },
  {
    name: "INTAKE_TEMP", pid: "0F", bytes: 1, label: "Температура впуска", unit: "°C",
    min: -40, max: 120, decode: (A) => A - 40,
    verdict: (v) => v > 80 ? "warn" : "ok",
  },
  {
    name: "SHORT_FUEL_TRIM_1", pid: "06", bytes: 1, label: "Коррекция топлива (кратк.)", unit: "%",
    min: -100, max: 100, decode: (A) => (A - 128) * 100 / 128,
    verdict: (v) => {
      const a = Math.abs(v);
      if (a <= 10) return "ok";
      if (a <= 25) return "warn";
      return "crit";
    },
    note: (v) => Math.abs(v) > 10 ? (v > 0 ? "Смесь обедняется — возможен подсос воздуха или слабый расходомер" : "Смесь обогащается — проверьте давление топлива/форсунки") : null,
  },
  {
    name: "LONG_FUEL_TRIM_1", pid: "07", bytes: 1, label: "Коррекция топлива (длит.)", unit: "%",
    min: -100, max: 100, decode: (A) => (A - 128) * 100 / 128,
    verdict: (v) => {
      const a = Math.abs(v);
      if (a <= 10) return "ok";
      if (a <= 25) return "warn";
      return "crit";
    },
    note: (v) => Math.abs(v) > 10 ? (v > 0 ? "Смесь обедняется — возможен подсос воздуха или слабый расходомер" : "Смесь обогащается — проверьте давление топлива/форсунки") : null,
  },
  {
    name: "TIMING_ADVANCE", pid: "0E", bytes: 1, label: "Угол опережения зажигания", unit: "°",
    min: -64, max: 64, decode: (A) => (A / 2) - 64,
    verdict: () => null,
  },
  {
    name: "INTAKE_PRESSURE", pid: "0B", bytes: 1, label: "Давление во впускном коллекторе", unit: "кПа",
    min: 0, max: 255, decode: (A) => A,
    verdict: () => null,
  },
  {
    name: "FUEL_PRESSURE", pid: "0A", bytes: 1, label: "Давление топлива", unit: "кПа",
    min: 0, max: 765, decode: (A) => A * 3,
    verdict: () => null,
  },
  {
    name: "RUN_TIME", pid: "1F", bytes: 2, label: "Время работы двигателя", unit: "сек",
    min: 0, max: 65535, decode: (A, B) => (A * 256) + B,
    verdict: () => null,
  },
  {
    name: "AMBIANT_AIR_TEMP", pid: "46", bytes: 1, label: "Температура воздуха (внешн.)", unit: "°C",
    min: -40, max: 120, decode: (A) => A - 40,
    verdict: () => null,
  },
  {
    name: "BAROMETRIC_PRESSURE", pid: "33", bytes: 1, label: "Барометрическое давление", unit: "кПа",
    min: 0, max: 255, decode: (A) => A,
    verdict: () => null,
  },
  // ── Добавлено 2026-08-20 по скриншотам живого сканирования (подтверждено реально
  // поддерживается этой машиной) ──────────────────────────────────────────────
  {
    name: "O2_B1S1_V", pid: "14", bytes: 2, label: "Датчик кислорода 1 Блок 1 — напряжение", unit: "В",
    min: 0, max: 1.275, decode: (A) => A / 200,
    verdict: () => null,
  },
  {
    name: "O2_B1S1_TRIM", pid: "14", bytes: 2, label: "Датчик кислорода 1 Блок 1 — коррекция", unit: "%",
    min: -100, max: 100, decode: (A, B) => (B === 0xff ? null : (B - 128) * 100 / 128),
    verdict: (v) => v == null ? null : (Math.abs(v) <= 10 ? "ok" : Math.abs(v) <= 25 ? "warn" : "crit"),
  },
  {
    name: "O2_B1S2_V", pid: "15", bytes: 2, label: "Датчик кислорода 2 Блок 1 — напряжение", unit: "В",
    min: 0, max: 1.275, decode: (A) => A / 200,
    verdict: () => null,
  },
  {
    name: "O2_B1S2_TRIM", pid: "15", bytes: 2, label: "Датчик кислорода 2 Блок 1 — коррекция", unit: "%",
    min: -100, max: 100, decode: (A, B) => (B === 0xff ? null : (B - 128) * 100 / 128),
    verdict: (v) => v == null ? null : (Math.abs(v) <= 10 ? "ok" : Math.abs(v) <= 25 ? "warn" : "crit"),
  },
  {
    name: "DIST_MIL_ON", pid: "21", bytes: 2, label: "Дистанция с горящим Check Engine", unit: "км",
    min: 0, max: 65535, decode: (A, B) => (A * 256) + B,
    verdict: (v) => v > 0 ? "warn" : "ok",
    note: (v) => v > 0 ? "Машина едет с активной ошибкой — стоит разобраться, что вызвало" : null,
  },
  {
    name: "EVAP_PURGE", pid: "2E", bytes: 1, label: "Командная продувка адсорбера (EVAP)", unit: "%",
    min: 0, max: 100, decode: (A) => A * 100 / 255,
    verdict: () => null,
  },
  {
    name: "WARMUPS_SINCE_CLEAR", pid: "30", bytes: 1, label: "Прогревов с момента сброса кодов", unit: "",
    min: 0, max: 255, decode: (A) => A,
    verdict: () => null,
  },
  {
    name: "DIST_SINCE_CLEAR", pid: "31", bytes: 2, label: "Дистанция с момента сброса кодов", unit: "км",
    min: 0, max: 65535, decode: (A, B) => (A * 256) + B,
    verdict: () => null,
  },
  {
    name: "CATALYST_TEMP_B1S1", pid: "3C", bytes: 2, label: "Температура катализатора, датчик 1", unit: "°C",
    min: -40, max: 6513.5, decode: (A, B) => ((A * 256) + B) / 10 - 40,
    verdict: () => null,
  },
  {
    name: "CATALYST_TEMP_B1S2", pid: "3E", bytes: 2, label: "Температура катализатора, датчик 2", unit: "°C",
    min: -40, max: 6513.5, decode: (A, B) => ((A * 256) + B) / 10 - 40,
    verdict: () => null,
  },
  {
    name: "CTRL_MODULE_VOLTAGE", pid: "42", bytes: 2, label: "Напряжение на ЭБУ", unit: "В",
    min: 0, max: 65.535, decode: (A, B) => ((A * 256) + B) / 1000,
    verdict: (v) => (v < 11.5 || v > 15) ? "warn" : "ok",
    note: (v) => v < 11.5 ? "Низкое напряжение — проверьте АКБ/генератор" : v > 15 ? "Высокое напряжение — возможен перезаряд" : null,
  },
  {
    name: "ABS_LOAD", pid: "43", bytes: 2, label: "Абсолютное значение нагрузки двигателя", unit: "%",
    min: 0, max: 25700, decode: (A, B) => ((A * 256) + B) * 100 / 255,
    verdict: () => null,
  },
  {
    name: "ACCEL_PEDAL_D", pid: "49", bytes: 1, label: "Положение педали акселератора D", unit: "%",
    min: 0, max: 100, decode: (A) => A * 100 / 255,
    verdict: () => null,
  },
  {
    name: "ACCEL_PEDAL_E", pid: "4A", bytes: 1, label: "Положение педали акселератора E", unit: "%",
    min: 0, max: 100, decode: (A) => A * 100 / 255,
    verdict: () => null,
  },
  {
    name: "COMMANDED_THROTTLE", pid: "4C", bytes: 1, label: "Заданное положение дросселя (PXX)", unit: "%",
    min: 0, max: 100, decode: (A) => A * 100 / 255,
    verdict: () => null,
  },
  {
    name: "TIME_MIL_ON", pid: "4D", bytes: 2, label: "Время с горящим Check Engine", unit: "мин",
    min: 0, max: 65535, decode: (A, B) => (A * 256) + B,
    verdict: (v) => v > 0 ? "warn" : "ok",
  },
  {
    name: "TIME_SINCE_CLEAR", pid: "4E", bytes: 2, label: "Время с момента сброса кодов", unit: "мин",
    min: 0, max: 65535, decode: (A, B) => (A * 256) + B,
    verdict: () => null,
  },
];

// Крупные датчики-дуги на дашборде — первые 4, остальные из списка идут карточками/доп. датчиками.
export const GAUGE_PIDS = ["RPM", "SPEED", "COOLANT_TEMP", "ENGINE_LOAD", "THROTTLE_POS", "FUEL_LEVEL", "INTAKE_TEMP"];
export const CARD_PIDS = PID_LIST.map(p => p.name).filter(n => !GAUGE_PIDS.includes(n));

export function byName(name) {
  return PID_LIST.find(p => p.name === name);
}

export function decodePidResponse(pidDef, dataBytes) {
  if (!dataBytes || dataBytes.length < pidDef.bytes) return null;
  const raw = pidDef.decode(...dataBytes.slice(0, pidDef.bytes));
  return Math.round(raw * 10) / 10;
}

// ── I/M Readiness (Mode 01 PID 01) ──────────────────────────────────────────
// Байт A: bit7=MIL, bits6-0=кол-во DTC. Байт B: bit3=тип зажигания (0=искровое,1=дизель),
// bit6/5/4=доступность Components/FuelSystem/Misfire, bit2/1/0=завершённость тех же (0=пройден,1=нет).
// Байты C/D: доступность/завершённость остальных 8 мониторов (для искрового зажигания).
// Экспериментально — расположение бит стандартно по SAE J1979, но не проверено на всех авто.
const SPARK_MONITORS = [
  { bit: 0, name: "CATALYST", label: "Катализатор" },
  { bit: 1, name: "HEATED_CATALYST", label: "Подогреваемый катализатор" },
  { bit: 2, name: "EVAPORATIVE_SYSTEM", label: "EVAP (пары топлива)" },
  { bit: 3, name: "SECONDARY_AIR", label: "Вторичный воздух" },
  { bit: 4, name: "AC_REFRIGERANT", label: "Хладагент A/C" },
  { bit: 5, name: "OXYGEN_SENSOR", label: "Датчики O2" },
  { bit: 6, name: "OXYGEN_SENSOR_HEATER", label: "Нагрев датчиков O2" },
  { bit: 7, name: "EGR_SYSTEM", label: "EGR (рециркуляция газов)" },
];

export function decodeReadiness(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const [A, B, C, D] = bytes;
  const mil = !!(A & 0x80);
  const dtcCount = A & 0x7f;
  const compressionIgnition = !!(B & 0x08);

  const monitors = [
    { name: "MISFIRE", label: "Пропуски воспламенения", available: !!(B & 0x10), complete: !(B & 0x01) },
    { name: "FUEL_SYSTEM", label: "Топливная система", available: !!(B & 0x20), complete: !(B & 0x02) },
    { name: "COMPONENTS", label: "Компоненты", available: !!(B & 0x40), complete: !(B & 0x04) },
  ];

  for (const m of SPARK_MONITORS) {
    monitors.push({
      name: m.name,
      label: m.label,
      available: !!(C & (1 << m.bit)),
      complete: !(D & (1 << m.bit)),
    });
  }

  return { mil, dtcCount, compressionIgnition, monitors: monitors.filter(m => m.available) };
}

// ── Коды DTC (Mode 03/07 ответ) ─────────────────────────────────────────────
export function parseDtcBytes(bytes) {
  const letters = ["P", "C", "B", "U"];
  const codes = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const b1 = bytes[i], b2 = bytes[i + 1];
    if (b1 === 0 && b2 === 0) continue; // пусто/заполнитель
    const letter = letters[(b1 >> 6) & 0x03];
    const d1 = (b1 >> 4) & 0x03;
    const d2 = (b1 & 0x0f).toString(16).toUpperCase();
    const d3 = ((b2 >> 4) & 0x0f).toString(16).toUpperCase();
    const d4 = (b2 & 0x0f).toString(16).toUpperCase();
    codes.push(`${letter}${d1}${d2}${d3}${d4}`);
  }
  return codes;
}
