// calendarSeed.js — populates the `calendars` table with REAL Google
// Calendar IDs, fetched live from the account's calendar list.
//
// This fixes a bug that was silently active the entire testing session:
// schema.sql never seeded any calendar rows (it only defines the table),
// and the real IDs someone inserted existed only in the local dev
// database — never in production. So every event-creation lookup here
// was failing (both the specific match AND the UNCRLAB fallback), and
// silently landing in the personal 'primary' calendar every single
// time, regardless of what calendar_name Claude picked. Runs on every
// startup (idempotent upsert) so it also self-heals if a calendar gets
// renamed in Google Calendar later.
const { randomUUID } = require('crypto');
const db = require('./db');
const calendarApi = require('./calendar');

// Maps a substring to look for in the real Google Calendar's name -> the
// name we store + the calendar_purpose tag. Order doesn't matter; each
// real calendar is matched against these once.
// Kept loose on purpose — real calendar names in the account turned out
// to have inconsistent spacing/typos/stray characters (e.g. "SET UP /
// DEC" with a space, "๊๊UNFES'26: CONTENT" with stray Thai diacritics
// and a missing T) that stricter patterns silently failed to match.
const TARGETS = [
  { match: (name) => /UNCRLAB/i.test(name || ''), name: 'UNCRLAB', purpose: 'team' },
  { match: (name) => /UNCOMMU/i.test(name || ''), name: 'UNCOMMU', purpose: 'activity' },
  { match: (name) => /MEETING/i.test(name || ''), name: "UNFEST'26: MEETING", purpose: 'meeting' },
  { match: (name) => /PRODUCTION/i.test(name || ''), name: "UNFEST'26: PRODUCTION", purpose: 'production' },
  { match: (name) => /SET.?UP.*DEC|DEC.*SET.?UP/i.test(name || ''), name: "UNFEST'26: SETUP/DEC", purpose: 'setup' },
  { match: (name) => /CONTENT/i.test(name || ''), name: "UNFEST'26: CONTENT", purpose: 'content' },
  // The plain overview calendar (no suffix) — for genuinely festival-wide
  // items that don't belong to one specific department.
  { match: (name) => /^UNFEST.?26$/i.test((name || '').trim()), name: "UNFEST'26", purpose: 'general' },
];

async function run() {
  try {
    const realCalendars = await calendarApi.listCalendars();
    if (!realCalendars.length) {
      console.error('[CalendarSeed] listCalendars() returned nothing — check Calendar API access.');
      return;
    }

    let matched = 0;
    for (const target of TARGETS) {
      const found = realCalendars.find((c) => target.match(c.name));
      if (!found) {
        console.error(`[CalendarSeed] No real calendar found matching "${target.name}" — event routing for it will fall back.`);
        continue;
      }
      const existing = db.get(`SELECT id FROM calendars WHERE name = ?`, [target.name]);
      if (existing) {
        // Self-heal: the real Google Calendar ID may have changed.
        db.run(`UPDATE calendars SET id = ?, calendar_purpose = ? WHERE name = ?`, [found.id, target.purpose, target.name]);
      } else {
        db.run(
          `INSERT INTO calendars (id, name, calendar_purpose) VALUES (?, ?, ?)`,
          [found.id, target.name, target.purpose]
        );
      }
      matched++;
    }
    console.log(`[CalendarSeed] Matched ${matched}/${TARGETS.length} real calendars into the calendars table.`);
  } catch (err) {
    console.error('[CalendarSeed] Failed:', err.message);
  }
}

module.exports = { run };
