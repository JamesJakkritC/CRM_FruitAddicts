import './_env.ts';
import { closeDb, openDb, getDb } from '../src/db/index.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { ensureSettingsSeeded } from '../src/domain/settings.ts';
import { ensurePolicySeeded } from '../src/domain/policy.ts';
import { ensureTiersSeeded } from '../src/domain/membership.ts';
import { upsertBranch } from '../src/domain/branches.ts';
import { createMember, type Member } from '../src/domain/members.ts';

/** Reset to a fresh in-memory DB with schema, seeded settings, and one branch. */
export function freshDb(): void {
  closeDb();
  openDb(':memory:');
  runMigrations();
  ensureSettingsSeeded();
  ensurePolicySeeded();
  ensureTiersSeeded();
  upsertBranch({ id: 'b1', name: 'Branch 1', isHq: true });
  upsertBranch({ id: 'b2', name: 'Branch 2' });
}

export function makeMember(lineUserId = 'U1'): Member {
  return createMember({ lineUserId, displayName: 'Tester', homeBranchId: 'b1' });
}

export { getDb };
