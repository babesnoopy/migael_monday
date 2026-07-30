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
