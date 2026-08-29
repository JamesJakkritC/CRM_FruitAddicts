import { createClient, Client } from '@libsql/client';
import { config } from '../config.js';

let client: Client | null = null;

export function getDb(): Client {
  if (client) return client;

  const url = process.env.TURSO_DATABASE_URL || config.db.file;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  client = createClient({
    url: url.startsWith('libsql://') || url.startsWith('https://') ? url : `file:${url}`,
    authToken: authToken
  });

  return client;
}

export function openDb() {
  return getDb();
}

export function closeDb(): void {
  if (client) {
    client.close();
    client = null;
  }
}

export async function tx<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = getDb();
  const transaction = await db.transaction('write');
  try {
    const result = await fn(transaction as unknown as Client);
    await transaction.commit();
    return result;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

export function now(): string {
  return new Date().toISOString();
}

export const asRow = <T>(v: unknown): T | undefined => v as T | undefined;
export const asRows = <T>(v: unknown): T[] => v as T[];
