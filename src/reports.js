// reports.js — generates a simple .txt overview report of where each
// project/section stands, for Babeb to skim or archive alongside the
// nightly recap text. Saved to /data/reports and served over HTTP so
// LINE can link to it (LINE doesn't reliably support raw file push to
// 1:1 chats across all account types, so a link is the safe choice).

const fs = require('fs');
const path = require('path');
const db = require('./db');

const REPORTS_DIR = path.join(__dirname, '..', 'data', 'reports');

function ensureDir() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function formatDate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Build and save today's report. Returns { filename, filePath }.
 */
function generateDailyReport() {
  ensureDir();
  const today = formatDate(new Date());

  const projects = db.all('SELECT id, name FROM projects');
  const lines = [];
  lines.push(`Migael Monday — Daily Report`);
  lines.push(`วันที่: ${today}`);
  lines.push('='.repeat(50));
  lines.push('');

  if (projects.length === 0) {
    lines.push('(ยังไม่มี project ตั้งค่าไว้ในระบบ)');
  }

  for (const p of projects) {
    const tasks = db.all(
      `SELECT status, COUNT(*) as n FROM tasks WHERE project_id = ? GROUP BY status`,
      [p.id]
    );
    const total = tasks.reduce((sum, t) => sum + t.n, 0);
    const done = tasks.find((t) => t.status === 'done')?.n || 0;
    const pct = total ? Math.round((done / total) * 100) : 0;

    lines.push(`## ${p.name}`);
    lines.push(`ความคืบหน้า: ${done}/${total} งานเสร็จ (${pct}%)`);

    for (const t of tasks) {
      lines.push(`  - ${t.status}: ${t.n} งาน`);
    }

    const detail = db.all(
      `SELECT t.title, t.status, u.display_name as assignee, t.due_date
       FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id
       WHERE t.project_id = ? AND t.status != 'done'
       ORDER BY t.due_date`,
      [p.id]
    );
    if (detail.length) {
      lines.push(`  ยังไม่เสร็จ:`);
      for (const d of detail) {
        lines.push(`    * ${d.title} (${d.assignee || 'ยังไม่ระบุ'}) — กำหนด ${d.due_date || '-'}`);
      }
    }
    lines.push('');
  }

  const filename = `report-${today}.txt`;
  const filePath = path.join(REPORTS_DIR, filename);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

  return { filename, filePath };
}

module.exports = { generateDailyReport, REPORTS_DIR };
