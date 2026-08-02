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

const ALIASES = {
  KOBORED: 'พี่กบ',
  TUM: 'Tum',
  PAT: 'Pat',
  PEARY: 'แพร',
  NATAVAN: 'พี่มิ้ว',
  CAN: 'แคน',
  BABE: 'babe',
};

function run() {
  let mergedTasks = 0;
  let removedUsers = 0;

  for (const [staleName, canonicalName] of Object.entries(ALIASES)) {
    const stale = db.get(`SELECT id FROM users WHERE display_name = ?`, [staleName]);
    if (!stale) continue; // nothing stale left under this exact spelling

    const canonical = db.get(`SELECT id FROM users WHERE display_name = ?`, [canonicalName]);
    if (!canonical || canonical.id === stale.id) continue;

    const count = db.get(`SELECT COUNT(*) as c FROM tasks WHERE assignee_id = ?`, [stale.id])?.c || 0;
    if (count > 0) {
      db.run(`UPDATE tasks SET assignee_id = ? WHERE assignee_id = ?`, [canonical.id, stale.id]);
      mergedTasks += count;
    }

    // Only remove the stale user row if nothing else still references it
    // (group_members, other tables) — leave it alone rather than risk an
    // orphaned foreign key if it's tied to something this fix didn't
    // anticipate.
    const stillReferenced = db.get(`SELECT 1 FROM tasks WHERE assignee_id = ? LIMIT 1`, [stale.id])
      || db.get(`SELECT 1 FROM group_members WHERE user_id = ? LIMIT 1`, [stale.id]);
    if (!stillReferenced) {
      db.run(`DELETE FROM users WHERE id = ?`, [stale.id]);
      removedUsers++;
    }
  }

  if (mergedTasks > 0 || removedUsers > 0) {
    console.log(`[fixDuplicateAssignees] Merged ${mergedTasks} task(s) onto canonical users, removed ${removedUsers} stale duplicate user row(s).`);
  }
}

module.exports = { run };
