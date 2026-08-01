// reports.js — generates a .txt overview report of where things stand,
// for Babeb to skim, save, or copy into her UNFEST'26_CHECKLIST sheet.
// Organized by team/department (not by project), checklist-style, so it
// maps onto the sheet's columns as directly as possible: status, priority,
// urgent, assignee, project, category, due date.
//
// Label priority for each task, most specific first: real assignee name
// (once someone's introduced themselves and is linked) > real team_id >
// keyword-guessed department (classify.js) > "ยังไม่ระบุ". A guessed
// department is only ever a display label — it never gets written back
// as a real team_id, since that would fabricate team assignment.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { guessDepartment } = require('./classify');

const REPORTS_DIR = path.join(__dirname, '..', 'data', 'reports');

function ensureDir() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function formatDate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function statusMark(status) {
  return status === 'done' ? '✅' : '⬜';
}

// Picks what to show after the task line: prefer a real person (easiest
// to follow up with), then a real team, then a keyword guess, so a task
// is never labeled more vaguely than the data actually allows.
function ownerLabel(task) {
  if (task.assignee) return `ทีม${task.team ? ' ' + task.team : ''} — ${task.assignee}`;
  if (task.team) return `ทีม ${task.team}`;
  const guessed = guessDepartment(task.title);
  return guessed ? `ทีม ${guessed} (เดาจากบริบท)` : null;
}

/**
 * Build and save today's report. Returns { filename, filePath }.
 */
function generateDailyReport() {
  ensureDir();
  const today = formatDate(new Date());

  const allOpenTasks = db.all(
    `SELECT t.title, t.status, u.display_name as assignee, tm.name as team,
            t.due_date, t.priority, t.is_urgent, p.name as project
     FROM tasks t
     LEFT JOIN users u ON t.assignee_id = u.id
     LEFT JOIN teams tm ON t.team_id = tm.id
     LEFT JOIN projects p ON t.project_id = p.id
     ORDER BY t.status = 'done', t.due_date`
  );

  const lines = [];
  lines.push(`Migael Monday — Daily Report`);
  lines.push(`วันที่: ${today}`);
  lines.push('='.repeat(50));
  lines.push('');

  if (!allOpenTasks.length) {
    lines.push('(ยังไม่มีงานตั้งค่าไว้ในระบบ)');
  } else {
    for (const t of allOpenTasks) {
      const label = ownerLabel(t);
      const flags = [];
      if (t.is_urgent) flags.push('ด่วน');
      if (t.priority) flags.push(t.priority);
      const meta = [
        label,
        t.project ? `โปรเจกต์: ${t.project}` : null,
        t.due_date ? `กำหนด: ${t.due_date}` : null,
        flags.length ? flags.join(', ') : null,
      ].filter(Boolean).join(' | ');
      lines.push(`${statusMark(t.status)} ${t.title}${meta ? ' — ' + meta : ''}`);
    }
  }

  const filename = `report-${today}.txt`;
  const filePath = path.join(REPORTS_DIR, filename);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

  return { filename, filePath };
}

// Sheet-ready CSV — columns match Babe's actual UNFEST'26_CHECKLIST
// sheet order, so rows can be copy-pasted straight in. Requested after
// the plain-text version (checkbox bullet list) turned out to still be
// tedious to transcribe by hand every evening.
function csvEscape(val) {
  const s = String(val ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function generateDailyCsv() {
  ensureDir();
  const today = formatDate(new Date());

  const allTasks = db.all(
    `SELECT t.title, t.status, t.note, u.display_name as assignee, tm.name as team,
            t.start_date, t.due_date, t.priority, t.is_urgent, p.name as project
     FROM tasks t
     LEFT JOIN users u ON t.assignee_id = u.id
     LEFT JOIN teams tm ON t.team_id = tm.id
     LEFT JOIN projects p ON t.project_id = p.id
     ORDER BY t.status = 'done', t.due_date`
  );

  const statusThai = { done: 'เสร็จ', in_progress: 'กำลังทำ', review: 'ตรวจ', to_do: 'ต้องทำ' };

  // A task with no note came from LINE chat and was never matched back to
  // a sheet row (note gets set to 'sheet-sync' automatically the moment
  // sheetSync sees a matching title in the sheet) — so "no note" reliably
  // means "still needs to be added to the main sheet", and clears itself
  // the moment Babe actually adds it, rather than a naive daily reset.
  const header = ['วันที่เริ่มต้น', 'สิ่งที่ต้องทำ', 'โครงการ', 'หมวดหมู่', 'ผู้รับมอบหมาย', 'สถานะ', 'ด่วน', 'กำหนดเสร็จ', 'ต้องเพิ่มในชีทหลักไหม'];
  const lines = [header.map(csvEscape).join(',')];

  for (const t of allTasks) {
    const category = t.team || guessDepartment(t.title) || '';
    lines.push([
      t.start_date || '',
      t.title,
      t.project || '',
      category,
      t.assignee || '',
      statusThai[t.status] || t.status,
      t.is_urgent ? 'ด่วน' : '',
      t.due_date || '',
      t.note ? '' : '🆕 ใหม่ - ยังไม่มีในชีท',
    ].map(csvEscape).join(','));
  }

  const filename = `report-${today}.csv`;
  const filePath = path.join(REPORTS_DIR, filename);
  // BOM so Thai text opens correctly in Excel, not just Google Sheets.
  fs.writeFileSync(filePath, '\uFEFF' + lines.join('\n'), 'utf8');

  return { filename, filePath };
}

module.exports = { generateDailyReport, generateDailyCsv, REPORTS_DIR };
