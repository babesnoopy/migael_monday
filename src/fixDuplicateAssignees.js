// One-time (well — runs every boot, but converges to a no-op) fix for
// duplicate person records.
//
// IMPORTANT SAFETY LESSON (2026-08-02): an earlier version of this file
// DELETED the stale user row once nothing referenced it anymore. That
// caused a real incident — พี่กบ has two different LINE account ids
// (Ubaa5d75... and Ubf336464..., LINE profile name "Kobored" on the
// second one). The merge picked Ubaa5d75... as canonical and deleted
// Ubf336464..., but Ubf336464... turned out to be the account he's
// actually actively messaging from. The next time he sent a message,
// Migael found no matching user row, treated him as a brand-new person,
// and sent the full onboarding "please introduce yourself" greeting to
// someone who'd already onboarded — confusing and annoying for the team.
//
// Lesson: two different LINE account ids can both be genuinely, currently
// in use by the same real person (e.g. switching devices, a work vs
// personal LINE login). Deleting either one breaks recognition for
// whichever gets used next. Fix: NEVER delete a user row here. Instead,
// merge their tasks/membership onto one canonical id (so summaries show
// one person, not two), but leave BOTH id rows alive, rename the stale
// one's display_name to match canonical (so if a task ever does land on
// it directly, it still displays correctly), and copy onboarded_at/team_id
// onto it so a future message from that account never re-triggers
// onboarding again.
const db = require('./db');
const gs = require('./groupState');

const ALIASES = {
  KOBORED: 'พี่กบ',
  TUM: 'Tum',
  PAT: 'Pat',
  PEARY: 'แพร',
  NATAVAN: 'พี่มิ้ว',
  CAN: 'แคน',
  BABE: 'babe',
};

function mergeUser(staleId, canonicalId) {
  if (staleId === canonicalId) return { mergedTasks: 0 };
  const canonical = db.get(`SELECT display_name, team_id, onboarded_at FROM users WHERE id = ?`, [canonicalId]);
  if (!canonical) return { mergedTasks: 0 };

  let mergedTasks = 0;
  const count = db.get(`SELECT COUNT(*) as c FROM tasks WHERE assignee_id = ?`, [staleId])?.c || 0;
  if (count > 0) {
    db.run(`UPDATE tasks SET assignee_id = ? WHERE assignee_id = ?`, [canonicalId, staleId]);
    mergedTasks += count;
  }
  // Copy membership over too, so the canonical id is recognized as a
  // member of whatever group the stale id was linked to.
  db.run(`INSERT OR IGNORE INTO group_members (group_id, user_id) SELECT group_id, ? FROM group_members WHERE user_id = ?`, [canonicalId, staleId]);

  // Never delete the stale row (see file header) — instead make it look
  // and behave like the same person: same display name, same team,
  // already onboarded, so a message from either underlying LINE account
  // is treated identically and consistently from here on.
  db.run(
    `UPDATE users SET display_name = ?, team_id = COALESCE(team_id, ?), onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?`,
    [canonical.display_name, canonical.team_id, canonical.onboarded_at, staleId]
  );

  return { mergedTasks };
}

// General pass: any two (or more) user rows sharing the exact same
// display_name are almost certainly the same real person under two
// different LINE account ids. See file header for why we merge their
// data but keep both id rows alive rather than deleting either.
function mergeGeneralDuplicateNames() {
  let mergedTasks = 0;
  const groupId = gs.getPrimaryGroupId();

  const byName = new Map();
  for (const u of db.all(`SELECT id, display_name FROM users`)) {
    if (!u.display_name) continue;
    if (!byName.has(u.display_name)) byName.set(u.display_name, []);
    byName.get(u.display_name).push(u.id);
  }

  for (const [name, ids] of byName.entries()) {
    if (ids.length < 2) continue;
    const groupMember = groupId && ids.find((id) => db.get(`SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?`, [groupId, id]));
    const keepId = groupMember || ids[0];
    for (const id of ids) {
      if (id === keepId) continue;
      const { mergedTasks: mt } = mergeUser(id, keepId);
      mergedTasks += mt;
    }
  }
  return { mergedTasks };
}

function run() {
  let mergedTasks = 0;

  for (const [staleName, canonicalName] of Object.entries(ALIASES)) {
    const stale = db.get(`SELECT id FROM users WHERE display_name = ?`, [staleName]);
    if (!stale) continue;
    const canonical = db.get(`SELECT id FROM users WHERE display_name = ?`, [canonicalName]);
    if (!canonical || canonical.id === stale.id) continue;
    const { mergedTasks: mt } = mergeUser(stale.id, canonical.id);
    mergedTasks += mt;
  }

  const general = mergeGeneralDuplicateNames();
  mergedTasks += general.mergedTasks;

  if (mergedTasks > 0) {
    console.log(`[fixDuplicateAssignees] Merged ${mergedTasks} task(s) onto canonical users (no rows deleted).`);
  }
}

module.exports = { run };
