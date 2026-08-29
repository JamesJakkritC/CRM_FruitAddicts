import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../db/index.ts';
import { getSetting, setSetting } from './settings.ts';
import { badRequest } from '../lib/errors.ts';

/** Store profile lives in the generic `settings` table (no schema needed). */
const KEYS = {
  name: 'store.name',
  phone: 'store.phone',
  address: 'store.address',
  logo: 'store.logo_data_url',
  themePrimary: 'theme.primary',
  themeAccent: 'theme.accent',
} as const;

// Default to the shop's green brand.
const DEFAULT_THEME = { primary: '#0f9d58', accent: '#0b7a41' };
const HEX = /^#[0-9a-fA-F]{6}$/;

export interface StoreProfile {
  name: string;
  phone: string;
  address: string;
  hasLogo: boolean;
}

export function getStoreProfile(db: DatabaseSync = getDb()): StoreProfile {
  return {
    name: getSetting(KEYS.name, db) ?? 'Fruit Addicts',
    phone: getSetting(KEYS.phone, db) ?? '',
    address: getSetting(KEYS.address, db) ?? '',
    hasLogo: getSetting(KEYS.logo, db) !== undefined,
  };
}

export function setStoreProfile(
  patch: { name?: string; phone?: string; address?: string; logoDataUrl?: string | null },
  db: DatabaseSync = getDb(),
): StoreProfile {
  if (patch.name !== undefined) setSetting(KEYS.name, patch.name, db);
  if (patch.phone !== undefined) setSetting(KEYS.phone, patch.phone, db);
  if (patch.address !== undefined) setSetting(KEYS.address, patch.address, db);
  if (patch.logoDataUrl !== undefined) {
    if (patch.logoDataUrl === null || patch.logoDataUrl === '') {
      setSetting(KEYS.logo, '', db); // clear
    } else {
      if (!/^data:image\/[a-zA-Z.+-]+;base64,/.test(patch.logoDataUrl)) {
        throw badRequest('logo must be a data:image/*;base64 URL');
      }
      setSetting(KEYS.logo, patch.logoDataUrl, db);
    }
  }
  return getStoreProfile(db);
}

/** Returns the raw logo data URL (or null if unset/cleared). */
export function getLogoDataUrl(db: DatabaseSync = getDb()): string | null {
  const v = getSetting(KEYS.logo, db);
  return v && v.length > 0 ? v : null;
}

export interface Theme {
  primary: string;
  accent: string;
}

export function getTheme(db: DatabaseSync = getDb()): Theme {
  return {
    primary: getSetting(KEYS.themePrimary, db) ?? DEFAULT_THEME.primary,
    accent: getSetting(KEYS.themeAccent, db) ?? DEFAULT_THEME.accent,
  };
}

export function setTheme(patch: { primary?: string; accent?: string }, db: DatabaseSync = getDb()): Theme {
  if (patch.primary !== undefined) {
    if (!HEX.test(patch.primary)) throw badRequest('primary must be a #RRGGBB hex color');
    setSetting(KEYS.themePrimary, patch.primary, db);
  }
  if (patch.accent !== undefined) {
    if (!HEX.test(patch.accent)) throw badRequest('accent must be a #RRGGBB hex color');
    setSetting(KEYS.themeAccent, patch.accent, db);
  }
  return getTheme(db);
}
