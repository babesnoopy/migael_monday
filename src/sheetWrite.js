// sheetWrite.js — writes Migael's task changes back into the
// UNFEST'26_CHECKLIST sheet (Task Tracker tab). Counterpart to the
// read-only sheetSync.js. Kept in a separate file on purpose: sheetSync
// runs read-only sync on a cron and must never be blocked by write
// logic; this file is only called from specific chat-triggered actions
// (task closed / cancelled / rescheduled / newly created).
//
// SAFETY RULES (do not violate — see migael-monday spec, section D):
// - Never write to columns W/X (เหลือเวลา/ความคืบหน้า) — those are sheet
//   formulas. Writing to them would overwrite the formula with a static
//   value and break the dashboard's auto-calculation permanently.
// - Only use status values that already exist in the sheet's dropdown
//   (data validation), listed in STATUS below. Writing anything else
//   either gets rejected by validation or silently breaks the dropdown.
// - Every write is by row number, found via title match against a fresh
//   read of the title column — never assume a cached row number is still
//   correct, since rows can shift if someone edits the sheet directly.

const { google } = require('googleapis');
const db = require('./db');
const driveApi = require('./drive');
const { getAuth } = require('./calendar');

const SHEET_TAB = 'Task Tracker';
const HEADER_ROW = 2; // row 1 = title, row 2 = actual column headers (per screenshot)
const FIRST_DATA_ROW = 3;

// Columns L..V (matches sheetSync.js's COL offsets, same header row).
// Confirmed from the screenshot the team shared — do not reorder without
// re-checking the live sheet, since a wrong offset silently corrupts the
// wrong column instead of erroring.
const COLUMN = {
  startDate: 'L',
  title: 'M',
  project: 'N',
  category: 'O',
  assignee: 'P',
  status: 'Q',
  priority: 'R',
  isImportant: 'S',
  isUrgent: 'T',
  difficulty: 'U',
  dueDate: 'V',
  time: 'W',
  // X (เหลือเวลา/days remaining) and Z (ความคืบหน้า/progress) are pure
  // formulas — confirmed via the sheet's actual header row on
  // 2026-08-02. Intentionally not mapped here so nothing can
  // accidentally target them. Y (วันที่เสร็จสิ้น) is a plain writable
  // date field, not a formula, despite sitting between the two.
  completedDate: 'Y',
  details: 'AB',
};

// Exact strings from the sheet's status dropdown — pulled directly from
// the validation source range 'Set up'!AG28:AG (verified 2026-08-02,
// see spec doc). NOT guessed from the visible emoji in screenshots —
// two of these ('แก้ไข' and 'ถูกตีกลับ') share the same 🛠️ icon in the
// source list and 'แก้ไข'/'ถูกตีกลับ' both have a double space after the
// emoji, which is easy to get wrong by eye. Do not hand-edit these
// without re-reading 'Set up'!AG28:AG147 first.
const STATUS = {
  TODO: '⚠️ ต้องทำ',
  IN_PROGRESS: '⏱️ กำลังทำ',
  EDITING: '🛠️  แก้ไข',
  NEARLY_DONE: '🚀 ใกล้เสร็จ',
  REVIEW: '👀 ตรวจ',
  PENDING_POST: '📥 รอโพส',
  DONE: '✅ เสร็จ',
  BOUNCED: '🛠️  ถูกตีกลับ',
  CANCELLED: '❌ ยกเลิก',
  ON_HOLD: '✋ ระงับชั่วคราว',
};

async function findSpreadsheetId() {
  if (process.env.UNFEST_CHECKLIST_SHEET_ID) return process.env.UNFEST_CHECKLIST_SHEET_ID;
  const results = await driveApi.search("UNFEST'26_CHECKLIST");
  const match = results.find((r) => !r.isFolder) || results[0];
  if (!match?.link) return null;
  const m = match.link.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

function toSheetDate(isoDate) {
  // Sheet displays dates like "31 Jul 2026" per the screenshot.
  if (!isoDate) return '';
  const d = new Date(isoDate);
  if (isNaN(d)) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// Finds the sheet row number (1-based, matching the actual sheet grid)
// for a task by title. Always re-reads fresh — never trust a cached row
// number, since the team may insert/delete rows directly in the sheet.
// Title comparison tolerates a tone-mark-level edit (same normalization
// as sheetSync.js's normalizeTitle) — confirmed real case: "เช่๊คอังกริดของ..."
// vs "เช๊คอังกริดของ..." would otherwise fail to match here too.
function normalizeTitle(t) {
  return (t || '').trim().toLowerCase().replace(/[\u0E48-\u0E4B]/g, '').replace(/\s+/g, ' ');
}
async function findRowByTitle(sheets, spreadsheetId, title) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_TAB}'!${COLUMN.title}${FIRST_DATA_ROW}:${COLUMN.title}2000`,
  });
  const rows = res.data.values || [];
  const key = normalizeTitle(title);
  const idx = rows.findIndex((r) => normalizeTitle(r[0]) === key);
  if (idx === -1) return null;
  return FIRST_DATA_ROW + idx;
}

async function getSheetsClient() {
  const spreadsheetId = await findSpreadsheetId();
  if (!spreadsheetId) throw new Error('Could not find UNFEST\'26_CHECKLIST in Drive.');
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });
  return { sheets, spreadsheetId };
}

// --- Phase 1 actions: edit a single cell (or two) on an existing row ---

async function markDone(taskTitle) {
  const { sheets, spreadsheetId } = await getSheetsClient();
  const row = await findRowByTitle(sheets, spreadsheetId, taskTitle);
  if (!row) return { ok: false, reason: 'not_found_in_sheet' };

  const today = toSheetDate(new Date().toISOString().slice(0, 10));
  // Q (status) and Y (completed date) aren't adjacent columns (X sits
  // between them and is a formula we must never touch), so these are
  // two separate single-cell writes rather than one range write.
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${SHEET_TAB}'!${COLUMN.status}${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[STATUS.DONE]] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${SHEET_TAB}'!${COLUMN.completedDate}${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[today]] },
  });
  return { ok: true, row };
}

async function markCancelled(taskTitle) {
  const { sheets, spreadsheetId } = await getSheetsClient();
  const row = await findRowByTitle(sheets, spreadsheetId, taskTitle);
  if (!row) return { ok: false, reason: 'not_found_in_sheet' };

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${SHEET_TAB}'!${COLUMN.status}${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[STATUS.CANCELLED]] },
  });
  return { ok: true, row };
}

async function reschedule(taskTitle, newDueDateIso) {
  const { sheets, spreadsheetId } = await getSheetsClient();
  const row = await findRowByTitle(sheets, spreadsheetId, taskTitle);
  if (!row) return { ok: false, reason: 'not_found_in_sheet' };

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${SHEET_TAB}'!${COLUMN.dueDate}${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[toSheetDate(newDueDateIso)]] },
  });
  return { ok: true, row };
}

// Finds the first genuinely empty row after the real data, by title
// column only. Deliberately NOT using the Sheets values.append API here
// — this sheet has data validation/formatting pre-applied thousands of
// rows down (confirmed empirically: append() picked row 5023 as "the
// next row" when real data ends at row 66), so append()'s own table
// auto-detection is unusable on this sheet. We find the real boundary
// ourselves from actual title content and write to an explicit range.
async function findNextEmptyRow(sheets, spreadsheetId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_TAB}'!${COLUMN.title}${FIRST_DATA_ROW}:${COLUMN.title}2000`,
  });
  const rows = res.data.values || [];
  let lastFilled = -1;
  rows.forEach((r, i) => { if ((r[0] || '').trim()) lastFilled = i; });
  return FIRST_DATA_ROW + lastFilled + 1;
}

// --- Phase 2 action: add a brand-new row ---
// Deliberately NOT wired into any automatic trigger yet — call manually /
// behind a feature flag until Phase 1 has run in production for a while.
// Writes to an explicit row found via findNextEmptyRow (see above) rather
// than the append() API, and only ever fills columns L-V — nothing to
// the right, so the formula columns are never touched.
async function appendNewTask({ title, assignee, project, category, startDateIso, dueDateIso }) {
  const { sheets, spreadsheetId } = await getSheetsClient();
  const row = await findNextEmptyRow(sheets, spreadsheetId);
  const values = [[
    toSheetDate(startDateIso),
    title,
    project || '',
    category || '',
    assignee || '',
    STATUS.TODO,
    '', '', '', '', // priority / important? / urgent? / difficulty — left blank, not guessed
    dueDateIso ? toSheetDate(dueDateIso) : '',
  ]];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${SHEET_TAB}'!${COLUMN.startDate}${row}:${COLUMN.dueDate}${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
  return { ok: true, row };
}

module.exports = { STATUS, markDone, markCancelled, reschedule, appendNewTask, findRowByTitle, getSheetsClient };
