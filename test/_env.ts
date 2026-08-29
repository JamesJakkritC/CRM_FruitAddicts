// Loaded FIRST (before any config-importing module) so env is set before
// src/config.ts is evaluated. This file must have no imports.
process.env.DB_FILE = ':memory:';
process.env.LINE_PROVIDER = 'mock';
process.env.ADMIN_API_KEY = 'test-admin';
process.env.NODE_ENV = 'test';
process.env.POINT_EARN_BAHT_PER_POINT = '50';
process.env.POINT_REDEEM_BAHT_PER_POINT = '1';
process.env.POINT_EXPIRY_DAYS = '365';
process.env.LIFF_ID = '1234567890-testliff';
export {};
