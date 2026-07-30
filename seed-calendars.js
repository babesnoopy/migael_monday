// seed-calendars.js — pre-loads the real projects + calendars Babeb gave us
// directly (no need to run list-calendars.js for these specific ones).
// Run once after `npm install` and before `npm start`:
//   node seed-calendars.js

const db = require('./src/db');

// Superseded by the single UNFEST project below — kept here only so the
// migration step can retarget/remove rows left over from the old 3-project
// seed.
const LEGACY_PROJECT_IDS = ['proj-uncommu', 'proj-uncrlab', 'proj-unfest26'];

const PROJECTS = [
  { id: 'proj-unfest', name: 'UNFEST' },
];

const CALENDARS = [
  {
    id: 'c_0561ccfdce6a55dba5906078aa7d8cd12b7272dfdc348cb9b6061ea0641a0cb3@group.calendar.google.com',
    name: 'UNCOMMU',
    project_id: 'proj-unfest',
    calendar_purpose: null,
    requires_confirm: 0,
  },
  {
    id: 'fb0653efc029e04953522227a22aba2285aa11ec3d1f23bc69ab81ae8c5dc8b8@group.calendar.google.com',
    name: 'UNCRLAB',
    project_id: 'proj-unfest',
    calendar_purpose: null,
    requires_confirm: 0,
  },
  {
    id: 'c_3a616f4f5613e33ee90422fa262e6f26c4911b78d4ab841806c6a987d6ef6a55@group.calendar.google.com',
    name: "UNFEST'26: CONTENT",
    project_id: 'proj-unfest',
    calendar_purpose: 'content',
    requires_confirm: 0, // Migael auto-classifies by content; only asks if genuinely ambiguous
  },
  {
    id: 'a2fd126798db70b442fc64827beffd02e44a247b575424bb1be99a93684f8f4a@group.calendar.google.com',
    name: "UNFEST'26: MEETING",
    project_id: 'proj-unfest',
    calendar_purpose: 'meeting',
    requires_confirm: 0,
  },
  {
    id: 'c_597cb82c889139723e15058f621982c205a687d02d439223d52b4fbb5551a404@group.calendar.google.com',
    name: "UNFEST'26: PRODUCTION",
    project_id: 'proj-unfest',
    calendar_purpose: 'production',
    requires_confirm: 0,
  },
  {
    id: 'c_d9f951be00e1bc5356213d861232dfb56454a210db0a2c8c3a94155d3400860d@group.calendar.google.com',
    name: "UNFEST'26: SETUP/DEC",
    project_id: 'proj-unfest',
    calendar_purpose: 'setup_decoration',
    requires_confirm: 0,
  },
];

(async () => {
  await db.init();

  for (const p of PROJECTS) {
    db.run(
      `INSERT INTO projects (id, name) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
      [p.id, p.name]
    );
  }

  for (const c of CALENDARS) {
    db.run(
      `INSERT INTO calendars (id, name, project_id, calendar_purpose, requires_confirm)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         project_id = excluded.project_id,
         calendar_purpose = excluded.calendar_purpose,
         requires_confirm = excluded.requires_confirm`,
      [c.id, c.name, c.project_id, c.calendar_purpose, c.requires_confirm]
    );
  }

  // Retire the old per-sub-project rows now that every calendar points at
  // proj-unfest — safe as long as nothing else still references them.
  for (const legacyId of LEGACY_PROJECT_IDS) {
    const stillReferenced = db.get(
      `SELECT 1 FROM calendars WHERE project_id = ?
       UNION SELECT 1 FROM tasks WHERE project_id = ?
       UNION SELECT 1 FROM events WHERE project_id = ?
       UNION SELECT 1 FROM topics WHERE project_id = ?
       UNION SELECT 1 FROM teams WHERE project_id = ?
       UNION SELECT 1 FROM group_projects WHERE project_id = ?`,
      [legacyId, legacyId, legacyId, legacyId, legacyId, legacyId]
    );
    if (!stillReferenced) {
      db.run(`DELETE FROM projects WHERE id = ?`, [legacyId]);
    } else {
      console.log(`Skipped deleting legacy project ${legacyId} — still referenced elsewhere.`);
    }
  }

  console.log(`Seeded ${PROJECTS.length} project(s) and ${CALENDARS.length} calendars.`);
  console.log('Next: in each LINE group, an admin should type e.g.');
  console.log('  "มิเกล กลุ่มนี้คือโปรเจกต์ UNFEST"');
  console.log('to link that group to its project (and therefore its calendars).');
})();
