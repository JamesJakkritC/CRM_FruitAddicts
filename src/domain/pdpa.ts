import type { DatabaseSync } from 'node:sqlite';
import { getDb, tx, now, asRows } from '../db/index.ts';
import { requireMember, memberExtra, type Member } from './members.ts';
import { getBalance, listLedger } from './points.ts';
import { listMemberTransactions } from './transactions.ts';
import { memberItems } from './pos_import.ts';
import type { Principal } from './rbac.ts';

export interface ConsentInput {
  service?: boolean;
  marketing?: boolean;
  version?: string | null;
}

/** Record a consent change on the member + append to the immutable consent log. */
export function setConsent(
  memberId: number,
  consent: ConsentInput,
  ctx: { source: 'signup' | 'liff' | 'admin'; actorId?: number | null },
): Member {
  return tx((db) => {
    const m = requireMember(memberId, db);
    const service = consent.service === undefined ? m.consent_service : consent.service ? 1 : 0;
    const marketing = consent.marketing === undefined ? m.consent_marketing : consent.marketing ? 1 : 0;
    const version = consent.version ?? m.consent_version;
    db.prepare(
      `UPDATE members SET consent_service=?, consent_marketing=?, consent_updated_at=?, consent_version=?, updated_at=? WHERE id=?`,
    ).run(service, marketing, now(), version, now(), memberId);
    db.prepare(
      `INSERT INTO consent_log(member_id, consent_service, consent_marketing, version, source, actor_user_id, created_at)
       VALUES(?,?,?,?,?,?,?)`,
    ).run(memberId, service, marketing, version, ctx.source, ctx.actorId ?? null, now());
    return requireMember(memberId, db);
  });
}

export function consentLog(memberId: number, db: DatabaseSync = getDb()): unknown[] {
  return asRows(db.prepare('SELECT * FROM consent_log WHERE member_id = ? ORDER BY id DESC').all(memberId));
}

/** May we send marketing to this member? (marketing consent + not anonymised) */
export function canMarketTo(member: Member): boolean {
  return member.consent_marketing === 1 && !member.anonymized_at && member.status === 'active';
}

/** All data held about a member (PDPA right of access / data portability). */
export function exportMemberData(memberId: number, db: DatabaseSync = getDb()): Record<string, unknown> {
  const m = requireMember(memberId, db);
  const profile = {
    member_code: m.member_code,
    line_user_id: m.line_user_id,
    display_name: m.display_name,
    nickname: m.nickname,
    phone: m.phone,
    birthday: m.birthday,
    birth_month: m.birth_month,
    birth_century: m.birth_century,
    home_branch_id: m.home_branch_id,
    tier: m.tier,
    status: m.status,
    created_at: m.created_at,
    custom_fields: memberExtra(m),
  };
  return {
    exported_at: now(),
    profile,
    consent: {
      service: m.consent_service === 1,
      marketing: m.consent_marketing === 1,
      updated_at: m.consent_updated_at,
      version: m.consent_version,
      history: consentLog(memberId, db),
    },
    points: { balance: getBalance(memberId, db), ledger: listLedger(memberId, 500, db) },
    transactions: listMemberTransactions(memberId, 200, db),
    coupon_redemptions: asRows(db.prepare('SELECT * FROM coupon_redemptions WHERE member_id = ?').all(memberId)),
    referrals: asRows(db.prepare('SELECT * FROM referrals WHERE referrer_member_id = ? OR referred_member_id = ?').all(memberId, memberId)),
    membership_purchases: asRows(db.prepare('SELECT * FROM membership_purchases WHERE member_id = ?').all(memberId)),
    tags: asRows(db.prepare('SELECT t.name FROM tags t JOIN member_tags mt ON mt.tag_id=t.id WHERE mt.member_id=?').all(memberId)),
    receipt_claims: asRows(db.prepare('SELECT id, receipt_code, receipt_date, status, points_awarded, created_at FROM receipt_claims WHERE member_id=?').all(memberId)),
    purchased_items: memberItems(memberId, 300, db),
  };
}

export interface AnonymizeResult {
  memberId: number;
  anonymizedAt: string;
}

/**
 * Erase a member's PII (PDPA right to erasure) while KEEPING financial records
 * (points ledger, transactions) which are needed for accounting and are already
 * de-identified once the profile is scrubbed. Idempotent: re-running is a no-op.
 */
export function anonymizeMember(memberId: number, ctx: { actorId?: number | null; reason?: string } = {}): AnonymizeResult {
  return tx((db) => {
    const m = requireMember(memberId, db);
    if (m.anonymized_at) return { memberId, anonymizedAt: m.anonymized_at };
    const ts = now();
    db.prepare(
      `UPDATE members SET display_name='(ลบข้อมูลแล้ว)', nickname=NULL, phone=NULL, line_user_id=NULL,
         birthday=NULL, birth_month=NULL, birth_century=NULL, extra_json=NULL,
         consent_service=0, consent_marketing=0, consent_updated_at=?, status='anonymized',
         anonymized_at=?, updated_at=? WHERE id=?`,
    ).run(ts, ts, ts, memberId);
    db.prepare(
      `INSERT INTO consent_log(member_id, consent_service, consent_marketing, version, source, actor_user_id, created_at)
       VALUES(?,0,0,?, 'admin', ?, ?)`,
    ).run(memberId, ctx.reason ?? 'anonymized', ctx.actorId ?? null, ts);
    return { memberId, anonymizedAt: ts };
  });
}

/**
 * Retention: anonymise members with no purchase in `days` days (0 = disabled).
 * Keeps aggregate history; removes stale PII. Intended to run from the worker.
 */
export function anonymizeInactive(days: number, actor?: Principal | null, db: DatabaseSync = getDb()): { anonymized: number } {
  if (!Number.isInteger(days) || days <= 0) return { anonymized: 0 };
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const stale = asRows<{ id: number }>(
    db.prepare(
      `SELECT id FROM members m
        WHERE anonymized_at IS NULL AND status <> 'anonymized' AND created_at < ?
          AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.member_id = m.id AND t.created_at >= ?)`,
    ).all(cutoff, cutoff),
  );
  for (const { id } of stale) anonymizeMember(id, { actorId: actor?.userId ?? null, reason: 'retention' });
  return { anonymized: stale.length };
}
