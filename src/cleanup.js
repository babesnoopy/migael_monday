// cleanup.js — ONE-TIME wipe of everything created during testing
// (test meetings, test tasks, test topics/sessions), keeping only the
// 46 tasks imported from UNFEST'26_CHECKLIST as the real baseline.
// Guarded by a marker file on the persisted volume so it only ever runs
// once — after this, real data created going forward is never touched.
const fs = require('fs');
const path = require('path');
const db = require('./db');

const MARKER = path.join(__dirname, '..', 'data', '.cleanup-testdata-v2-done');
const SEED_MARKER = 'seed:checklist-v1';

function run() {
  if (fs.existsSync(MARKER)) return;

  db.run(`DELETE FROM event_attendees`);
  db.run(`DELETE FROM reminders WHERE ref_type = 'event'`);
  db.run(`DELETE FROM events`);

  db.run(`DELETE FROM reminders WHERE ref_type = 'task' AND ref_id NOT IN (SELECT id FROM tasks WHERE note = ?)`, [SEED_MARKER]);
  db.run(`DELETE FROM tasks WHERE note IS NULL OR note != ?`, [SEED_MARKER]);

  db.run(`DELETE FROM topic_participants`);
  db.run(`DELETE FROM topics`);
  db.run(`DELETE FROM listening_sessions`);

  if (!fs.existsSync(path.dirname(MARKER))) fs.mkdirSync(path.dirname(MARKER), { recursive: true });
  fs.writeFileSync(MARKER, new Date().toISOString());
  console.log('[cleanup] Wiped test meetings/tasks/topics — kept only the seeded checklist tasks.');
}

module.exports = { run };
