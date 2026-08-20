// Генерация HTML-отчёта по снимку сканирования + скачивание / шаринг (Web Share API).

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export function buildReportHtml(snapshot) {
  const date = new Date(snapshot.timestamp).toLocaleString("ru-RU");
  const dtcRows = (snapshot.dtcCodes || []).map(d =>
    `<tr><td class="code">${esc(d.code)}</td><td>${esc(d.desc)}</td></tr>`
  ).join("") || `<tr><td colspan="2" class="dim">Ошибок не обнаружено</td></tr>`;

  const paramRows = Object.entries(snapshot.liveParams || {}).map(([name, p]) =>
    `<tr><td>${esc(p.label || name)}</td><td class="val">${p.value ?? "—"} <span class="dim">${esc(p.unit || "")}</span></td></tr>`
  ).join("");

  const vinBlock = snapshot.vin ? `
    <h2>VIN</h2>
    <p class="mono">${esc(snapshot.vin.vin || "")}</p>
    ${snapshot.vin.make ? `<p class="dim">${esc(snapshot.vin.make)} ${esc(snapshot.vin.model || "")} ${esc(snapshot.vin.year || "")}</p>` : ""}
  ` : "";

  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Отчёт сканирования — ${esc(date)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#070b14; color:#e2e8f0; margin:0; padding:20px; }
  h1 { font-size:20px; margin-bottom:2px; }
  .dim { color:#64748b; font-size:13px; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.05em; color:#64748b; margin:22px 0 8px; }
  table { width:100%; border-collapse: collapse; background:rgba(15,23,42,.6); border:1px solid rgba(99,179,237,.15); border-radius:10px; overflow:hidden; }
  td { padding:9px 12px; border-bottom:1px solid rgba(99,179,237,.08); font-size:13px; }
  tr:last-child td { border-bottom:none; }
  .code { font-weight:800; color:#ef4444; }
  .val { text-align:right; font-family:monospace; font-weight:700; }
  .mono { font-family: monospace; }
  .footer { margin-top:24px; font-size:11px; color:#334155; }
</style></head>
<body>
  <h1>Отчёт диагностики</h1>
  <p class="dim">${esc(date)} · ${esc(snapshot.deviceName || "OBD-адаптер")}</p>
  ${vinBlock}
  <h2>Коды ошибок (DTC)</h2>
  <table>${dtcRows}</table>
  <h2>Параметры на момент сканирования</h2>
  <table>${paramRows || `<tr><td class="dim">Нет данных</td></tr>`}</table>
  <p class="footer">Сформировано мобильным авто-сканером · KONWEI KW901 / ELM327</p>
</body></html>`;
}

export function downloadReport(snapshot) {
  const html = buildReportHtml(snapshot);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const date = new Date(snapshot.timestamp).toISOString().slice(0, 16).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `otchet-${date}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function shareReport(snapshot) {
  const html = buildReportHtml(snapshot);
  const date = new Date(snapshot.timestamp).toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const file = new File([html], `otchet-${date}.html`, { type: "text/html" });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: "Отчёт диагностики авто" });
    return true;
  }
  if (navigator.share) {
    await navigator.share({ title: "Отчёт диагностики авто", text: `Отчёт от ${new Date(snapshot.timestamp).toLocaleString("ru-RU")}` });
    return true;
  }
  downloadReport(snapshot);
  return false;
}
