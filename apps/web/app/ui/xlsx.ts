'use client';
/**
 * A small Excel (.xlsx) reader for report exports: the first sheet as rows keyed by the header row.
 * An .xlsx file is a zip of XML; this reads shared strings, inline strings and numbers, which is all
 * a DSP export contains. Formulas are read as their saved values.
 */
import { unzipSync, strFromU8 } from 'fflate';

const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

export async function readXlsx(file: Blob): Promise<Record<string, string>[]> {
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: f => /^xl\/(sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/.test(f.name) });
  const xml = (name: string) => (files[name] ? new DOMParser().parseFromString(strFromU8(files[name]!), 'application/xml') : null);
  const shared = [...(xml('xl/sharedStrings.xml')?.getElementsByTagName('si') ?? [])].map(si => [...si.getElementsByTagName('t')].map(t => t.textContent ?? '').join(''));
  // the first sheet in the workbook's order
  const wb = xml('xl/workbook.xml'), rels = xml('xl/_rels/workbook.xml.rels');
  const firstId = wb?.getElementsByTagName('sheet')[0]?.getAttribute('r:id');
  const target = [...(rels?.getElementsByTagName('Relationship') ?? [])].find(r => r.getAttribute('Id') === firstId)?.getAttribute('Target');
  const sheetName = target ? `xl/${target.replace(/^\/?xl\//, '')}` : Object.keys(files).find(f => f.startsWith('xl/worksheets/')) ?? '';
  const sheet = xml(sheetName);
  if (!sheet) throw new Error('No sheet found in the workbook.');
  const grid: string[][] = [];
  for (const row of sheet.getElementsByTagName('row')) {
    const cells: string[] = [];
    for (const c of row.getElementsByTagName('c')) {
      const t = c.getAttribute('t'), v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      const val = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? [...c.getElementsByTagName('t')].map(x => x.textContent ?? '').join('') : v;
      cells[colIndex(c.getAttribute('r') ?? 'A1')] = val;
    }
    grid.push(cells);
  }
  const header = (grid[0] ?? []).map(h => (h ?? '').trim());
  return grid.slice(1).filter(r => r.some(v => v !== undefined && v !== '')).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}
