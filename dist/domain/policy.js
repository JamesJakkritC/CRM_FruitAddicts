import { getDb } from "../db/index.js";
import { getSetting, setSetting } from "./settings.js";
import { badRequest } from "../lib/errors.js";
export const POLICIES = [
    // --- Loyalty ---
    { key: 'loyalty.earn_baht_per_point', type: 'int', category: 'loyalty', default: 50, requiresApproval: true, description: 'บาทต่อ 1 แต้ม (เช่น 50 = ซื้อ 50 บาทได้ 1 แต้ม)' },
    { key: 'loyalty.redeem_baht_per_point', type: 'int', category: 'loyalty', default: 1, requiresApproval: true, description: 'มูลค่า 1 แต้ม เป็นบาท' },
    { key: 'loyalty.expiry_days', type: 'int', category: 'loyalty', default: 365, requiresApproval: true, description: 'อายุแต้ม (วัน) แบบ FIFO' },
    { key: 'loyalty.earn_basis', type: 'enum', category: 'loyalty', default: 'net', enumValues: ['net', 'gross'], requiresApproval: true, description: 'คิดแต้มจากยอดหลังส่วนลด (net) หรือก่อนส่วนลด (gross)' },
    { key: 'loyalty.expiry_compensation', type: 'bool', category: 'loyalty', default: false, requiresApproval: true, description: 'ชดเชยแต้มที่หมดอายุหรือไม่' },
    { key: 'loyalty.rules_approved', type: 'bool', category: 'loyalty', default: false, requiresApproval: false, description: 'เจ้าของยืนยันกติกาแต้มแล้วหรือยัง (ต้องเปิดเองหลังยืนยัน)' },
    // --- Coupon ---
    { key: 'coupon.max_per_transaction', type: 'int', category: 'coupon', default: 1, requiresApproval: true, description: 'จำนวนคูปองสูงสุดต่อ 1 บิล (1 = ไม่ stack)' },
    // --- Tiers ---
    { key: 'tiers.auto_enabled', type: 'bool', category: 'tiers', default: false, requiresApproval: true, description: 'เลื่อนระดับสมาชิกอัตโนมัติ (ปิดจนกว่าจะกำหนดเกณฑ์)' },
    { key: 'tiers.rules', type: 'json', category: 'tiers', default: { silver: { minSpendSatang: 0 }, gold: { minSpendSatang: 0 }, vip: { minSpendSatang: 0 } }, requiresApproval: true, description: 'เกณฑ์เลื่อนระดับ (ยอดสะสม/จำนวนครั้ง) เป็น JSON' },
    // --- Referral ---
    { key: 'referral.enabled', type: 'bool', category: 'referral', default: false, requiresApproval: true, description: 'เปิดระบบแนะนำเพื่อน' },
    { key: 'referral.reward', type: 'json', category: 'referral', default: { referrerPoints: 0, refereePoints: 0, minFirstPurchaseSatang: 0 }, requiresApproval: true, description: 'รางวัลผู้แนะนำ/ผู้ถูกแนะนำ และยอดซื้อขั้นต่ำที่ถือว่า qualified' },
    // --- PDPA ---
    { key: 'pdpa.require_marketing_consent', type: 'bool', category: 'pdpa', default: true, requiresApproval: false, description: 'ต้องมี marketing consent ก่อนใส่ในกลุ่ม broadcast (ค่าเริ่มต้นเปิดเพื่อความปลอดภัย)' },
    { key: 'pdpa.retention_days', type: 'int', category: 'pdpa', default: 0, requiresApproval: true, description: 'ลบข้อมูลส่วนตัว (anonymize) ของสมาชิกที่ไม่ซื้อเกิน N วัน โดยอัตโนมัติ (0 = ปิด) — worker รันให้' },
    // --- Receipts ---
    { key: 'receipts.notify_line_target', type: 'string', category: 'receipts', default: '', requiresApproval: false, description: 'LINE userId/groupId ของพนักงาน/ทีม ที่จะได้รับแจ้งเตือนเมื่อมีใบเสร็จรอตรวจ (เว้นว่าง = ไม่แจ้ง)' },
    { key: 'receipts.auto_approve_enabled', type: 'bool', category: 'receipts', default: true, requiresApproval: false, description: 'อนุมัติใบเสร็จอัตโนมัติเมื่อยอดต่ำกว่าเพดาน (จบที่ลูกค้าเลย ไม่ต้องรอพนักงาน)' },
    { key: 'receipts.auto_approve_max_satang', type: 'int', category: 'receipts', default: 20000, requiresApproval: false, description: 'เพดานยอด (สตางค์) ที่อนุมัติอัตโนมัติ — ต่ำกว่านี้ auto, ตั้งแต่นี้ขึ้นไปให้พนักงานตรวจ (20000 = 200 บาท)' },
];
const BY_KEY = new Map(POLICIES.map((p) => [p.key, p]));
function serialize(def, value) {
    switch (def.type) {
        case 'int':
        case 'string':
        case 'enum':
            return String(value);
        case 'bool':
            return value ? 'true' : 'false';
        case 'json':
            return JSON.stringify(value ?? null);
    }
}
function parse(def, raw) {
    switch (def.type) {
        case 'int':
            return Number(raw);
        case 'bool':
            return raw === 'true' || raw === '1';
        case 'string':
        case 'enum':
            return raw;
        case 'json':
            try {
                return JSON.parse(raw);
            }
            catch {
                return def.default;
            }
    }
}
/** Validate + coerce a user-supplied value against the policy definition. */
function coerce(def, value) {
    switch (def.type) {
        case 'int': {
            const n = typeof value === 'number' ? value : Number(value);
            if (!Number.isInteger(n))
                throw badRequest(`'${def.key}' must be an integer`);
            return n;
        }
        case 'bool': {
            if (typeof value === 'boolean')
                return value;
            if (value === 'true' || value === 'false')
                return value === 'true';
            throw badRequest(`'${def.key}' must be a boolean`);
        }
        case 'enum': {
            if (typeof value !== 'string' || !def.enumValues.includes(value)) {
                throw badRequest(`'${def.key}' must be one of: ${def.enumValues.join(', ')}`);
            }
            return value;
        }
        case 'string':
            if (typeof value !== 'string')
                throw badRequest(`'${def.key}' must be a string`);
            return value;
        case 'json':
            if (typeof value !== 'object' || value === null)
                throw badRequest(`'${def.key}' must be a JSON object`);
            return value;
    }
}
export function ensurePolicySeeded(db = getDb()) {
    for (const def of POLICIES) {
        if (getSetting(def.key, db) === undefined)
            setSetting(def.key, serialize(def, def.default), db);
    }
}
function getRaw(key, db) {
    const def = BY_KEY.get(key);
    if (!def)
        throw badRequest(`unknown policy key '${key}'`);
    const raw = getSetting(key, db);
    return raw === undefined ? def.default : parse(def, raw);
}
export function getPolicyInt(key, db = getDb()) {
    return getRaw(key, db);
}
export function getPolicyBool(key, db = getDb()) {
    return getRaw(key, db);
}
export function getPolicyString(key, db = getDb()) {
    return getRaw(key, db);
}
export function getPolicyJson(key, db = getDb()) {
    return getRaw(key, db);
}
export function setPolicy(key, value, db = getDb()) {
    const def = BY_KEY.get(key);
    if (!def)
        throw badRequest(`unknown policy key '${key}'`);
    setSetting(key, serialize(def, coerce(def, value)), db);
}
export function listPolicies(db = getDb()) {
    const grouped = {};
    for (const def of POLICIES) {
        const view = {
            key: def.key,
            type: def.type,
            category: def.category,
            value: getRaw(def.key, db),
            default: def.default,
            requiresApproval: def.requiresApproval,
            description: def.description,
        };
        if (def.enumValues)
            view.enumValues = def.enumValues;
        (grouped[def.category] ??= []).push(view);
    }
    return grouped;
}
//# sourceMappingURL=policy.js.map