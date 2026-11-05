/**
 * CSV import with field mappings. A mapping says which column of a client's export fills which
 * canonical field, with an optional transform. Every client's export looks different; the mapping
 * is the only thing that changes per source system.
 */
import Papa from 'papaparse';

export type Entity = 'lead' | 'journey_event' | 'transaction' | 'campaign' | 'partner' | 'consent';
export type Transform = 'trim' | 'upper' | 'lower' | 'number' | 'date' | 'bool';
export type FieldSpec = string | { column?: string; transform?: Transform; default?: string | number | boolean };

export interface Mapping {
  entity: Entity;
  sourceSystem: string;
  fields: Record<string, FieldSpec>;
}

/** Canonical fields per entity: which are required. */
export const CANONICAL: Record<Entity, { required: string[]; optional: string[] }> = {
  lead: { required: ['external_id', 'name'], optional: ['phone', 'email', 'gov_id', 'pincode', 'city', 'created_at', 'book_code', 'is_existing_customer'] },
  journey_event: { required: ['journey_ref', 'stage', 'occurred_at'], optional: ['person_ref', 'phone', 'partner_code', 'campaign_code', 'crm_converted', 'value_inr'] },
  transaction: { required: ['external_ref', 'occurred_at', 'value_inr'], optional: ['journey_ref', 'person_ref', 'phone', 'partner_code', 'evidence'] },
  campaign: { required: ['external_code', 'name', 'channel'], optional: ['start_date', 'end_date', 'spend_inr', 'platform_reported_conversions'] },
  partner: { required: ['external_code', 'name', 'partner_type'], optional: ['city'] },
  consent: { required: ['purpose', 'channel', 'granted'], optional: ['person_ref', 'phone', 'recorded_at', 'expires_at'] },
};

export interface RowError { row: number; field: string; message: string }
export interface MappedResult { records: Record<string, unknown>[]; errors: RowError[]; rowCount: number }

/**
 * Read a large CSV row by row (in the browser: a File, without holding the whole file as objects).
 * Stops at the first blank line, where DV360 starts its report notes.
 */
export function streamCsv(input: Blob | string, onRow: (row: Record<string, string>) => void): Promise<{ header: string[]; rows: number }> {
  return new Promise((resolve, reject) => {
    let header: string[] = [], rows = 0, done = false;
    Papa.parse<Record<string, string>>(input as never, {
      header: true, skipEmptyLines: false, transformHeader: (h: string) => h.trim(),
      step: (res: Papa.ParseStepResult<Record<string, string>>, parser: Papa.Parser) => {
        if (done) return;
        if (!header.length) header = res.meta.fields ?? [];
        const r = res.data;
        if (!r || Object.values(r).every(v => v === '' || v === undefined)) { done = true; parser.abort(); return; }
        rows++; onRow(r);
      },
      complete: () => resolve({ header, rows }),
      error: (e: Error) => reject(e),
    } as never);
  });
}

export function parseCsv(text: string): Record<string, string>[] {
  const out = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true, transformHeader: h => h.trim() });
  return out.data;
}

function applyTransform(value: string, t: Transform | undefined): unknown {
  const v = value.trim();
  switch (t) {
    case undefined: case 'trim': return v;
    case 'upper': return v.toUpperCase();
    case 'lower': return v.toLowerCase();
    case 'number': {
      const n = Number(v.replace(/[₹,\s]/g, ''));
      if (!Number.isFinite(n)) throw new Error(`"${v}" is not a number`);
      return n;
    }
    case 'date': {
      // accepts ISO dates and dd/mm/yyyy or dd-mm-yyyy (common in Indian exports)
      const m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/);
      const iso = m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}T${(m[4] ?? '00').padStart(2, '0')}:${m[5] ?? '00'}:00Z` : v;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) throw new Error(`"${v}" is not a date`);
      return d.toISOString();
    }
    case 'bool': {
      const l = v.toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(l)) return true;
      if (['false', 'no', 'n', '0', ''].includes(l)) return false;
      throw new Error(`"${v}" is not yes or no`);
    }
  }
}

export function applyMapping(rows: Record<string, string>[], mapping: Mapping): MappedResult {
  const spec = CANONICAL[mapping.entity];
  const unknown = Object.keys(mapping.fields).filter(f => !spec.required.includes(f) && !spec.optional.includes(f));
  if (unknown.length) throw new Error(`Unknown field(s) for ${mapping.entity}: ${unknown.join(', ')}`);
  const missing = spec.required.filter(f => !(f in mapping.fields));
  if (missing.length) throw new Error(`Mapping for ${mapping.entity} is missing required field(s): ${missing.join(', ')}`);

  const records: Record<string, unknown>[] = [];
  const errors: RowError[] = [];
  rows.forEach((row, i) => {
    const rec: Record<string, unknown> = { source_system: mapping.sourceSystem };
    let bad = false;
    for (const [field, fs] of Object.entries(mapping.fields)) {
      const s = typeof fs === 'string' ? { column: fs } : fs;
      const raw = s.column !== undefined ? row[s.column] : undefined;
      if (raw === undefined || raw.trim() === '') {
        if (s.default !== undefined) { rec[field] = s.default; continue; }
        if (spec.required.includes(field)) { errors.push({ row: i + 2, field, message: `missing value in column "${s.column}"` }); bad = true; }
        continue;
      }
      try { rec[field] = applyTransform(raw, s.transform); }
      catch (e) { errors.push({ row: i + 2, field, message: (e as Error).message }); bad = true; }
    }
    if (!bad) records.push(rec);
  });
  return { records, errors, rowCount: rows.length };
}
