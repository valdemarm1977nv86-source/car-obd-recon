// Универсальный движок заводских параметров (не Mode 01) — с 2026-08-21 работает для любой
// марки/модели, не только Kia (имя файла осталось историческим, чтобы не трогать sw.js).
// Данные и формулы — из embedded-ресурсов Car Scanner (com.ovz.carscanner), извлечены и
// разобраны ReEngineer Pro, см. LESSONS.md за 2026-08-21. Формулы компилируются через formula.js;
// любая формула, которую компилятор не смог разобрать, была отброшена ещё на этапе конвертации
// (tools/convert-carscanner-data.mjs) — не гадаем на замену.
//
// Всё содержимое data/*.json — экспериментальное, не проверено живым тестом (кроме отдельных
// параметров, отмеченных в WORKING_FEATURES.md после реальной проверки).

import { compileFormula } from "./formula.js";

let profilesPromise = null;
let packsPromise = null;

function loadProfiles() {
  if (!profilesPromise) profilesPromise = fetch("data/profiles.json").then((r) => r.json());
  return profilesPromise;
}
function loadPacks() {
  if (!packsPromise) packsPromise = fetch("data/custom-pid-packs.json").then((r) => r.json());
  return packsPromise;
}

// Единицы измерения по числовому коду UN — распознаны сопоставлением формулы с физическим
// смыслом (RPM-масштаб, %-масштаб 100/255, температура со смещением -40 и т.п.), см.
// подтверждённые 4 параметра в предыдущей версии этого файла как опорную точку (Units 2/5/10/15).
// Коды, которых нет в этой таблице — оставляем без единицы, а не гадаем.
const UNIT_LABELS = {
  0: "", 1: "км/ч", 2: "км/ч", 5: "кПа", 6: "об/мин", 7: "°", 10: "В",
  13: "Нм", 14: "%", 15: "°C", 44: "мс",
};

const compileCache = new Map();
function compiled(formulaStr) {
  let fn = compileCache.get(formulaStr);
  if (!fn) {
    fn = compileFormula(formulaStr);
    compileCache.set(formulaStr, fn);
  }
  return fn;
}

// Группирует плоский список параметров профиля по (header, command, before, after) — один
// физический запрос к машине может вернуть сразу несколько параметров (как было изначально
// с 4 параметрами Kia, только теперь обобщено на произвольное число полей на команду).
function groupFields(pids) {
  const groups = new Map();
  for (const p of pids) {
    const key = p.h + "|" + p.c + "|" + (p.b || "") + "|" + (p.a || "");
    let g = groups.get(key);
    if (!g) {
      g = { header: p.h, command: p.c, before: p.b || "", after: p.a || "", fields: [] };
      groups.set(key, g);
    }
    g.fields.push({ label: p.s || p.n, unit: UNIT_LABELS[p.u] ?? "", decode: compiled(p.f) });
  }
  return [...groups.values()];
}

export async function getBrands() {
  const profiles = await loadProfiles();
  const set = new Set();
  for (const p of profiles) for (const b of p.brands) set.add(b);
  return [...set].sort((a, b) => a.localeCompare(b, "ru"));
}

export async function getModelsForBrand(brand) {
  const profiles = await loadProfiles();
  return profiles.filter((p) => p.brands.includes(brand)).map((p) => p.name).sort((a, b) => a.localeCompare(b, "ru"));
}

export async function getPackNames() {
  const packs = await loadPacks();
  return packs.map((p) => p.name).sort((a, b) => a.localeCompare(b, "ru"));
}

export async function getProfileGroups(name) {
  const profiles = await loadProfiles();
  const profile = profiles.find((p) => p.name === name);
  return profile ? groupFields(profile.pids) : [];
}

export async function getPackGroups(name) {
  const packs = await loadPacks();
  const pack = packs.find((p) => p.name === name);
  return pack ? groupFields(pack.pids) : [];
}
