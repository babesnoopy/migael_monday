// groupState.js — helpers for "who's in this group" and "listening mode"
const db = require('./db');
const { randomUUID } = require('crypto');

function getRoster(groupId) {
  return db.all(
    `SELECT u.id, u.display_name as name, t.name as team
     FROM group_members gm
     JOIN users u ON gm.user_id = u.id
     LEFT JOIN teams t ON u.team_id = t.id
     WHERE gm.group_id = ?`,
    [groupId]
  );
}

function upsertGroup(groupId, groupName) {
  const existing = db.get('SELECT id FROM line_groups WHERE id = ?', [groupId]);
  if (!existing) {
    db.run('INSERT INTO line_groups (id, group_name) VALUES (?, ?)', [groupId, groupName]);
  }
}

function upsertUser(userId, displayName, groupId) {
  const existing = db.get('SELECT id, onboarded_at FROM users WHERE id = ?', [userId]);
  let isNew = false;
  if (!existing) {
    db.run('INSERT INTO users (id, display_name) VALUES (?, ?)', [userId, displayName]);
    isNew = true;
  }
  if (groupId) {
    db.run('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)', [groupId, userId]);
  }
  if (isNew) return { isNew: true };
  return { isNew: false, onboarded: !!existing.onboarded_at };
}

function setUserTeam(userId, teamName, projectId) {
  let team = db.get('SELECT id FROM teams WHERE name = ?', [teamName]);
  if (!team) {
    const teamId = randomUUID();
    db.run('INSERT INTO teams (id, name, project_id) VALUES (?, ?, ?)', [teamId, teamName, projectId]);
    team = { id: teamId };
  }
  db.run('UPDATE users SET team_id = ?, onboarded_at = CURRENT_TIMESTAMP WHERE id = ?', [team.id, userId]);
}

// ---- Listening mode ----
// A session opens when Migael's name is mentioned, and stays open
// (linked_ref may fill in as details arrive) until Claude judges the
// topic has changed, at which point the caller ends it.

function openSession(groupId, userId) {
  const id = randomUUID();
  db.run(
    `INSERT INTO listening_sessions (id, group_id, triggered_by) VALUES (?, ?, ?)`,
    [id, groupId, userId]
  );
  return id;
}

function getActiveSession(groupId) {
  return db.get(
    `SELECT * FROM listening_sessions WHERE group_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    [groupId]
  );
}

function linkSession(sessionId, refType, refId) {
  db.run(
    `UPDATE listening_sessions SET linked_ref_type = ?, linked_ref_id = ? WHERE id = ?`,
    [refType, refId, sessionId]
  );
}

function closeSession(sessionId, reason) {
  db.run(
    `UPDATE listening_sessions SET ended_at = CURRENT_TIMESTAMP, end_reason = ? WHERE id = ?`,
    [reason, sessionId]
  );
}

// This Migael instance only ever lives in one real LINE group (the
// UNFEST team group), so instead of scoping data by group_id everywhere
// (which broke every time the group got recreated/re-added — a "new"
// LINE group has a different id even when it's meant to be the same
// team chat), we just need ONE canonical place to send broadcasts and
// reminders to. Override with PRIMARY_GROUP_ID in .env if ever needed;
// otherwise falls back to whichever group Migael most recently joined.
function getPrimaryGroupId() {
  if (process.env.PRIMARY_GROUP_ID) return process.env.PRIMARY_GROUP_ID;
  if (process.env.PERSONAL_RELAY_GROUP_ID) return process.env.PERSONAL_RELAY_GROUP_ID;
  const row = db.get('SELECT id FROM line_groups ORDER BY created_at DESC LIMIT 1');
  return row ? row.id : null;
}

// DEV MODE (2026-08-25) — added after a real incident: two separate
// test/data-mixup messages leaked into the real team group in one
// evening while building the meeting-bot feature, embarrassing and
// confusing the team. While DEV_MODE=true in env, EVERY message that
// would normally go to the team group (reminders, broadcasts, nudges,
// relayed confirmations) is redirected to Babe's own personal chat
// instead — a hard guarantee the team group stays silent no matter
// what bug shows up mid-development, without having to individually
// audit every send site each time. Turn off (unset or 'false') once
// a feature is actually ready to go live to the team again.
function isDevMode() {
  return process.env.DEV_MODE === 'true';
}
// Any function about to send a message meant for "the team" should run
// its target group id through this first.
function resolveBroadcastTarget(groupId) {
  if (isDevMode()) return process.env.BABE_USER_ID || groupId;
  return groupId;
}

module.exports = {
  getRoster,
  upsertGroup,
  upsertUser,
  setUserTeam,
  openSession,
  getActiveSession,
  linkSession,
  closeSession,
  getPrimaryGroupId,
  isDevMode,
  resolveBroadcastTarget,
};
