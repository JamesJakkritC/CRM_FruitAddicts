import type { DatabaseSync } from 'node:sqlite';
import { getDb, tx, now, asRow, asRows } from '../db/index.ts';
import { badRequest, notFound, unprocessable } from '../lib/errors.ts';
import { getLineProvider } from '../providers/line/index.ts';
import type { RichMenuArea, RichMenuSpec } from '../providers/line/adapter.ts';
import { config } from '../config.ts';
import type { Principal } from './rbac.ts';

/**
 * Rich Menu designer.
 *
 * A rich menu is a LINE-side artifact (a tappable image at the bottom of the chat).
 * Staff author it here — pick a layout template, label each cell, and point each
 * cell at a LIFF section or a canned message — then PUBLISH, which pushes the menu
 * + image to LINE via the provider adapter (mock in dev, real API in production).
 *
 * The pixel geometry (LINE requires absolute bounds) is generated from the chosen
 * template so the person designing never touches coordinates.
 */

export type RichMenuSize = 'full' | 'compact';

const SIZE_PX: Record<RichMenuSize, { width: number; height: number }> = {
  full: { width: 2500, height: 1686 },
  compact: { width: 2500, height: 843 },
};

interface TemplateDef { size: RichMenuSize; cols: number; rows: number; cells: number; label: string }

/** Supported grid layouts. Cells fill left-to-right, top-to-bottom. */
export const TEMPLATES: Record<string, TemplateDef> = {
  'full-6': { size: 'full', cols: 3, rows: 2, cells: 6, label: '6 ปุ่ม (3×2)' },
  'full-4': { size: 'full', cols: 2, rows: 2, cells: 4, label: '4 ปุ่ม (2×2)' },
  'full-3': { size: 'full', cols: 3, rows: 1, cells: 3, label: '3 ปุ่ม (แนวนอน)' },
  'full-2': { size: 'full', cols: 2, rows: 1, cells: 2, label: '2 ปุ่ม (แนวนอน)' },
  'compact-3': { size: 'compact', cols: 3, rows: 1, cells: 3, label: '3 ปุ่ม (เตี้ย)' },
  'compact-2': { size: 'compact', cols: 2, rows: 1, cells: 2, label: '2 ปุ่ม (เตี้ย)' },
  'compact-1': { size: 'compact', cols: 1, rows: 1, cells: 1, label: '1 ปุ่ม (เต็มแถบ)' },
};

/** Known LIFF sections a button can deep-link to. */
export const LIFF_SECTIONS = ['home', 'points', 'purchases', 'coupons', 'receipt', 'referral', 'profile'] as const;
export type LiffSection = (typeof LIFF_SECTIONS)[number];

export interface ButtonInput {
  label: string;
  actionType: 'liff' | 'uri' | 'message';
  value: string; // liff: a section key; uri: absolute URL; message: text
}

export interface RichMenu {
  id: number;
  name: string;
  chat_bar_text: string;
  size: RichMenuSize;
  template: string;
  buttons_json: string;
  areas_json: string;
  image_base64: string | null;
  image_mime: string | null;
  provider_richmenu_id: string | null;
  status: 'draft' | 'published';
  is_default: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

/** Build the LIFF deep-link URL for a section (falls back to the base LIFF URL). */
function liffUrl(section: string): string {
  const base = config.line.liffId ? `https://liff.line.me/${config.line.liffId}` : '';
  if (!base) throw unprocessable('LIFF_ID is not configured; cannot build a LIFF link. Set it or use a full URL action.');
  return section && section !== 'home' ? `${base}?p=${encodeURIComponent(section)}` : base;
}

function toAction(b: ButtonInput): RichMenuArea['action'] {
  const label = b.label?.slice(0, 20) || undefined;
  switch (b.actionType) {
    case 'message':
      if (!b.value.trim()) throw badRequest(`button "${b.label}" needs message text`);
      return { type: 'message', label, text: b.value.trim() };
    case 'uri':
      if (!/^https?:\/\//.test(b.value)) throw badRequest(`button "${b.label}" URI must start with http(s)://`);
      return { type: 'uri', label, uri: b.value.trim() };
    case 'liff':
      return { type: 'uri', label, uri: liffUrl(b.value) };
    default:
      throw badRequest(`unknown actionType for button "${b.label}"`);
  }
}

/** Resolve template geometry + buttons into LINE RichMenuArea[] with pixel bounds. */
export function buildAreas(template: string, buttons: ButtonInput[]): RichMenuArea[] {
  const t = TEMPLATES[template];
  if (!t) throw badRequest(`unknown template '${template}'`);
  if (buttons.length !== t.cells) throw badRequest(`template '${template}' needs exactly ${t.cells} buttons (got ${buttons.length})`);
  const { width, height } = SIZE_PX[t.size];
  const cellW = Math.floor(width / t.cols);
  const cellH = Math.floor(height / t.rows);
  const areas: RichMenuArea[] = [];
  for (let i = 0; i < buttons.length; i++) {
    const col = i % t.cols;
    const row = Math.floor(i / t.cols);
    // Last column/row absorbs rounding remainder so areas tile the full image.
    const w = col === t.cols - 1 ? width - cellW * (t.cols - 1) : cellW;
    const h = row === t.rows - 1 ? height - cellH * (t.rows - 1) : cellH;
    areas.push({ bounds: { x: cellW * col, y: cellH * row, width: w, height: h }, action: toAction(buttons[i]!) });
  }
  return areas;
}

export interface CreateRichMenuInput {
  name: string;
  chatBarText?: string;
  template: string;
  buttons: ButtonInput[];
}

export function createRichMenu(input: CreateRichMenuInput, actor?: Principal | null, db: DatabaseSync = getDb()): RichMenu {
  const name = input.name?.trim();
  if (!name) throw badRequest('rich menu name is required');
  const t = TEMPLATES[input.template];
  if (!t) throw badRequest(`unknown template '${input.template}'`);
  const areas = buildAreas(input.template, input.buttons); // validates buttons
  const chatBarText = (input.chatBarText?.trim() || 'เมนู').slice(0, 14);
  const info = db.prepare(
    `INSERT INTO rich_menus(name, chat_bar_text, size, template, buttons_json, areas_json, status, created_by, created_at, updated_at)
     VALUES(?,?,?,?,?,?, 'draft', ?, ?, ?)`,
  ).run(name, chatBarText, t.size, input.template, JSON.stringify(input.buttons), JSON.stringify(areas), actor?.userId ?? null, now(), now());
  return requireRichMenu(Number(info.lastInsertRowid), db);
}

export function getRichMenu(id: number, db: DatabaseSync = getDb()): RichMenu | undefined {
  return asRow<RichMenu>(db.prepare('SELECT * FROM rich_menus WHERE id = ?').get(id));
}
export function requireRichMenu(id: number, db: DatabaseSync = getDb()): RichMenu {
  const r = getRichMenu(id, db);
  if (!r) throw notFound(`rich menu ${id} not found`);
  return r;
}
/** List menus without the (large) image blob. */
export function listRichMenus(db: DatabaseSync = getDb()): Omit<RichMenu, 'image_base64'>[] {
  return asRows(db.prepare(
    `SELECT id, name, chat_bar_text, size, template, buttons_json, areas_json,
            (image_base64 IS NOT NULL) AS has_image, image_mime, provider_richmenu_id,
            status, is_default, created_by, created_at, updated_at, published_at
       FROM rich_menus ORDER BY id DESC`,
  ).all());
}

export interface UpdateRichMenuInput {
  name?: string;
  chatBarText?: string;
  template?: string;
  buttons?: ButtonInput[];
}

export function updateRichMenu(id: number, input: UpdateRichMenuInput, db: DatabaseSync = getDb()): RichMenu {
  const r = requireRichMenu(id, db);
  const template = input.template ?? r.template;
  const t = TEMPLATES[template];
  if (!t) throw badRequest(`unknown template '${template}'`);
  const buttons: ButtonInput[] = input.buttons ?? (JSON.parse(r.buttons_json) as ButtonInput[]);
  const areas = buildAreas(template, buttons);
  db.prepare(
    `UPDATE rich_menus SET name=?, chat_bar_text=?, size=?, template=?, buttons_json=?, areas_json=?, updated_at=? WHERE id=?`,
  ).run(
    input.name?.trim() || r.name,
    (input.chatBarText?.trim() ?? r.chat_bar_text).slice(0, 14),
    t.size,
    template,
    JSON.stringify(buttons),
    JSON.stringify(areas),
    now(),
    id,
  );
  return requireRichMenu(id, db);
}

export function setRichMenuImage(id: number, imageBase64: string, mime: string, db: DatabaseSync = getDb()): RichMenu {
  requireRichMenu(id, db);
  if (!/^image\/(png|jpeg)$/.test(mime)) throw badRequest('rich menu image must be image/png or image/jpeg');
  db.prepare('UPDATE rich_menus SET image_base64=?, image_mime=?, updated_at=? WHERE id=?').run(imageBase64, mime, now(), id);
  return requireRichMenu(id, db);
}

export function getRichMenuImage(id: number, db: DatabaseSync = getDb()): { base64: string; mime: string } | null {
  const r = asRow<{ image_base64: string | null; image_mime: string | null }>(
    db.prepare('SELECT image_base64, image_mime FROM rich_menus WHERE id = ?').get(id),
  );
  if (!r?.image_base64) return null;
  return { base64: r.image_base64, mime: r.image_mime ?? 'image/png' };
}

/**
 * The spec sent to LINE (without the image). Areas are rebuilt from the authoring
 * buttons at publish time so `liff` links pick up the CURRENT `LIFF_ID` — a menu
 * can be designed before LIFF_ID is set, then published once it is, with no re-edit.
 */
function toSpec(r: RichMenu): { spec: RichMenuSpec; areas: RichMenuArea[] } {
  const buttons = JSON.parse(r.buttons_json) as ButtonInput[];
  const areas = buildAreas(r.template, buttons); // resolves liffUrl() with live config
  return {
    spec: {
      size: SIZE_PX[r.size],
      selected: false,
      name: r.name.slice(0, 300),
      chatBarText: r.chat_bar_text.slice(0, 14),
      areas,
    },
    areas,
  };
}

/**
 * Publish a menu to LINE: create it via the provider, upload the image, store the
 * returned richMenuId. Re-publishing deletes the previously-published provider menu
 * first so we never leak orphaned menus. The DB write commits only after the remote
 * calls succeed.
 */
export async function publishRichMenu(id: number): Promise<RichMenu> {
  const r = requireRichMenu(id, getDb());
  if (!r.image_base64 || !r.image_mime) throw unprocessable('upload an image before publishing');
  const provider = getLineProvider();

  const { spec, areas } = toSpec(r); // rebuilds areas with the live LIFF_ID
  const newId = await provider.createRichMenu(spec);
  await provider.uploadRichMenuImage(newId, Buffer.from(r.image_base64, 'base64'), r.image_mime);

  const oldId = r.provider_richmenu_id;
  return tx((db) => {
    db.prepare(`UPDATE rich_menus SET areas_json=?, provider_richmenu_id=?, status='published', published_at=?, updated_at=? WHERE id=?`)
      .run(JSON.stringify(areas), newId, now(), now(), id);
    // If it was the default, re-point the default to the freshly published menu.
    if (r.is_default) void provider.setDefaultRichMenu(newId);
    const out = requireRichMenu(id, db);
    // Best-effort cleanup of the old remote menu (after commit-critical write).
    if (oldId && oldId !== newId) void provider.deleteRichMenu(oldId).catch(() => {});
    return out;
  });
}

/** Make a published menu the default for all users (clears any previous default). */
export async function setDefaultRichMenu(id: number): Promise<RichMenu> {
  const r = requireRichMenu(id, getDb());
  if (r.status !== 'published' || !r.provider_richmenu_id) throw unprocessable('publish the menu before setting it as default');
  await getLineProvider().setDefaultRichMenu(r.provider_richmenu_id);
  return tx((db) => {
    db.prepare('UPDATE rich_menus SET is_default=0 WHERE is_default=1').run();
    db.prepare('UPDATE rich_menus SET is_default=1, updated_at=? WHERE id=?').run(now(), id);
    return requireRichMenu(id, db);
  });
}

/** Delete a menu (and its remote counterpart if published). */
export async function deleteRichMenu(id: number): Promise<void> {
  const r = requireRichMenu(id, getDb());
  if (r.provider_richmenu_id) await getLineProvider().deleteRichMenu(r.provider_richmenu_id).catch(() => {});
  getDb().prepare('DELETE FROM rich_menus WHERE id = ?').run(id);
}
