// index.js — LINE webhook entrypoint
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const db = require('./db');
const brain = require('./brain');
const gs = require('./groupState');
const calendarApi = require('./calendar');
const driveApi = require('./drive');
const { randomUUID } = require('crypto');
require('./scheduler'); // starts cron jobs once db is ready (see scheduler.js)

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);

const app = express();
app.use('/reports', express.static(require('path').join(__dirname, '..', 'data', 'reports')));

// Keep a short rolling window of recent messages per group in memory.
// This is just for "listening mode" context — the durable record lives
// in tasks/events once Migael has extracted something.
const RECENT_WINDOW = 15;
const recentByGroup = new Map(); // groupId -> [{userName, text, ts}]

function pushRecent(groupId, entry) {
  const arr = recentByGroup.get(groupId) || [];
  arr.push(entry);
  if (arr.length > RECENT_WINDOW) arr.shift();
  recentByGroup.set(groupId, arr);
}

// Migael must answer status/schedule questions ("งานของฉันวันนี้มีอะไรบ้าง")
// from real data, not guesses. This pulls a lightweight snapshot of the
// group's current tasks + upcoming events every time she's addressed.
function getGroupDataSnapshot(groupId) {
  const tasks = db.all(
    `SELECT t.title, t.status, u.display_name as assignee, t.due_date, t.is_urgent
     FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id
     WHERE t.group_id = ? AND t.status != 'done'
     ORDER BY t.due_date`,
    [groupId]
  );
  const events = db.all(
    `SELECT title, start_time, meeting_link FROM events
     WHERE group_id = ? AND datetime(start_time) >= datetime('now', '-1 hour')
     ORDER BY start_time LIMIT 10`,
    [groupId]
  );
  const topics = db.all(
    `SELECT id, title, summary, reference_link, updated_at FROM topics
     WHERE group_id = ? AND status = 'open'
     ORDER BY updated_at DESC LIMIT 15`,
    [groupId]
  );
  return { tasks, events, topics };
}

async function handleEvent(event) {
  // Migael was just added to a (new or existing) group — greet right away,
  // don't wait for someone to type first. Works for any group she's added
  // to, not just the ones set up so far.
  if (event.type === 'join' && event.source.type === 'group') {
    const groupId = event.source.groupId;
    gs.upsertGroup(groupId, null);
    return reply(event.replyToken,
      'สวัสดีค่ะ เรามิเกล ผู้ช่วยเบ้บนะคะ 👋\nรบกวนทุกคนแนะนำตัวหน่อยค่ะ — ชื่ออะไร ทำหน้าที่อะไร รับผิดชอบเรื่องไหนบ้าง\n\n(รบกวนแอดมินพิมพ์ "มิเกล กลุ่มนี้คือโปรเจกต์ [ชื่อโปรเจกต์]" ด้วยนะคะ จะได้ผูก calendar ให้ถูกกลุ่ม)');
  }

  if (event.type !== 'message' || event.message.type !== 'text') return;
  if (event.source.type !== 'group') return handlePersonal(event);

  const groupId = event.source.groupId;
  const userId = event.source.userId;
  const text = event.message.text;

  const profile = await client.getGroupMemberProfile(groupId, userId).catch(() => null);
  const userName = profile ? profile.displayName : 'ทีม';

  gs.upsertGroup(groupId, null);
  const { isNew } = gs.upsertUser(userId, userName, groupId);

  pushRecent(groupId, { userName, text, ts: Date.now() });

  // New person in the group who hasn't introduced themselves yet -> ask directly
  if (isNew) {
    return reply(event.replyToken,
      `สวัสดีค่ะ ${userName} 👋 เรามิเกลนะคะ รบกวนแนะนำตัวหน่อยค่ะ ชื่ออะไร ทำหน้าที่อะไร รับผิดชอบเรื่องไหนบ้าง`);
  }

  // Migael listens to and analyzes every message now — not just ones that
  // name her — so she can passively track task completions, topic updates,
  // etc. as the team talks normally. She only SPEAKS when addressed by
  // name, continuing an open thread, or (rarely) judges a casual exchange
  // is worth proactively joining. This trades more Anthropic API calls
  // (one per group message, not just ones naming her) for actually
  // "managing" the team instead of only reacting when summoned.
  const mentionsMigael = text.includes('มิเกล');
  const session = gs.getActiveSession(groupId);
  const wasAddressed = mentionsMigael || !!session;

  // Deterministic admin command: link this group to a project, so it has a
  // calendar to use. Handled directly (not via Claude) since it's a config
  // action, not something we want any ambiguity on.
  // e.g. "มิเกล กลุ่มนี้คือโปรเจกต์ UNCOMMU" or "มิเกล ผูกกลุ่มนี้กับ UNFEST26"
  const linkMatch = text.match(/(?:กลุ่มนี้คือโปรเจกต์|ผูกกลุ่มนี้กับ|กลุ่มนี้คือ)\s*(.+)/);
  if (mentionsMigael && linkMatch) {
    const projectName = linkMatch[1].trim();
    const project = db.get(`SELECT id, name FROM projects WHERE name LIKE ?`, [`%${projectName}%`]);
    if (project) {
      db.run(
        `INSERT OR IGNORE INTO group_projects (group_id, project_id) VALUES (?, ?)`,
        [groupId, project.id]
      );
      return reply(event.replyToken, `ผูกกลุ่มนี้กับโปรเจกต์ "${project.name}" แล้วค่ะ ✅ กลุ่มนี้จะใช้ calendar ของโปรเจกต์นี้ตั้งแต่นี้ไป`);
    }
    return reply(event.replyToken, `หา project "${projectName}" ไม่เจอเลยค่ะ เช็คชื่ออีกทีได้ไหมคะ`);
  }

  const roster = gs.getRoster(groupId);

  const decision = await brain.interpret({
    groupName: groupId,
    userName,
    messageText: text,
    recentMessages: recentByGroup.get(groupId) || [],
    teamRoster: roster,
    openThread: session ? buildOpenThreadSummary(session) : null,
    groupData: getGroupDataSnapshot(groupId),
    wasAddressed,
  });

  // Only open/continue a listening-mode session when there's something
  // worth linking (task/event/topic capture) — not for every ambient
  // message, so casual chit-chat doesn't spam listening_sessions.
  const linkableIntents = ['create_task', 'create_event', 'correct_event', 'log_topic', 'add_detail_to_open_thread'];
  const sessionId = session
    ? session.id
    : linkableIntents.includes(decision.intent)
      ? gs.openSession(groupId, userId)
      : null;

  const overrideReply = await applyDecision({ decision, groupId, userId, userName, sessionId });

  const finalReply = overrideReply || decision.reply_message;
  if (finalReply) {
    await reply(event.replyToken, finalReply);
  }

  if (sessionId && decision.intent === 'none') {
    gs.closeSession(sessionId, 'topic_changed');
  }
}

// Looks up the real title of whatever the listening-mode session is
// currently linked to, so Claude gets actual context (not just an ID)
// when deciding whether a follow-up message is a correction.
function buildOpenThreadSummary(session) {
  if (!session.linked_ref_type || !session.linked_ref_id) {
    return { type: null, id: null, summary: '(ยังไม่มีข้อมูลผูกไว้)' };
  }
  const tableByType = { event: 'events', task: 'tasks', topic: 'topics' };
  const table = tableByType[session.linked_ref_type] || 'tasks';
  const row = db.get(`SELECT title FROM ${table} WHERE id = ?`, [session.linked_ref_id]);
  return {
    type: session.linked_ref_type,
    id: session.linked_ref_id,
    summary: row?.title || '(ไม่พบชื่อ)',
  };
}

// Formats a DB datetime (e.g. "2026-07-27 14:30:00") into a natural Thai
// date like "27 ก.ค." — used so recap replies always state exactly when
// the info was last updated, without relying on Claude to compute dates.
function formatThaiDate(dbDateString) {
  if (!dbDateString) return null;
  const d = new Date(dbDateString.replace(' ', 'T') + '+07:00');
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: 'numeric',
    month: 'short',
  }).format(d);
}

async function applyDecision({ decision, groupId, userId, userName, sessionId }) {
  const ex = decision.extracted || {};

  // Resolves team member names (from attendee_names, matched against the
  // roster) to real user ids and links them in event_attendees — this is
  // what scheduler.js reads later to tag the right people in reminders.
  function linkAttendees(eventId, names) {
    if (!names || !names.length) return;
    for (const name of names) {
      const user = db.get(`SELECT id FROM users WHERE display_name LIKE ?`, [`%${name}%`]);
      if (user) {
        db.run(
          `INSERT OR IGNORE INTO event_attendees (event_id, user_id) VALUES (?, ?)`,
          [eventId, user.id]
        );
      }
    }
  }

  // Same idea as linkAttendees, but for topics — tracks who's tagged in an
  // ongoing discussion so Migael knows who to follow up with as it evolves.
  function linkTopicParticipants(topicId, names) {
    if (!names || !names.length) return;
    for (const name of names) {
      const user = db.get(`SELECT id FROM users WHERE display_name LIKE ?`, [`%${name}%`]);
      if (user) {
        db.run(
          `INSERT OR IGNORE INTO topic_participants (topic_id, user_id) VALUES (?, ?)`,
          [topicId, user.id]
        );
      }
    }
  }

  // Resolves a team member's name (as Claude extracted it) to a real user
  // id via the roster — shared by single and batch task creation.
  function resolveAssigneeId(name) {
    if (!name) return null;
    const user = db.get(`SELECT id FROM users WHERE display_name LIKE ?`, [`%${name}%`]);
    return user ? user.id : null;
  }

  if (decision.intent === 'create_task') {
    const id = randomUUID();
    db.run(
      `INSERT INTO tasks (id, title, assignee_id, created_by, due_date, group_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'to_do')`,
      [id, ex.title || '(untitled)', resolveAssigneeId(ex.assignee), userId, ex.due_date || null, groupId]
    );
    gs.linkSession(sessionId, 'task', id);
  }

  if (decision.intent === 'create_multiple_tasks' && ex.items?.length) {
    // One message containing several tasks (e.g. an agenda dump) — capture
    // every item, don't just grab the first and drop the rest.
    const created = [];
    for (const item of ex.items) {
      const id = randomUUID();
      db.run(
        `INSERT INTO tasks (id, title, assignee_id, created_by, due_date, group_id, status, is_urgent)
         VALUES (?, ?, ?, ?, ?, ?, 'to_do', ?)`,
        [id, item.title || '(untitled)', resolveAssigneeId(item.assignee_name), userId, item.due_date || null, groupId, item.is_urgent ? 1 : 0]
      );
      created.push({ title: item.title, assignee: item.assignee_name });
    }
    const lines = created.map((c) => `- ${c.title}${c.assignee ? ' (' + c.assignee + ')' : ''}`);
    return decision.reply_message || `บันทึกให้แล้วค่ะ ${created.length} รายการ 📋\n${lines.join('\n')}`;
  }

  if (decision.intent === 'create_event') {
    // If Claude still needs clarification (e.g. which of the 3 UNFEST26
    // calendars), don't create anything yet — the clarifying question is
    // already in decision.reply_message.
    if (decision.needs_clarification) return null;

    // Guard: events.start_time is NOT NULL in the schema. Without a time
    // there's nothing valid to create — ask instead of inserting NULL
    // (which would throw a SQL error) or silently skipping.
    if (!ex.start_time) {
      return decision.reply_message || 'นัดนี้ยังไม่มีเวลาเลยค่ะ ขอเวลาด้วยได้ไหมคะ';
    }

    // Resolve calendar name -> real Google calendarId via the `calendars`
    // table (populate this table once during setup using
    // calendarApi.listCalendars()).
    let calendarRow = null;
    if (ex.calendar_name) {
      calendarRow = db.get(`SELECT * FROM calendars WHERE name LIKE ?`, [`%${ex.calendar_name}%`]);
    }
    const calendarId = calendarRow ? calendarRow.id : 'primary';

    const created = await calendarApi.createEvent({
      calendarId,
      title: ex.title || '(untitled)',
      startTime: ex.start_time,
      endTime: ex.end_time || ex.start_time,
      attendeeEmails: ex.attendee_emails || [],
    });

    const id = randomUUID();
    db.run(
      `INSERT INTO events (id, title, start_time, meeting_link, calendar_id, google_event_id, group_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        ex.title || '(untitled)',
        ex.start_time,
        created?.meetLink || ex.meeting_link || null,
        calendarRow?.id || null,
        created?.id || null,
        groupId,
        userId,
      ]
    );
    gs.linkSession(sessionId, 'event', id);
    linkAttendees(id, ex.attendee_names);

    if (created?.meetLink) {
      return `${decision.reply_message}\n🔗 ${created.meetLink}`;
    }
  }

  if (decision.intent === 'correct_event' && ex.event_id) {
    const eventRow = db.get(`SELECT * FROM events WHERE id = ?`, [ex.event_id]);
    if (!eventRow) {
      return `หาข้อมูลนัดเดิมไม่เจอเลยค่ะ ขอโทษด้วย รบกวนพิมพ์รายละเอียดใหม่ทั้งหมดได้ไหมคะ`;
    }

    const updates = {};
    if (ex.title) updates.title = ex.title;
    if (ex.start_time) updates.startTime = ex.start_time;
    if (ex.end_time) updates.endTime = ex.end_time;
    if (ex.attendee_emails) updates.attendeeEmails = ex.attendee_emails;

    let updated = null;
    if (eventRow.google_event_id && eventRow.calendar_id) {
      updated = await calendarApi.updateEvent(eventRow.calendar_id, eventRow.google_event_id, updates);
    }

    db.run(
      `UPDATE events SET title = ?, start_time = ? WHERE id = ?`,
      [updates.title || eventRow.title, updates.startTime || eventRow.start_time, eventRow.id]
    );

    // Confirm the corrected value back so the team can double-check it landed right.
    return decision.reply_message || `แก้ให้แล้วค่ะ ✅ ${updates.title || eventRow.title} — เวลาใหม่ ${updates.startTime || eventRow.start_time}`;
  }

  if (decision.intent === 'onboarding_reply' && ex.team_name) {
    gs.setUserTeam(userId, ex.team_name, ex.project_id || null);
  }

  if (decision.intent === 'drive_search' && ex.query) {
    const results = await driveApi.search(ex.query);
    if (!results.length) {
      return `หาไม่เจอเลยค่ะ ลองเช็คชื่อไฟล์อีกทีไหมคะ 🔍`;
    }
    const lines = results
      .slice(0, 5)
      .map((r) => `${r.isFolder ? '📁' : '📄'} ${r.name}\n${r.link}`);
    return `เจอนี่ค่ะ:\n\n${lines.join('\n\n')}`;
  }

  if (decision.intent === 'add_detail_to_open_thread' && ex.event_id) {
    // Most common case: Migael asked "ใครต้องเข้าร่วม" and this message
    // is the answer. Link attendees to the existing event.
    if (ex.attendee_names?.length) {
      linkAttendees(ex.event_id, ex.attendee_names);
    }
    // Any other field mentioned (location, title tweak, etc.) — reuse the
    // same correction path so it patches the real Calendar event too.
    const eventRow = db.get(`SELECT * FROM events WHERE id = ?`, [ex.event_id]);
    if (eventRow && (ex.title || ex.start_time || ex.end_time)) {
      const updates = {};
      if (ex.title) updates.title = ex.title;
      if (ex.start_time) updates.startTime = ex.start_time;
      if (ex.end_time) updates.endTime = ex.end_time;
      if (eventRow.google_event_id && eventRow.calendar_id) {
        await calendarApi.updateEvent(eventRow.calendar_id, eventRow.google_event_id, updates);
      }
      db.run(`UPDATE events SET title = ?, start_time = ? WHERE id = ?`, [
        updates.title || eventRow.title,
        updates.startTime || eventRow.start_time,
        eventRow.id,
      ]);
    }
    return decision.reply_message || null;
  }

  if (decision.intent === 'log_topic' && ex.topic_title) {
    if (ex.topic_id) {
      // Updating an existing topic: rewrite the summary, don't append —
      // keeps it recap-able instead of turning into a growing log.
      db.run(
        `UPDATE topics SET summary = ?, reference_link = COALESCE(?, reference_link), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [ex.topic_summary || '', ex.reference_link || null, ex.topic_id]
      );
      linkTopicParticipants(ex.topic_id, ex.participant_names);
    } else {
      const id = randomUUID();
      db.run(
        `INSERT INTO topics (id, group_id, title, summary, reference_link, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, groupId, ex.topic_title, ex.topic_summary || '', ex.reference_link || null, userId]
      );
      linkTopicParticipants(id, ex.participant_names);
      gs.linkSession(sessionId, 'topic', id);
    }
    return decision.reply_message || `บันทึกไว้แล้วค่ะ 📌 "${ex.topic_title}"`;
  }

  if (decision.intent === 'recap_topic' && (ex.topic_id || ex.topic_title)) {
    // Prefer topic_id — Claude already saw the full list of open topics
    // (with summaries) in its prompt and can match meaning even when the
    // person uses different wording than the stored title. Falling back
    // to a literal title LIKE only catches exact/substring matches.
    const topic = ex.topic_id
      ? db.get(`SELECT * FROM topics WHERE id = ?`, [ex.topic_id])
      : db.get(
          `SELECT * FROM topics WHERE group_id = ? AND title LIKE ? ORDER BY updated_at DESC LIMIT 1`,
          [groupId, `%${ex.topic_title}%`]
        );
    if (!topic) {
      return `ยังไม่มีข้อมูลเรื่อง "${ex.topic_title || 'นี้'}" ในระบบเลยค่ะ`;
    }
    const updatedDate = formatThaiDate(topic.updated_at);
    return `ตามที่อัปเดตไปเมื่อวันที่ ${updatedDate} เรื่อง "${topic.title}" ค่ะ:\n${topic.summary}${topic.reference_link ? '\n🔗 ' + topic.reference_link : ''}`;
  }

  // status_update: left for a follow-up pass — v1 wiring intentionally
  // minimal so it's easy to extend once real usage patterns are clear.
  return null;
}

async function handlePersonal(event) {
  // Personal chat: full access, but ONLY for allowed userIds. Migael isn't
  // meant to be a general-purpose personal add for anyone who finds her —
  // set ALLOWED_PERSONAL_USER_IDS in .env (comma-separated LINE userIds).
  const userId = event.source.userId;
  const allowed = (process.env.ALLOWED_PERSONAL_USER_IDS || process.env.BABE_USER_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!allowed.includes(userId)) {
    return reply(event.replyToken,
      'สวัสดีค่ะ เราผู้ช่วยเบ้บนะคะ 👋 ตอนนี้ระบบยังไม่ให้คนอื่นใช้ค่ะ');
  }

  const text = event.message.text;
  const decision = await brain.interpret({
    groupName: 'personal',
    userName: 'เบ้บ',
    messageText: text,
    recentMessages: [],
    teamRoster: [],
    openThread: null,
    wasAddressed: true,
  });
  if (decision.reply_message) {
    await reply(event.replyToken, decision.reply_message);
  }
}

function reply(token, text) {
  return client.replyMessage(token, { type: 'text', text });
}

app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.json({ ok: true }))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

const PORT = process.env.PORT || 3000;

db.init().then(() => {
  app.listen(PORT, () => console.log(`Migael listening on port ${PORT}`));
});
