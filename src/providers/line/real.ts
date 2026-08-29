import { createHmac, timingSafeEqual } from 'node:crypto';
import type { LineProvider, LineMessage, RichMenuSpec } from './adapter.ts';
import { config } from '../../config.ts';

/**
 * Real LINE Messaging API provider. Used ONLY when LINE_PROVIDER=line and real
 * credentials are configured. No credentials are shipped in this repo.
 */
export class RealLineProvider implements LineProvider {
  readonly name = 'line';

  async pushMessage(to: string, messages: LineMessage[]): Promise<void> {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.line.channelAccessToken}`,
      },
      body: JSON.stringify({ to, messages }),
    });
    if (!res.ok) {
      throw new Error(`LINE push failed: ${res.status} ${await res.text()}`);
    }
  }

  async verifyIdToken(idToken: string): Promise<string | null> {
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: config.line.channelId }),
    });
    if (!res.ok) return null;
    const claims = (await res.json()) as { sub?: string };
    return claims.sub ?? null;
  }

  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = createHmac('sha256', config.line.channelSecret).update(rawBody).digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private authHeader(): string {
    return `Bearer ${config.line.channelAccessToken}`;
  }

  async createRichMenu(spec: RichMenuSpec): Promise<string> {
    const res = await fetch('https://api.line.me/v2/bot/richmenu', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: this.authHeader() },
      body: JSON.stringify(spec),
    });
    if (!res.ok) throw new Error(`LINE createRichMenu failed: ${res.status} ${await res.text()}`);
    const j = (await res.json()) as { richMenuId?: string };
    if (!j.richMenuId) throw new Error('LINE createRichMenu: no richMenuId returned');
    return j.richMenuId;
  }

  async uploadRichMenuImage(richMenuId: string, image: Buffer, mime: string): Promise<void> {
    const res = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
      method: 'POST',
      headers: { 'content-type': mime, authorization: this.authHeader() },
      body: image,
    });
    if (!res.ok) throw new Error(`LINE uploadRichMenuImage failed: ${res.status} ${await res.text()}`);
  }

  async setDefaultRichMenu(richMenuId: string): Promise<void> {
    const res = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
      method: 'POST',
      headers: { authorization: this.authHeader() },
    });
    if (!res.ok) throw new Error(`LINE setDefaultRichMenu failed: ${res.status} ${await res.text()}`);
  }

  async deleteRichMenu(richMenuId: string): Promise<void> {
    const res = await fetch(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, {
      method: 'DELETE',
      headers: { authorization: this.authHeader() },
    });
    // 404 = already gone; treat as success so delete stays idempotent.
    if (!res.ok && res.status !== 404) throw new Error(`LINE deleteRichMenu failed: ${res.status} ${await res.text()}`);
  }
}
