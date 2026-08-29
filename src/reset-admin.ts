import { openDb, getDb, now } from './db/index.ts';
import { config } from './config.ts';
import { runMigrations } from './db/migrate.ts';
import { ensureRolesSeeded, getUserByUsername, createUser } from './domain/users.ts';
import { hashPassword } from './lib/password.ts';

/**
 * Force the bootstrap super_admin to a known password. Unlike ensureBootstrapAdmin
 * (which only creates when no users exist), this ALWAYS sets the password — so if
 * an old database was seeded with a different password, login is fixed. Creates
 * the user if missing and guarantees the super_admin role + active status.
 *
 * Usage: node src/reset-admin.ts [username] [password]
 * Defaults come from ADMIN_BOOTSTRAP_USERNAME / ADMIN_BOOTSTRAP_PASSWORD (.env).
 */
export function resetAdmin(username: string, password: string): void {
  if (password.length < 8) {
    throw new Error('password must be at least 8 characters (set ADMIN_BOOTSTRAP_PASSWORD in .env)');
  }
  openDb();
  runMigrations();
  ensureRolesSeeded();
  const db = getDb();
  const existing = getUserByUsername(username, db);
  if (!existing) {
    createUser({ username, password, fullName: 'Bootstrap Admin', roles: ['super_admin'] });
  } else {
    db.prepare('UPDATE users SET password_hash = ?, status = ?, updated_at = ? WHERE id = ?').run(
      hashPassword(password),
      'active',
      now(),
      existing.id,
    );
    db.prepare("INSERT INTO user_roles(user_id, role) VALUES(?, 'super_admin') ON CONFLICT DO NOTHING").run(
      existing.id,
    );
  }
  console.log('==================================================');
  console.log(' Admin login is ready:');
  console.log(`   username: ${username}`);
  console.log(`   password: ${password}`);
  console.log('==================================================');
}

if (process.argv[1]?.endsWith('reset-admin.ts') || process.argv[1]?.endsWith('reset-admin.js')) {
  const username = process.argv[2] || config.bootstrap.username;
  const password = process.argv[3] || config.bootstrap.password;
  resetAdmin(username, password);
}
