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
  // "Post promote session dome 1 (Post หัวค่ำ)" — confirmed via
  // /debug/find-task (2026-08-02) this was NOT seed data as first
  // assumed; note was NULL, created_at 2026-08-01 08:04, i.e. a
  // chat-created task from early dev testing that predates D-Phase2's
  // sheet write-back existing — it never made it into the sheet and
  // has no real-world counterpart there now, so kept showing as an
  // un-closeable "overdue" item with no way to resolve it from the
  // sheet side.
  '7344d053-886a-4a84-85ca-ef6f7c5c749d',
];

// Babe's explicit instruction (2026-08-02): task data should come from
// the sheet only, one source, to avoid confusion. The old one-time
// seed.js import (note='seed:checklist-v1') predates sheetSync.js and
// is now fully redundant — anything still genuinely in the sheet gets
// re-imported properly (with correct assignee/status) by sheetSync
// anyway.
function removeSeedData() {
  const seedTasks = db.all(`SELECT id FROM tasks WHERE note = 'seed:checklist-v1'`);
  for (const t of seedTasks) db.run(`DELETE FROM tasks WHERE id = ?`, [t.id]);
  return seedTasks.length;
}

// Permanent, automatic duplicate-task cleanup (2026-08-06) — runs every
// boot, not a one-off. sheetSync.js's own matching only ever "sees" one
// representative task per normalized title in the Map it builds (a plain
// JS Map can't hold two entries under the same key), so if duplicate
// rows already exist in the DB (e.g. from a sync that ran before an
// assignee got merged, splitting the same real task across two
// different assignee ids), sheetSync silently never notices or cleans
// up the orphaned copy — it just keeps existing invisibly. The one-off
// bulk cleanups done manually on 2026-08-04 and 2026-08-06 fixed the
// state at that moment but nothing stopped it from recurring. This does
// the same dedup logic automatically on every boot: same normalized
// title + same assignee + still active = keep one (prefer a sheet-sync
// row, then the most recently created), delete the rest. Calendar
// cleanup is deliberately left out here (slow network calls don't
// belong in the boot sequence) — any orphaned Calendar event from a
// deleted duplicate is a much smaller problem than a duplicate task
// showing up in every summary, and can be cleaned up manually if it
// ever matters.
function normalizeTaskTitle(t) {
  return (t || '').trim().toLowerCase().replace(/[\u0E48-\u0E4B]/g, '').replace(/\s+/g, ' ');
}
function dedupeDuplicateTasks() {
  // Group by normalized DISPLAY NAME, not raw assignee_id — confirmed
  // live (2026-08-06) that one real person (OAK) can have two different
  // user ids representing them (a real onboarded LINE account + a
  // sheet-only pseudo-user), both showing the same display_name after
  // the case-insensitive merge fix, but still different ids — so
  // grouping by exact assignee_id alone missed these as "different
  // people" and never merged their duplicate tasks.
  const tasks = db.all(
    `SELECT t.id, t.title, t.assignee_id, t.note, t.created_at, u.display_name as assignee_name
     FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id
     WHERE t.status NOT IN ('done','cancelled')`
  );
  const groups = new Map();
  for (const t of tasks) {
    const nameKey = t.assignee_name ? t.assignee_name.trim().toLowerCase() : 'NONE';
    const key = normalizeTaskTitle(t.title) + '|||' + nameKey;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  let removed = 0;
  const REAL_LINE_ID = /^U[0-9a-f]{32}$/i;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Prefer keeping a row whose assignee has a real LINE id (so it can
    // actually be tagged), then prefer a sheet-sync row among those,
    // then fall back to the most recently created.
    const realIdOnes = group.filter((t) => t.assignee_id && REAL_LINE_ID.test(t.assignee_id));
    const pool = realIdOnes.length ? realIdOnes : group;
    const sheetSyncOnes = pool.filter((t) => t.note === 'sheet-sync');
    const keep = sheetSyncOnes.length ? sheetSyncOnes[sheetSyncOnes.length - 1] : pool[pool.length - 1];
    for (const t of group) {
      if (t.id === keep.id) continue;
      db.run(`DELETE FROM tasks WHERE id = ?`, [t.id]);
      removed++;
    }
  }
  return removed;
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
  removed += dedupeDuplicateTasks();
  if (removed > 0) {
    console.log(`[fixTestDebris] Removed ${removed} leftover test task(s).`);
  }
}

module.exports = { run, dedupeDuplicateTasks };
