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
const COL = { startDate: 0, title: 1, category: 3, status: 5, isUrgent: 8, dueDate: 10 };

function mapStatus(rawStatus) {
  const s = (rawStatus || '').trim();
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

async function findSpreadsheetId() {
  if (process.env.UNFEST_CHECKLIST_SHEET_ID) return process.env.UNFEST_CHECKLIST_SHEET_ID;
  const results = await driveApi.search("UNFEST'26_CHECKLIST");
  const match = results.find((r) => !r.isFolder) || results[0];
  if (!match?.link) return null;
  const m = match.link.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
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
      db.all(`SELECT id, title, team_id, start_date, status, note FROM tasks`).map((t) => [t.title.trim().toLowerCase(), t])
    );

    let importedCount = 0;
    let categorizedCount = 0;
    let statusSyncedCount = 0;

    for (const row of rows) {
      const title = row[COL.title]?.trim();
      if (!title || title === 'สิ่งที่ต้องทำ') continue; // blank row or a repeated header

      const category = row[COL.category]?.trim() || null;
      const key = title.toLowerCase();
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

      // New row Migael hasn't seen before — import it in full, category included.
      const id = randomUUID();
      db.run(
        `INSERT INTO tasks (id, title, status, due_date, note, completed_at, team_id, is_urgent, start_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, title, status, dueDate, SYNC_MARKER, completed ? dueDate : null, resolveTeamId(category), isUrgentValue(row[COL.isUrgent]) ? 1 : 0, startDate]
      );
      existingTasks.set(key, { id, title, team_id: category ? 'set' : null });
      importedCount++;
    }

    if (importedCount > 0 || categorizedCount > 0 || statusSyncedCount > 0) {
      console.log(`[SheetSync] Imported ${importedCount} new task(s), backfilled category on ${categorizedCount}, synced status on ${statusSyncedCount} existing task(s).`);
    }
  } catch (err) {
    console.error('[SheetSync] Failed:', err.message);
  }
}

module.exports = { run };
