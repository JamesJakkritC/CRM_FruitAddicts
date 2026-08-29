import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../db/index.ts';
import { getSetting, setSetting } from './settings.ts';
import { badRequest } from '../lib/errors.ts';

/**
 * Configurable signup form. Built-in fields map to member columns; custom fields
 * are stored on `members.extra_json`. The owner edits the list in the admin
 * "หน้าสมัครสมาชิก" screen.
 */
export type FieldType = 'text' | 'date' | 'phone' | 'select' | 'month' | 'century';

export interface SignupField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  builtin: boolean;
  options?: string[]; // for type 'select'
}

const KEY = 'signup.fields';

/** Keys that map to a real member column (everything else goes to extra_json). */
const COLUMN_KEYS = new Set(['displayName', 'nickname', 'phone', 'birthday', 'birth_month', 'birth_century']);

// Default signup form (owner's requested fields). Editable in the admin UI.
export const BUILTIN_FIELDS: SignupField[] = [
  { key: 'nickname', label: 'ชื่อเล่น', type: 'text', required: true, builtin: true },
  { key: 'phone', label: 'เบอร์โทร', type: 'phone', required: false, builtin: true },
  { key: 'birth_month', label: 'เดือนเกิด', type: 'month', required: false, builtin: true },
  { key: 'birth_century', label: 'ยุคเกิด', type: 'century', required: false, builtin: true },
];

export function getSignupFields(db: DatabaseSync = getDb()): SignupField[] {
  const raw = getSetting(KEY, db);
  if (!raw) return BUILTIN_FIELDS;
  try {
    const parsed = JSON.parse(raw) as SignupField[];
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {
    /* fall through */
  }
  return BUILTIN_FIELDS;
}

const TYPES: FieldType[] = ['text', 'date', 'phone', 'select', 'month', 'century'];

export function setSignupFields(fields: SignupField[], db: DatabaseSync = getDb()): SignupField[] {
  if (!Array.isArray(fields) || fields.length === 0) throw badRequest('at least one field is required');
  const seen = new Set<string>();
  const clean: SignupField[] = fields.map((f) => {
    const key = String(f.key ?? '').trim();
    if (!/^[a-zA-Z0-9_]+$/.test(key)) throw badRequest(`invalid field key '${f.key}'`);
    if (seen.has(key)) throw badRequest(`duplicate field key '${key}'`);
    seen.add(key);
    if (!TYPES.includes(f.type)) throw badRequest(`invalid field type '${f.type}'`);
    const out: SignupField = {
      key,
      label: String(f.label ?? key),
      type: f.type,
      required: !!f.required,
      builtin: COLUMN_KEYS.has(key), // column-backed fields are "built in"
    };
    if (f.type === 'select' && Array.isArray(f.options)) out.options = f.options.map(String);
    return out;
  });
  setSetting(KEY, JSON.stringify(clean), db);
  return clean;
}

export interface SplitAnswers {
  displayName?: string;
  nickname?: string;
  phone?: string;
  birthday?: string;
  birthMonth?: number;
  birthCentury?: number;
  extra: Record<string, unknown>;
}

/** Split submitted answers into built-in (columns) and custom (extra_json). */
export function splitAnswers(answers: Record<string, unknown>, db: DatabaseSync = getDb()): SplitAnswers {
  const fields = getSignupFields(db);
  const extra: Record<string, unknown> = {};
  const out: SplitAnswers = { extra };
  for (const f of fields) {
    const v = answers[f.key];
    if (v === undefined || v === null || v === '') continue;
    switch (f.key) {
      case 'displayName': out.displayName = String(v); break;
      case 'nickname': out.nickname = String(v); break;
      case 'phone': out.phone = String(v); break;
      case 'birthday': out.birthday = String(v); break;
      case 'birth_month': out.birthMonth = Number(v); break;
      case 'birth_century': out.birthCentury = Number(v); break;
      default: extra[f.key] = v;
    }
  }
  return out;
}
