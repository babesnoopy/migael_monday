// One-time fix: before the sheet-name-to-LINE-name alias map existed in
// sheetSync.js (KOBORED->พี่กบ, PEARY->แพร, NATAVAN->พี่มิ้ว, PAT->Pat,
// TUM->Tum, CAN->แคน, BABE->babe), every sync created a separate pseudo-
// user per raw sheet spelling. Tasks already linked to those stale
// pseudo-users don't get corrected by the now-fixed sync logic alone,
// since that only re-resolves assignee on tasks whose TITLE still
// matches a current sheet row — a task under an old duplicate whose
// title has since been edited in the sheet (confirmed case: "เช่๊คอังกริดของ..."
// -> "เช๊คอังกริดของ...", one tone mark different) never gets touched
// again and sits there as an orphaned duplicate person forever.
//
// This reassigns any task still pointing at a known stale pseudo-user
// over to the real canonical user, then removes the now-empty pseudo-
// user row. Safe to run repeatedly — it's a no-op once there's nothing
// left to merge.
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
  let mergedTasks = 0;
  const count = db.get(`SELECT COUNT(*) as c FROM tasks WHERE assignee_id = ?`, [staleId])?.c || 0;
  if (count > 0) {
    db.run(`UPDATE tasks SET assignee_id = ? WHERE assignee_id = ?`, [canonicalId, staleId]);
    mergedTasks += count;
  }
  // group_members has a (group_id, user_id) relationship — move any
  // membership row over too, so the canonical id is recognized as a
  // member of whatever group the stale id was linked to, rather than
  // silently losing that membership when the stale row gets deleted.
  db.run(`UPDATE OR IGNORE group_members SET user_id = ? WHERE user_id = ?`, [canonicalId, staleId]);
  db.run(`DELETE FROM group_members WHERE user_id = ?`, [staleId]); // any leftover (would only remain if canonical was already in that same group — a real dupe row, safe to drop)

  const stillReferenced = db.get(`SELECT 1 FROM tasks WHERE assignee_id = ? LIMIT 1`, [staleId])
    || db.get(`SELECT 1 FROM group_members WHERE user_id = ? LIMIT 1`, [staleId]);
  let removed = 0;
  if (!stillReferenced) {
    db.run(`DELETE FROM users WHERE id = ?`, [staleId]);
    removed = 1;
  }
  return { mergedTasks, removed };
}

// General pass: any two (or more) user rows sharing the exact same
// display_name are almost certainly the same real person who ended up
// with two different ids — confirmed live cases: พี่กบ (Ubaa5d75... vs
// Ubf336464..., both real-LINE-format ids — how a single person got two
// is unclear, but merging by name is the safe fix either way) and
// พี่มิ้ว (a real onboarded id vs a UUID-format pseudo-user id from an
// earlier sheetSync run predating the alias map). Runs AFTER the
// specific ALIASES pass below so sheet-spelling variants are already
// folded into their real display name first.
function mergeGeneralDuplicateNames() {
  let mergedTasks = 0;
  let removedUsers = 0;
  const groupId = gs.getPrimaryGroupId();

  const byName = new Map();
  for (const u of db.all(`SELECT id, display_name FROM users`)) {
    if (!u.display_name) continue;
    if (!byName.has(u.display_name)) byName.set(u.display_name, []);
    byName.get(u.display_name).push(u.id);
  }

  for (const [name, ids] of byName.entries()) {
    if (ids.length < 2) continue;
    // Prefer keeping whichever id is currently a member of the live
    // primary group (that's the identity LINE mentions/replies need to
    // match); otherwise just keep the first and merge the rest into it.
    const groupMember = groupId && ids.find((id) => db.get(`SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?`, [groupId, id]));
    const keepId = groupMember || ids[0];
    for (const id of ids) {
      if (id === keepId) continue;
      const { mergedTasks: mt, removed } = mergeUser(id, keepId);
      mergedTasks += mt;
      removedUsers += removed;
    }
  }
  return { mergedTasks, removedUsers };
}

function run() {
  let mergedTasks = 0;
  let removedUsers = 0;

  for (const [staleName, canonicalName] of Object.entries(ALIASES)) {
    const stale = db.get(`SELECT id FROM users WHERE display_name = ?`, [staleName]);
    if (!stale) continue; // nothing stale left under this exact spelling

    const canonical = db.get(`SELECT id FROM users WHERE display_name = ?`, [canonicalName]);
    if (!canonical || canonical.id === stale.id) continue;

    const { mergedTasks: mt, removed } = mergeUser(stale.id, canonical.id);
    mergedTasks += mt;
    removedUsers += removed;
  }

  const general = mergeGeneralDuplicateNames();
  mergedTasks += general.mergedTasks;
  removedUsers += general.removedUsers;

  if (mergedTasks > 0 || removedUsers > 0) {
    console.log(`[fixDuplicateAssignees] Merged ${mergedTasks} task(s) onto canonical users, removed ${removedUsers} stale duplicate user row(s).`);
  }
}

module.exports = { run };
