/** RFC 4180: quoted fields, doubled quotes, newlines inside quotes. Header row → objects. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && src[i + 1] === "\n") i++; row.push(field); field = ""; if (row.some((f) => f !== "")) rows.push(row); row = []; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((f) => f !== "")) rows.push(row); }
  const header = rows.shift() ?? [];
  // Strava repeats some column names (Distance, Elapsed Time…): the first keeps the name, later ones get a suffix.
  const seen = new Map<string, number>();
  const names = header.map((h) => { const n = (seen.get(h) ?? 0) + 1; seen.set(h, n); return n === 1 ? h : `${h} ${n}`; });
  return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i] ?? ""])));
}
