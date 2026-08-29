import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { config } from "../../config.js";
/**
 * Mock provider for dev/test. Requires no LINE credentials and makes no network
 * calls. Message persistence/delivery accounting is handled by the outbox table
 * (see domain/notifications.ts); this just logs.
 */
export class MockLineProvider {
    name = 'mock';
    async pushMessage(to, messages) {
        // eslint-disable-next-line no-console
        console.log(`[line:mock] push -> ${to}: ${JSON.stringify(messages)}`);
    }
    async verifyIdToken(idToken) {
        // Dev convention: a token shaped "dev:<lineUserId>" resolves to that user.
        if (idToken.startsWith('dev:'))
            return idToken.slice(4) || null;
        return null;
    }
    verifyWebhookSignature(rawBody, signature) {
        // If a channel secret is configured we still verify honestly; otherwise
        // (pure dev, no secret) accept so webhooks can be exercised locally.
        if (!config.line.channelSecret)
            return true;
        if (!signature)
            return false;
        const expected = createHmac('sha256', config.line.channelSecret).update(rawBody).digest('base64');
        const a = Buffer.from(expected);
        const b = Buffer.from(signature);
        return a.length === b.length && timingSafeEqual(a, b);
    }
    async createRichMenu(spec) {
        const id = `richmenu-mock-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
        // eslint-disable-next-line no-console
        console.log(`[line:mock] createRichMenu "${spec.name}" (${spec.areas.length} areas) -> ${id}`);
        return id;
    }
    async uploadRichMenuImage(richMenuId, image, mime) {
        // eslint-disable-next-line no-console
        console.log(`[line:mock] uploadRichMenuImage ${richMenuId} (${mime}, ${image.length} bytes)`);
    }
    async setDefaultRichMenu(richMenuId) {
        // eslint-disable-next-line no-console
        console.log(`[line:mock] setDefaultRichMenu ${richMenuId}`);
    }
    async deleteRichMenu(richMenuId) {
        // eslint-disable-next-line no-console
        console.log(`[line:mock] deleteRichMenu ${richMenuId}`);
    }
}
//# sourceMappingURL=mock.js.map