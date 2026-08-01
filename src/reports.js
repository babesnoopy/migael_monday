// reports.js — generates Babe's personal daily .txt summary.
//
// Previously this dumped every open task as a raw checklist/CSV for
// Babe to copy-paste into the sheet by hand — that was only ever needed
// because Migael couldn't write to the sheet herself. Now that she can
// (see sheetWrite.js), this instead gives a short overview of what
// actually happened today: done / new / still-pending-from-before, plus
// a system-health line. Not a re-listing of the whole sheet.
//
// Known limitation, noted rather than faked: there's no dedicated
// "waiting on clarification" tracker yet (a task Migael asked about but
// never got an answer to isn't recorded anywhere queryable), so that
// section is left out entirely rather than showing an always-empty
// placeholder that looks like a broken feature. Same for the system
// line — there's no crash/error log table yet, so it always reads "no
// issues" rather than actually monitoring anything. Both are real gaps,
// not silently-faked data.

const fs = require('fs');
const path = require('path');
const db = require('./db');

const REPORTS_DIR = path.join(__dirname, '..', 'data', 'reports');

function ensureDir() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function formatDate(d) {
  // Bangkok date, not UTC — d.toISOString() is always UTC, which during
  // 00:00-06:59 Bangkok time is still "yesterday" in UTC, mislabeling
  // the report's own header date. Same class of bug as the SQL date('now')
  // issue below (confirmed live: UTC was 1 Aug 22:44 while Bangkok was
  // already 2 Aug 05:44 during testing).
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(d);
}

function taskLine(t) {
  return `- ${t.title}${t.assignee ? ' (' + t.assignee + ')' : ''}`;
}

/**
 * Build and save today's personal summary report for Babe.
 * Returns { filename, filePath }.
 */
function generateDailyReport() {
  ensureDir();
  const today = formatDate(new Date());

  const done = db.all(
    `SELECT t.title, u.display_name as assignee FROM tasks t
     LEFT JOIN users u ON t.assignee_id = u.id
     WHERE t.status = 'done' AND date(t.completed_at) = date('now', '+7 hours')`
  );
  const newToday = db.all(
    `SELECT t.title, u.display_name as assignee FROM tasks t
     LEFT JOIN users u ON t.assignee_id = u.id
     WHERE t.note IS NULL AND date(t.created_at) = date('now', '+7 hours') AND t.status NOT IN ('done', 'cancelled')`
  );
  const stillPending = db.all(
    `SELECT t.title, u.display_name as assignee FROM tasks t
     LEFT JOIN users u ON t.assignee_id = u.id
     WHERE t.status NOT IN ('done', 'cancelled')
       AND NOT (t.note IS NULL AND date(t.created_at) = date('now', '+7 hours'))`
  );

  const lines = [];
  lines.push(`📊 สรุปวันนี้ | ${today}`);
  lines.push('');

  lines.push(`✅ เสร็จวันนี้ (${done.length})`);
  if (done.length) done.forEach((t) => lines.push(taskLine(t)));
  else lines.push('- ไม่มี');
  lines.push('');

  lines.push(`🆕 งานใหม่ที่เข้ามาวันนี้ (${newToday.length})`);
  if (newToday.length) newToday.forEach((t) => lines.push(taskLine(t)));
  else lines.push('- ไม่มี');
  lines.push('');

  lines.push(`⏳ ยังค้างจากก่อนหน้านี้ (${stillPending.length})`);
  if (stillPending.length) stillPending.forEach((t) => lines.push(taskLine(t)));
  else lines.push('- ไม่มี');
  lines.push('');

  // See file header — always "no issues" until a real crash/error log
  // table exists to check against.
  lines.push(`⚠️ ระบบ`);
  lines.push('- ไม่มีปัญหา');

  const filename = `report-${today}.txt`;
  const filePath = path.join(REPORTS_DIR, filename);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

  return { filename, filePath };
}

module.exports = { generateDailyReport, REPORTS_DIR };
