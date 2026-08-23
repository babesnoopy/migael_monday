// sheetSync.js — periodic READ-ONLY sync from the UNFEST'26_CHECKLIST
// Google Sheet, so tasks the team adds directly in the sheet (bypassing
// LINE entirely) still show up in Migael instead of silently only living
// in the sheet until Babe notices. One-directional: Migael never writes
// back to the sheet (that needs a different OAuth scope + careful cell
// mapping so we don't break the sheet's formulas/dashboard — deferred).
//
// Rows are matched to tasks by title (case-insensitive). For a title
// Migael doesn't know yet, a new task is inserted. For a title she
// already has (e.g. from the original one-time seed, which only ever
// imported title/status/due date and never touched category), this also
// backfills team_id from the sheet's real "หมวดหมู่" column whenever
// that task doesn't have one yet — so tasks use the sheet's authoritative
// category instead of classify.js's keyword guess wherever real data
// exists for them.
const { google } = require('googleapis');
const { randomUUID } = require('crypto');
const db = require('./db');
const driveApi = require('./drive');
const { getAuth } = require('./calendar');

const SHEET_TAB = 'Task Tracker';
const SYNC_MARKER = 'sheet-sync';

// Column offsets within the fetched range 'L2:Z2000' (offset 0 = column L,
// which is index 11 in the sheet's full column list). Verified against
// the sheet's actual header row: L=วันที่เริ่มต้น, M=สิ่งที่ต้องทำ,
// N=โครงการ, O=หมวดหมู่, P=ผู้รับมอบหมาย, Q=สถานะ, R=ความสำคัญ,
// S=สำคัญ?, T=ด่วน?, U=ระดับความยาก, V=กำหนดเสร็จ.
// (An earlier version of this file had these offsets wrong — status and
// due date were being read from the wrong columns entirely.)
const COL = { startDate: 0, title: 1, category: 3, assignee: 4, status: 5, isUrgent: 8, dueDate: 10 };

function mapStatus(rawStatus) {
  const s = (rawStatus || '').trim();
  // Bug fix (2026-08-02, confirmed live): this never checked for
  // "ยกเลิก" (cancelled) or "ระงับชั่วคราว" (on hold) at all — every
  // status other than เสร็จ/กำลังทำ/ตรวจ silently fell through to
  // 'to_do', so a task cancelled directly in the sheet (e.g. Pat's
  // "ทำรูป") kept showing up as an active task to do in every summary.
  if (s.includes('ยกเลิก')) return { status: 'cancelled', completed: false };
  if (s.includes('ระงับ')) return { status: 'on_hold', completed: false };
  if (s.includes('เสร็จ') && !s.includes('ยังไม่')) return { status: 'done', completed: true };
  if (s.includes('กำลังทำ')) return { status: 'in_progress', completed: false };
  if (s.includes('ตรวจ')) return { status: 'review', completed: false };
  return { status: 'to_do', completed: false };
}

function toIsoDate(raw) {
  if (!raw) return null;
  const m = String(raw).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(raw);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function isUrgentValue(raw) {
  const s = String(raw || '').trim().toUpperCase();
  return s === 'TRUE' || s === '✓' || s === 'YES';
}

// Same idea as index.js's resolveTeamId — find-or-create a team row by
// category name. Duplicated locally (rather than imported) since this
// module runs standalone from a cron job, not inside a request handler.
function resolveTeamId(categoryName) {
  if (!categoryName) return null;
  const clean = categoryName.trim();
  if (!clean) return null;
  let team = db.get(`SELECT id FROM teams WHERE name = ?`, [clean]);
  if (!team) {
    const teamId = randomUUID();
    db.run(`INSERT INTO teams (id, name) VALUES (?, ?)`, [teamId, clean]);
    team = { id: teamId };
  }
  return team.id;
}

// Same idea as resolveTeamId above — find-or-create a user row by the
// name in the sheet's "ผู้รับมอบหมาย" column. These are often people who
// never chatted with Migael directly (so they'd have no real LINE
// userId) — that's fine, this row exists purely so tasks can be grouped
// and displayed by name; it just can't be @mentioned in LINE since
// there's no real userId behind it. If that same person later
// introduces themselves in chat, onboarding matches by display_name and
// reuses this same row rather than creating a duplicate.
//
// Sheet names often don't match the name someone actually uses in LINE
// chat (different spelling/case, or an entirely different nickname) —
// e.g. the sheet's dropdown has "PAT" but chat onboarding recorded
// "Pat" (different case = different row without this), or "KOBORED"
// in the sheet vs "พี่กบ" in chat (not even close as strings). Since
// the sheet's dropdown is locked (can't just rename it to match), map
// known sheet names to the real chat display name here instead — told
// to us directly by Babe (2026-08-02), not guessed. "UNCR-LAB" is
// intentionally NOT mapped to a person — it's the sheet's own bucket
// for team/group work, not an individual.
const ASSIGNEE_ALIASES = {
  KOBORED: 'พี่กบ',
  TUM: 'Tum',
  PAT: 'แพท',
  PEARY: 'แพร',
  'CALL ME PEAR': 'แพร',
  PEAR: 'แพร',
  NATAVAN: 'พี่มิ้ว',
  CAN: 'แคน',
  BABE: 'babe',
  OAK: 'โอ็ค',
};

// Applies the same ASSIGNEE_ALIASES canonicalization as resolveAssigneeId,
// without touching the DB — needed anywhere we build a comparison key
// against a raw sheet cell value (e.g. "KOBORED") that must match the
// canonical name actually stored on users (e.g. "พี่กบ"). Confirmed live
// (2026-08-08) that skipping this made the sheet-deletion dry-run flag
// ~half the active board as "removed", since raw sheet aliases never
// matched their resolved display_name counterparts.
function canonicalAssigneeName(name) {
  if (!name) return null;
  const clean = name.trim();
  if (!clean) return null;
  return ASSIGNEE_ALIASES[clean.toUpperCase()] || clean;
}

function resolveAssigneeId(name) {
  if (!name) return null;
  const clean = name.trim();
  if (!clean) return null;
  const canonical = ASSIGNEE_ALIASES[clean.toUpperCase()] || clean;
  // Case-insensitive lookup — confirmed live (2026-08-06) that "OAK" vs
  // "Oak" (inconsistent capitalization across sheet cells for the same
  // person) created two separate pseudo-user rows on different sync
  // runs, since the old exact-match lookup treated them as different
  // people. Casing alone is never a real distinction.
  const existing = db.get(`SELECT id FROM users WHERE LOWER(display_name) = LOWER(?)`, [canonical]);
  if (existing) return existing.id;
  const id = randomUUID();
  db.run(`INSERT INTO users (id, display_name) VALUES (?, ?)`, [id, canonical]);
  return id;
}

// Strips Thai tone marks (่ ้ ๊ ๋, U+0E48-U+0E4B) and collapses
// whitespace before matching a sheet title against existing tasks.
// Confirmed cause of two separate duplicate-task incidents (2026-08-02):
// someone lightly editing a title in the sheet — e.g. "เช่๊คอังกริดของ..."
// -> "เช๊คอังกริดของ..." (one tone mark removed) — made the exact-match
// title lookup treat it as a brand-new task, leaving the old one
// orphaned under the old spelling forever. This doesn't fix titles
// that change more substantially (that's a genuinely different task
// name and should create a new row), just tolerates minor tone-mark-
// level edits so re-typing a word doesn't fork the task in two.
function normalizeTitle(title) {
  return title.trim().toLowerCase().replace(/[\u0E48-\u0E4B]/g, '').replace(/\s+/g, ' ');
}

async function findSpreadsheetId() {
  if (process.env.UNFEST_CHECKLIST_SHEET_ID) return process.env.UNFEST_CHECKLIST_SHEET_ID;
  const results = await driveApi.search("UNFEST'26_CHECKLIST");
  const match = results.find((r) => !r.isFolder) || results[0];
  if (!match?.link) return null;
  const m = match.link.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

// Read-only dry-run of the deletion logic in run() — fetches the sheet,
// builds the same seenInSheet set, and reports which sheet-synced DB
// tasks would be deleted, WITHOUT deleting anything. Used to sanity-
// check the feature against real data before trusting it to run live.
async function previewDeletions() {
  const spreadsheetId = await findSpreadsheetId();
  if (!spreadsheetId) return { error: 'sheet not found' };
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_TAB}'!L2:Z2000`,
  });
  const rows = res.data.values || [];
  const seenInSheet = new Set();
  for (const row of rows) {
    const title = row[COL.title]?.trim();
    if (!title || title === 'สิ่งที่ต้องทำ') continue;
    const assigneeName = row[COL.assignee]?.trim() || null;
    seenInSheet.add(normalizeTitle(title) + '|||' + (canonicalAssigneeName(assigneeName) || '').trim().toLowerCase());
  }
  const syncedTasks = db.all(`SELECT id, title, assignee_id, status FROM tasks WHERE note = ?`, [SYNC_MARKER]);
  const wouldDelete = [];
  for (const t of syncedTasks) {
    const assignee = t.assignee_id ? db.get(`SELECT display_name FROM users WHERE id = ?`, [t.assignee_id]) : null;
    const key = normalizeTitle(t.title) + '|||' + (assignee?.display_name || '').trim().toLowerCase();
    if (!seenInSheet.has(key)) {
      wouldDelete.push({ id: t.id, title: t.title, assignee: assignee?.display_name || null, status: t.status });
    }
  }
  return { totalSheetSynced: syncedTasks.length, wouldDeleteCount: wouldDelete.length, wouldDelete };
}

async function run() {
  try {
    const spreadsheetId = await findSpreadsheetId();
    if (!spreadsheetId) {
      console.error('[SheetSync] Could not find UNFEST\'26_CHECKLIST in Drive.');
      return;
    }

    const sheets = google.sheets({ version: 'v4', auth: getAuth() });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${SHEET_TAB}'!L2:Z2000`,
    });
    const rows = res.data.values || [];

    const existingTasks = new Map(
      db.all(`SELECT id, title, team_id, assignee_id, start_date, status, note FROM tasks`).map((t) => [normalizeTitle(t.title), t])
    );

    let importedCount = 0;
    let categorizedCount = 0;
    let assignedCount = 0;
    let statusSyncedCount = 0;
    // Tracks every (title+assignee) key actually present in THIS sync
    // pass, so we can tell afterward which previously-imported rows
    // disappeared from the sheet entirely (as opposed to just changing
    // status) — see the deletion pass after this loop.
    const seenInSheet = new Set();

    for (const row of rows) {
      const title = row[COL.title]?.trim();
      if (!title || title === 'สิ่งที่ต้องทำ') continue; // blank row or a repeated header

      const category = row[COL.category]?.trim() || null;
      const assigneeName = row[COL.assignee]?.trim() || null;
      const key = normalizeTitle(title);
      seenInSheet.add(key + '|||' + (canonicalAssigneeName(assigneeName) || '').trim().toLowerCase());
      const existing = existingTasks.get(key);

      const startDate = toIsoDate(row[COL.startDate]);
      const dueDate = toIsoDate(row[COL.dueDate]);
      const { status, completed } = mapStatus(row[COL.status]);

      if (existing) {
        // The sheet is the source of truth once a task exists there —
        // if the team checks something off (or changes its status) in
        // the sheet directly, that MUST be reflected here too. Earlier
        // versions only backfilled missing fields on existing tasks and
        // never touched status, so completed work kept showing as
        // outstanding in every summary/report forever.
        if (existing.status !== status) {
          db.run(
            `UPDATE tasks SET status = ?, due_date = COALESCE(?, due_date), completed_at = CASE WHEN ? = 'done' THEN COALESCE(completed_at, ?) ELSE completed_at END WHERE id = ?`,
            [status, dueDate, status, dueDate, existing.id]
          );
          statusSyncedCount++;
        }
        if (!existing.team_id && category) {
          db.run(`UPDATE tasks SET team_id = ? WHERE id = ?`, [resolveTeamId(category), existing.id]);
          categorizedCount++;
        }
        // Bug fix: assignee was never imported from the sheet at all
        // (COL had no entry for the "ผู้รับมอบหมาย" column) — every
        // sheet-synced task showed up as "ยังไม่ระบุผู้รับผิดชอบ"
        // (unassigned) in the morning summary/check-in/evening recap,
        // even though the sheet clearly had a name in that column for
        // almost every row. Backfill it here the same way category is
        // backfilled, so tasks imported before this fix get corrected
        // on the very next sync rather than needing a manual reset.
        // Always re-resolve (not just backfill-when-null) so tasks that
        // got wrongly linked to a duplicate pseudo-user before the alias
        // map existed (e.g. a separate "PAT" row instead of merging with
        // "Pat") self-correct on the next sync too.
        if (assigneeName) {
          const resolvedAssigneeId = resolveAssigneeId(assigneeName);
          if (existing.assignee_id !== resolvedAssigneeId) {
            db.run(`UPDATE tasks SET assignee_id = ? WHERE id = ?`, [resolvedAssigneeId, existing.id]);
            assignedCount++;
          }
        }
        if (!existing.start_date && startDate) {
          db.run(`UPDATE tasks SET start_date = ? WHERE id = ?`, [startDate, existing.id]);
        }
        // This title now exists in the sheet — if it was previously a
        // chat-only task (note IS NULL, meaning "still needs to be added
        // to the main sheet"), clear that flag now that it's confirmed
        // present there. This is what makes the "needs adding to sheet"
        // marker in reports.js disappear once Babe actually adds it,
        // rather than a naive day-based reset that could clear the flag
        // even if she forgot, or keep flagging something she already added.
        if (!existing.note) {
          db.run(`UPDATE tasks SET note = ? WHERE id = ?`, [SYNC_MARKER, existing.id]);
        }
        continue;
      }

      // New row Migael hasn't seen before — import it in full, category
      // and assignee included.
      const id = randomUUID();
      db.run(
        `INSERT INTO tasks (id, title, status, due_date, note, completed_at, team_id, assignee_id, is_urgent, start_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, title, status, dueDate, SYNC_MARKER, completed ? dueDate : null, resolveTeamId(category), resolveAssigneeId(assigneeName), isUrgentValue(row[COL.isUrgent]) ? 1 : 0, startDate]
      );
      existingTasks.set(key, { id, title, team_id: category ? 'set' : null, assignee_id: assigneeName ? 'set' : null });
      importedCount++;
    }

    if (importedCount > 0 || categorizedCount > 0 || assignedCount > 0 || statusSyncedCount > 0) {
      console.log(`[SheetSync] Imported ${importedCount} new task(s), backfilled category on ${categorizedCount}, backfilled assignee on ${assignedCount}, synced status on ${statusSyncedCount} existing task(s).`);
    }

    // Delete task rows whose sheet row was removed entirely (not just
    // status-changed) — per Babe's explicit instruction (2026-08-08):
    // if it's gone from the sheet, delete it, don't leave it stuck as a
    // permanent zombie "overdue" item. Only touches tasks that came FROM
    // the sheet (note='sheet-sync') — chat-created tasks are never
    // affected by this, even though they also get written back to the
    // sheet, since a race between "just created, not yet round-tripped
    // into this fetch" and "genuinely deleted" isn't safely distinguishable
    // by title/assignee alone.
    // Gated behind ENABLE_SHEET_DELETE_SYNC until verified via
    // /debug/preview-sheet-deletions against real production data —
    // deletion is irreversible, so this ships disabled-by-default first.
    const syncedTasks = db.all(`SELECT id, title, assignee_id FROM tasks WHERE note = ?`, [SYNC_MARKER]);
    let deletedCount = 0;
    for (const t of syncedTasks) {
      const assignee = t.assignee_id ? db.get(`SELECT display_name FROM users WHERE id = ?`, [t.assignee_id]) : null;
      const key = normalizeTitle(t.title) + '|||' + (assignee?.display_name || '').trim().toLowerCase();
      if (!seenInSheet.has(key) && process.env.ENABLE_SHEET_DELETE_SYNC === 'true') {
        db.run(`DELETE FROM tasks WHERE id = ?`, [t.id]);
        deletedCount++;
      }
    }
    if (deletedCount > 0) {
      console.log(`[SheetSync] Deleted ${deletedCount} task(s) whose sheet row was removed entirely.`);
    }

    // Self-heal duplicate task rows after every sync, not just at boot
    // (see fixTestDebris.js's dedupeDuplicateTasks header) — this
    // function's own existingTasks Map can only ever hold one entry per
    // normalized title, so if a duplicate already exists in the DB
    // (e.g. from before an assignee got merged) this sync can't notice
    // or clean it up on its own. Confirmed live (2026-08-06): dedup only
    // running at boot wasn't enough, since this runs again every 3
    // minutes via cron and could re-surface/recreate the same class of
    // duplicate before the next deploy.
    const fixTestDebris = require('./fixTestDebris');
    const closedCount = fixTestDebris.closeActiveDuplicatesOfDoneTasks();
    if (closedCount > 0) {
      console.log(`[SheetSync] Closed ${closedCount} stale active task(s) whose sheet-synced duplicate was already done.`);
    }
    const removedDupes = fixTestDebris.dedupeDuplicateTasks();
    if (removedDupes > 0) {
      console.log(`[SheetSync] Cleaned up ${removedDupes} duplicate task row(s) after sync.`);
    }
  } catch (err) {
    console.error('[SheetSync] Failed:', err.message);
  }
}

module.exports = { run, previewDeletions };
