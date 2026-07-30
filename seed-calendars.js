// seed-calendars.js — pre-loads the real projects + calendars Babeb gave us
// directly (no need to run list-calendars.js for these specific ones).
// Run once after `npm install` and before `npm start`:
//   node seed-calendars.js

const db = require('./src/db');

const PROJECTS = [
  { id: 'proj-uncommu', name: 'UNCOMMU' },
  { id: 'proj-uncrlab', name: 'UNCRLAB' },
  { id: 'proj-unfest26', name: 'UNFEST26' },
];

const CALENDARS = [
  {
    id: 'c_0561ccfdce6a55dba5906078aa7d8cd12b7272dfdc348cb9b6061ea0641a0cb3@group.calendar.google.com',
    name: 'UNCOMMU',
    project_id: 'proj-uncommu',
    calendar_purpose: null,
    requires_confirm: 0, // only calendar for this project — no ambiguity
  },
  {
    id: 'fb0653efc029e04953522227a22aba2285aa11ec3d1f23bc69ab81ae8c5dc8b8@group.calendar.google.com',
    name: 'UNCRLAB',
    project_id: 'proj-uncrlab',
    calendar_purpose: null,
    requires_confirm: 0,
  },
  {
    id: 'c_3a616f4f5613e33ee90422fa262e6f26c4911b78d4ab841806c6a987d6ef6a55@group.calendar.google.com',
    name: "UNFEST'26: CONTENT",
    project_id: 'proj-unfest26',
    calendar_purpose: 'content',
    requires_confirm: 0, // Migael auto-classifies by content; only asks if genuinely ambiguous
  },
  {
    id: 'a2fd126798db70b442fc64827beffd02e44a247b575424bb1be99a93684f8f4a@group.calendar.google.com',
    name: "UNFEST'26: MEETING",
    project_id: 'proj-unfest26',
    calendar_purpose: 'meeting',
    requires_confirm: 0,
  },
  {
    id: 'c_597cb82c889139723e15058f621982c205a687d02d439223d52b4fbb5551a404@group.calendar.google.com',
    name: "UNFEST'26: PRODUCTION",
    project_id: 'proj-unfest26',
    calendar_purpose: 'production',
    requires_confirm: 0,
  },
  {
    id: 'c_d9f951be00e1bc5356213d861232dfb56454a210db0a2c8c3a94155d3400860d@group.calendar.google.com',
    name: "UNFEST'26: SETUP/DEC",
    project_id: 'proj-unfest26',
    calendar_purpose: 'setup_decoration',
    requires_confirm: 0,
  },
];

(async () => {
  await db.init();

  for (const p of PROJECTS) {
    db.run(
      `INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)`,
      [p.id, p.name]
    );
  }

  for (const c of CALENDARS) {
    db.run(
      `INSERT OR IGNORE INTO calendars (id, name, project_id, calendar_purpose, requires_confirm)
       VALUES (?, ?, ?, ?, ?)`,
      [c.id, c.name, c.project_id, c.calendar_purpose, c.requires_confirm]
    );
  }

  console.log(`Seeded ${PROJECTS.length} projects and ${CALENDARS.length} calendars.`);
  console.log('Next: in each LINE group, an admin should type e.g.');
  console.log('  "มิเกล กลุ่มนี้คือโปรเจกต์ UNFEST26"');
  console.log('to link that group to its project (and therefore its calendars).');
})();
