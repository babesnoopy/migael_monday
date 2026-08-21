// db.js — sql.js database layer
// Railway wipes the filesystem on every redeploy, so we persist the DB
// as a base64 blob... but for real durability, swap this for a small
// external store (Railway Postgres, Supabase, etc.) when you're ready.
// For v1 this keeps things simple and matches the existing stack choice.

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'migael.sqlite');
const SCHEMA_FILE = path.join(__dirname, '..', 'schema.sql');

let SQL = null;
let db = null;

async function init() {
  SQL = await initSqlJs();

  if (fs.existsSync(DB_FILE)) {
    const fileBuffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
    const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
    db.run(schema);
    persist();
  }

  // Added after the schema was first shipped, so it can't just live in
  // schema.sql (that only runs once, on a brand-new DB). IF NOT EXISTS
  // makes this safe to run on every startup against an existing DB too.
  // Tracks LINE webhookEventId so a redelivered webhook (LINE retries on
  // any failure/timeout) doesn't get processed twice — this is what
  // caused duplicate meetings/tasks to be created from a single message
  // when webhook redelivery kicked in.
  db.run(`CREATE TABLE IF NOT EXISTS processed_webhook_events (
    id TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Action items Claude spotted in a meeting-note-style message but
  // hasn't created as real tasks yet — waiting on an explicit "ใช่"/
  // confirm reply first. Per Babe's explicit design (2026-08-21): the
  // earlier version of auto-task-creation from group chat created
  // "มั่วๆ" (junk) tasks with no confirmation step, which polluted the
  // sheet with garbage. This table + the linked listening session is
  // what makes the confirm step possible — items sit here as a proposal
  // until confirmed, and are only ever inserted into the real tasks
  // table once the sender explicitly agrees.
  db.run(`CREATE TABLE IF NOT EXISTS pending_action_items (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    items TEXT NOT NULL,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Maps a LINE message id (a message MIGAEL SENT) to whatever it was
  // about, so a genuine LINE reply/quote to that specific message can
  // be resolved exactly — instead of guessing from "whichever session
  // is most recently active for the group", which breaks the moment
  // more than one thing gets nudged/asked about around the same time.
  // Confirmed live (2026-08-13): multiple stale-topic nudges sent close
  // together meant only a reply to the LAST one could ever be linked
  // correctly; replies to earlier ones in the same batch had no way to
  // resolve. TTL isn't enforced here — old rows are harmless clutter,
  // small enough not to matter.
  db.run(`CREATE TABLE IF NOT EXISTS quoted_message_links (
    line_message_id TEXT PRIMARY KEY,
    ref_type TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Lets a plain task (due date only, no specific time) also get an
  // all-day Calendar entry, and remember which Google event that was —
  // added after tasks already existed in production, so check first
  // rather than assuming a fresh schema.
  const taskCols = db.exec(`PRAGMA table_info(tasks)`);
  const taskColNames = taskCols[0]?.values?.map((row) => row[1]) || [];
  if (!taskColNames.includes('calendar_event_id')) {
    db.run(`ALTER TABLE tasks ADD COLUMN calendar_event_id TEXT`);
  }
  // The sheet has a separate "วันที่เริ่มต้น" (start date) column from
  // "กำหนดเสร็จ" (due date) — a task can be worked on well before its
  // due date. Without start_date, "what should I work on today" and
  // "what's due tomorrow" were indistinguishable (only due_date existed).
  if (!taskColNames.includes('start_date')) {
    db.run(`ALTER TABLE tasks ADD COLUMN start_date DATETIME`);
  }

  // Topics get a category too — the 6 UNFEST sub-programs (UNFEST,
  // UNFILM, UNCINEMA, UNLIVE, UNDEMO, UNFOLD) — so the /topics page can
  // group and filter by which part of the festival something belongs to.
  const topicCols = db.exec(`PRAGMA table_info(topics)`);
  const topicColNames = topicCols[0]?.values?.map((row) => row[1]) || [];
  if (!topicColNames.includes('category')) {
    db.run(`ALTER TABLE topics ADD COLUMN category TEXT`);
  }
  persist();

  return db;
}

function persist() {
  if (!fs.existsSync(path.dirname(DB_FILE))) {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  }
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

// Run an INSERT/UPDATE/DELETE and persist immediately
function run(sql, params = []) {
  db.run(sql, params);
  persist();
}

// Run a SELECT and return rows as plain objects
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  const rows = all(sql, params);
  return rows[0] || null;
}

module.exports = { init, run, all, get, persist };
