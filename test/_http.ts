import './_httpenv.ts';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server.ts';
import { closeDb, getDb } from '../src/db/index.ts';

export interface TestServer {
  base: string;
  close: () => Promise<void>;
}

/** Start a fresh in-memory app on an ephemeral port (bootstrap runs migrations/seed). */
export async function startServer(): Promise<TestServer> {
  closeDb(); // fresh memory DB per call; createApp() re-bootstraps it
  const app = createApp();
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', () => resolve()));
  const port = (app.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => app.close(() => resolve())),
  };
}

export function lineSignature(rawBody: string, secret = 'test-webhook-secret'): string {
  return createHmac('sha256', secret).update(rawBody).digest('base64');
}

export interface ApiResponse {
  status: number;
  body: any;
}

export async function req(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(base + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export async function loginAs(base: string, username: string, password: string): Promise<string> {
  const r = await req(base, 'POST', '/api/auth/login', { body: { username, password } });
  if (r.status !== 200) throw new Error(`login failed for ${username}: ${JSON.stringify(r.body)}`);
  return r.body.token as string;
}

export { getDb };
