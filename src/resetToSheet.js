// resetToSheet.js — ONE-TIME reset now that the group is live: wipes every
// event (test meetings/queue items created while testing tonight) and
// every task that didn't come from the sheet (seed import or later
// sheet-sync), so the sheet becomes the sole source of truth for tasks
// going forward. Topics (Collab/UNLIVE/UNCINEMA notes etc.) are real
// content, not test junk — left untouched.
const fs = require('fs');
const path = require('path');
const db = require('./db');

const MARKER = path.join(__dirname, '..', 'data', '.reset-to-sheet-v1-done');

function run() {
  if (fs.existsSync(MARKER)) return;

  db.run(`DELETE FROM event_attendees`);
  db.run(`DELETE FROM reminders WHERE ref_type = 'event'`);
  db.run(`DELETE FROM events`);

  db.run(`DELETE FROM reminders WHERE ref_type = 'task' AND ref_id NOT IN (SELECT id FROM tasks WHERE note IN ('seed:checklist-v1', 'sheet-sync'))`);
  db.run(`DELETE FROM tasks WHERE note IS NULL OR note NOT IN ('seed:checklist-v1', 'sheet-sync')`);

  if (!fs.existsSync(path.dirname(MARKER))) fs.mkdirSync(path.dirname(MARKER), { recursive: true });
  fs.writeFileSync(MARKER, new Date().toISOString());
  console.log('[resetToSheet] Wiped test events and non-sheet tasks — sheet is now the sole source for tasks.');
}

module.exports = { run };
