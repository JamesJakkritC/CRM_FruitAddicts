// No-import env preamble for HTTP-level tests (loaded before src/config.ts).
process.env.DB_FILE = ':memory:';
process.env.LINE_PROVIDER = 'mock';
process.env.LINE_CHANNEL_SECRET = 'test-webhook-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_BOOTSTRAP_USERNAME = 'admin';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'admin-pilot-8chars';
process.env.POINT_EARN_BAHT_PER_POINT = '50';
process.env.POINT_REDEEM_BAHT_PER_POINT = '1';
process.env.POINT_EXPIRY_DAYS = '365';
export {};
