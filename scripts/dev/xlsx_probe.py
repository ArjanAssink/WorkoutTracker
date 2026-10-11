"""Dependency-free .xlsx reader: sheets as lists of rows of (str|float|None)."""
import zipfile, re, sys, datetime
from xml.etree import ElementTree as ET
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
def col_index(ref):
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group(0): n = n * 26 + ord(ch) - 64
    return n - 1
def load(path):
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
    # date-styled cells: styles.xml cellXfs numFmtId 14-22 or custom containing y/m/d
    styles = ET.fromstring(z.read("xl/styles.xml"))
    custom = {nf.get("numFmtId"): nf.get("formatCode") for nf in styles.iter(f"{{{NS['m']}}}numFmt")}
    datexf = []
    for xf in styles.find("m:cellXfs", NS).findall("m:xf", NS):
        fid = xf.get("numFmtId"); code = custom.get(fid, "")
        datexf.append(fid in {str(i) for i in range(14, 23)} or bool(re.search(r"[ymd]", code.lower().replace("general",""))) and "h" not in code.lower() or fid in {str(i) for i in range(14,23)})
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    sheets = {}
    for s in wb.find("m:sheets", NS):
        target = rels[s.get(f"{{{NS['r']}}}id")]; target = target if target.startswith("xl/") else "xl/" + target.lstrip("/")
        root = ET.fromstring(z.read(target)); rows = []
        for row in root.iter(f"{{{NS['m']}}}row"):
            cells = {}
            for c in row.findall("m:c", NS):
                v = c.find("m:v", NS); t = c.get("t"); s_idx = int(c.get("s", "0"))
                if t == "e": val = None   # formula error such as #N/A
                elif t == "s" and v is not None: val = shared[int(v.text)]
                elif t == "inlineStr": val = "".join(x.text or "" for x in c.iter(f"{{{NS['m']}}}t"))
                elif v is not None:
                    try: val = float(v.text)
                    except ValueError: val = v.text
                    if s_idx < len(datexf) and datexf[s_idx] and 20000 < val < 80000:
                        val = (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(val))).isoformat()
                else: val = None
                cells[col_index(c.get("r"))] = val
            width = max(cells) + 1 if cells else 0
            rows.append([cells.get(i) for i in range(width)])
        sheets[s.get("name")] = rows
    return sheets
if __name__ == "__main__":
    for name, rows in load(sys.argv[1]).items():
        ne = [r for r in rows if any(c not in (None, "") for c in r)]
        print(f"\n=== {name}: {len(rows)} rows, {len(ne)} non-empty, up to {max((len(r) for r in rows), default=0)} cols ===")
        fmt = lambda r: " | ".join("" if c is None else (f"{c:g}" if isinstance(c, float) else str(c))[:16] for c in r[:16])
        for r in ne[:14]: print("  ", fmt(r))
        if len(ne) > 18:
            print("   ..."); [print("  ", fmt(r)) for r in ne[-4:]]
