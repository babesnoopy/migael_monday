// seed.js — one-time import of the team's existing UNFEST'26_CHECKLIST
// task list, so Migael starts already aware of what's in flight instead
// of an empty board. Only titles + status + due date are imported (no
// assignee/department/project) — Babe asked to keep this separate from
// the new team/department system being built, so nothing here gets
// auto-linked to a person or team. Runs once: guarded by a marker note
// on each inserted row, safe to call on every startup.
//
// group_id is stored on each row for reference only — task/event data is
// NOT filtered by group_id anywhere anymore (see groupState.js
// getPrimaryGroupId), so which group_id ends up here doesn't affect
// whether these tasks show up when someone asks "งานวันนี้มีอะไรบ้าง".
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('./db');
const gs = require('./groupState');

const SEED_FILE = path.join(__dirname, '..', 'seed-tasks.json');
const SEED_MARKER = 'seed:checklist-v1';

function mapStatus(rawStatus) {
  const s = (rawStatus || '').trim();
  if (s.includes('เสร็จ') && !s.includes('ยังไม่')) return { status: 'done', completed: true };
  if (s.includes('กำลังทำ')) return { status: 'in_progress', completed: false };
  if (s.includes('ตรวจ')) return { status: 'review', completed: false };
  return { status: 'to_do', completed: false };
}

function run() {
  if (!fs.existsSync(SEED_FILE)) return;

  const already = db.get(`SELECT id FROM tasks WHERE note = ? LIMIT 1`, [SEED_MARKER]);
  if (already) return; // already imported — don't duplicate on every restart

  let items;
  try {
    items = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  } catch (err) {
    console.error('[seed] Failed to read seed-tasks.json:', err.message);
    return;
  }
  if (!Array.isArray(items) || !items.length) return;

  const groupId = gs.getPrimaryGroupId();

  for (const item of items) {
    if (!item.title) continue;
    const { status, completed } = mapStatus(item.status);
    const id = randomUUID();
    db.run(
      `INSERT INTO tasks (id, title, status, due_date, note, completed_at, group_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        item.title,
        status,
        item.due_date || null,
        SEED_MARKER,
        completed ? (item.due_date || null) : null,
        groupId,
      ]
    );
  }
  console.log(`[seed] Imported ${items.length} tasks from UNFEST'26_CHECKLIST (titles/status/due date only, no assignee/team).`);
}

module.exports = { run };
