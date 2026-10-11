import { inflateRawSync } from "node:zlib";
import sax from "sax";

/**
 * A minimal `.xlsx` reader: enough to turn each sheet into rows of cell values.
 *
 * An .xlsx is a zip of XML parts. Rather than add a spreadsheet library for one importer,
 * this walks the zip's central directory by hand (the format is small and stable), inflates
 * each part with `node:zlib`, and parses the sheet XML with `sax`, which is already a
 * dependency. Supports shared strings, inline strings, numbers, booleans, error cells
 * (returned as null) and date-formatted numbers (returned as `YYYY-MM-DD`).
 */

export type Cell = string | number | boolean | null;

interface ZipEntry {
  name: string;
  offset: number;
  compressedSize: number;
  method: number;
}

function readZip(buffer: Buffer): Map<string, Buffer> {
  // End-of-central-directory record: signature 0x06054b50, scanned from the tail.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a zip file (no end-of-central-directory record)");
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt zip central directory");
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28), extraLen = buffer.readUInt16LE(p + 30), commentLen = buffer.readUInt16LE(p + 32);
    const offset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, offset, compressedSize, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const parts = new Map<string, Buffer>();
  for (const e of entries) {
    // Local header: skip its variable-length name and extra fields to reach the data.
    const nameLen = buffer.readUInt16LE(e.offset + 26), extraLen = buffer.readUInt16LE(e.offset + 28);
    const start = e.offset + 30 + nameLen + extraLen;
    const data = buffer.subarray(start, start + e.compressedSize);
    parts.set(e.name, e.method === 8 ? inflateRawSync(data) : e.method === 0 ? Buffer.from(data) : (() => { throw new Error(`Unsupported zip method ${e.method} for ${e.name}`); })());
  }
  return parts;
}

/** Collects the text of every `<t>` inside each `<si>` — shared strings, rich-text runs included. */
function readSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  let current: string | undefined;
  let inT = false;
  const parser = sax.parser(true);
  parser.onopentag = (t) => { if (t.name === "si") current = ""; else if (t.name === "t") inT = true; };
  parser.ontext = (text) => { if (inT && current !== undefined) current += text; };
  parser.onclosetag = (name) => { if (name === "t") inT = false; else if (name === "si" && current !== undefined) { out.push(current); current = undefined; } };
  parser.write(xml).close();
  return out;
}

/** Which cell styles are date formats, by index into `cellXfs`. */
function readDateStyles(xml: string | undefined): boolean[] {
  if (!xml) return [];
  const custom = new Map<string, string>();
  const xfs: boolean[] = [];
  let inCellXfs = false;
  const parser = sax.parser(true);
  parser.onopentag = (t) => {
    const a = t.attributes as Record<string, string>;
    if (t.name === "numFmt") custom.set(a["numFmtId"]!, a["formatCode"] ?? "");
    if (t.name === "cellXfs") inCellXfs = true;
    if (t.name === "xf" && inCellXfs) {
      const id = a["numFmtId"] ?? "0";
      const builtInDate = Number(id) >= 14 && Number(id) <= 22;
      const code = (custom.get(id) ?? "").toLowerCase().replace(/\[[^\]]*]/g, "");
      xfs.push(builtInDate || (/[dmy]/.test(code) && !/[#0]/.test(code)));
    }
  };
  parser.onclosetag = (name) => { if (name === "cellXfs") inCellXfs = false; };
  parser.write(xml).close();
  return xfs;
}

function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000); // 25569 = 1970-01-01 in Excel's 1900 epoch
  return new Date(ms).toISOString().slice(0, 10);
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) { if (ch < "A" || ch > "Z") break; n = n * 26 + ch.charCodeAt(0) - 64; }
  return n - 1;
}

function readSheet(xml: string, shared: string[], dateStyles: boolean[]): Cell[][] {
  const rows: Cell[][] = [];
  let row: Map<number, Cell> | undefined;
  let cell: { col: number; type: string | undefined; style: number } | undefined;
  let text = "";
  let inValue = false;
  const parser = sax.parser(true);
  parser.onopentag = (t) => {
    const a = t.attributes as Record<string, string>;
    if (t.name === "row") row = new Map();
    else if (t.name === "c") { cell = { col: columnIndex(a["r"] ?? "A1"), type: a["t"], style: Number(a["s"] ?? 0) }; text = ""; }
    else if (t.name === "v" || t.name === "t") { inValue = true; text = ""; }
  };
  parser.ontext = (s) => { if (inValue) text += s; };
  parser.onclosetag = (name) => {
    if ((name === "v" || name === "t") && cell && row) {
      inValue = false;
      let value: Cell;
      switch (cell.type) {
        case "s": value = shared[Number(text)] ?? ""; break;
        case "inlineStr": case "str": value = text; break;
        case "b": value = text === "1"; break;
        case "e": value = null; break; // #N/A and friends
        default: {
          const n = Number(text);
          value = Number.isFinite(n) ? (dateStyles[cell.style] && n > 20_000 && n < 80_000 ? excelDate(n) : n) : text;
        }
      }
      row.set(cell.col, value);
    } else if (name === "row" && row) {
      const width = row.size ? Math.max(...row.keys()) + 1 : 0;
      rows.push(Array.from({ length: width }, (_, i) => row!.get(i) ?? null));
      row = undefined;
    }
  };
  parser.write(xml).close();
  return rows;
}

export function readWorkbook(buffer: Buffer): Map<string, Cell[][]> {
  const parts = readZip(buffer);
  const text = (name: string) => parts.get(name)?.toString("utf8");
  const shared = readSharedStrings(text("xl/sharedStrings.xml"));
  const dateStyles = readDateStyles(text("xl/styles.xml"));

  const rels = new Map<string, string>();
  const relParser = sax.parser(true);
  relParser.onopentag = (t) => { const a = t.attributes as Record<string, string>; if (t.name === "Relationship") rels.set(a["Id"]!, a["Target"]!); };
  relParser.write(text("xl/_rels/workbook.xml.rels") ?? "").close();

  const sheets = new Map<string, Cell[][]>();
  const wbParser = sax.parser(true);
  wbParser.onopentag = (t) => {
    if (t.name !== "sheet") return;
    const a = t.attributes as Record<string, string>;
    const target = rels.get(a["r:id"]!) ?? "";
    const path = target.startsWith("/") ? target.slice(1) : target.startsWith("xl/") ? target : `xl/${target}`;
    const xml = text(path);
    if (xml) sheets.set(a["name"]!, readSheet(xml, shared, dateStyles));
  };
  wbParser.write(text("xl/workbook.xml") ?? "").close();
  return sheets;
}
