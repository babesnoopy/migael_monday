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

function run() {
  let removed = 0;
  for (const title of DEBRIS_TITLES) {
    const existing = db.get(`SELECT id FROM tasks WHERE title = ?`, [title]);
    if (existing) {
      db.run(`DELETE FROM tasks WHERE id = ?`, [existing.id]);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[fixTestDebris] Removed ${removed} leftover test task(s).`);
  }
}

module.exports = { run };
