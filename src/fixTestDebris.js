// One-time cleanup: a handful of task rows left over from Migael's own
// dev/testing sessions (not real team work) — confirmed via the live
// sheet on 2026-08-02 that none of these titles exist there, so they're
// not "unassigned real work", just test debris that kept showing up in
// the "ยังไม่ระบุผู้รับผิดชอบ" bucket of every summary. Safe to run
// repeatedly — no-op once these are gone.
const db = require('./db');

const DEBRIS_TITLES = [
  '[TEST] Migael write test - ignore',
  'เทส',
  'ตัด reels workshop Duangdee (สบายๆ ง่ายๆ ไม่ต้องจิงจัง ให้ดู friendly)',
];

// Known duplicate task ROWS (not people this time) — same title, minor
// tone-mark difference, both ended up correctly assigned to babe but as
// two separate rows since the title-matching predates the normalizeTitle
// fix in sheetSync.js. Deleting by exact id (not title text) to avoid
// any risk of a Thai-transcription mistake matching the wrong row.
// Confirmed via /debug/find-task on 2026-08-02: kept id 2f8a36e1...
// (due_date set, matches the sheet's current title exactly), removing
// the older f1599d09... (due_date null, old "เช่๊ค" spelling).
const DEBRIS_IDS = [
  'f1599d09-6a42-45ba-b6fe-96d0c15463ee',
];

// Babe's explicit instruction (2026-08-02): task data should come from
// the sheet only, one source, to avoid confusion. The old one-time
// seed.js import (note='seed:checklist-v1') predates sheetSync.js and
// is now fully redundant — anything still genuinely in the sheet gets
// re-imported properly (with correct assignee/status) by sheetSync
// anyway. Confirmed case: "Post promote session dome 1" was seed-only
// debris, not present in the current sheet at all, kept showing as
// perpetually overdue with no way to close it from the sheet side.
function removeSeedData() {
  const seedTasks = db.all(`SELECT id FROM tasks WHERE note = 'seed:checklist-v1'`);
  for (const t of seedTasks) db.run(`DELETE FROM tasks WHERE id = ?`, [t.id]);
  return seedTasks.length;
}

function run() {
  let removed = 0;
  for (const title of DEBRIS_TITLES) {
    const existing = db.get(`SELECT id FROM tasks WHERE title = ?`, [title]);
    if (existing) {
      db.run(`DELETE FROM tasks WHERE id = ?`, [existing.id]);
      removed++;
    }
  }
  for (const id of DEBRIS_IDS) {
    const existing = db.get(`SELECT id FROM tasks WHERE id = ?`, [id]);
    if (existing) {
      db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
      removed++;
    }
  }
  removed += removeSeedData();
  if (removed > 0) {
    console.log(`[fixTestDebris] Removed ${removed} leftover test task(s).`);
  }
}

module.exports = { run };
