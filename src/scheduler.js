// scheduler.js — the three daily broadcasts + reminder polling.
// All times are Asia/Bangkok.
//
// Data queries here are NOT scoped by group_id — this Migael instance
// only ever lives in one real LINE group, and every broadcast/reminder
// pushes to that single group via gs.getPrimaryGroupId(). Task/event
// rows may still carry whatever group_id they were created under, but
// it's no longer used to filter data or pick a push destination — that
// caused real bugs (data going "missing" whenever the LINE group got
// recreated). See groupState.js for getPrimaryGroupId().
//
// Each broadcast is its own named function (not just a cron callback
// body) and exported, so index.js can trigger any of them on demand
// (e.g. "มิเกล ทดสอบสรุปเช้า") without waiting for the real scheduled time.

const cron = require('node-cron');
const db = require('./db');
const line = require('@line/bot-sdk');
const reports = require('./reports');
const { guessDepartment } = require('./classify');
const gs = require('./groupState');
const sheetSync = require('./sheetSync');
const { alertBabe } = require('./alertBabe');

// Wraps a cron job body so an unhandled error inside it alerts Babe
// personally instead of failing silently — this is what makes the
// alertBabe.js system actually useful; a job that throws and no one
// notices is exactly the gap it exists to close.
function withAlert(kind, fn) {
  return async () => {
    try {
      await fn();
    } catch (err) {
      await alertBabe(`Cron job failed: ${kind}`, err);
    }
  };
}
const { google } = require('googleapis');
const { getAuth } = require('./calendar');

// Today's event titles from the UNCOMMU calendar — this whole calendar
// (not per-event colorId) is what shows up as "orange" in the team's
// Google Calendar view, confirmed live 2026-08-02: querying UNCOMMU
// alone for today returned exactly the one orange item visible in the
// calendar screenshot Babe shared. Best-effort: any failure here (auth,
// network, calendar not found) just means no line gets added, never
// blocks the rest of the morning summary from sending.
async function getTodayUncommuEvents() {
  try {
    const cal = db.get(`SELECT id FROM calendars WHERE name = 'UNCOMMU'`);
    if (!cal) return [];
    const calendar = google.calendar({ version: 'v3', auth: getAuth() });
    // Bug fix (2026-08-03): setHours(0,0,0,0) sets hours in the SERVER's
    // local timezone (Railway runs in UTC), not Bangkok — so the window
    // was actually ~07:00 Bangkok to ~06:59 Bangkok the NEXT day, bleeding
    // into tomorrow's all-day events (confirmed live: showed tomorrow's
    // "RANK - Simmulator" as today's event). Build the window from an
    // explicit Bangkok midnight instead.
    const todayIso = bangkokTodayIso();
    const startOfDay = new Date(`${todayIso}T00:00:00+07:00`);
    const endOfDay = new Date(`${todayIso}T23:59:59+07:00`);
    const res = await calendar.events.list({
      calendarId: cal.id,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
    });
    return (res.data.items || []).map((e) => e.summary).filter(Boolean);
  } catch (err) {
    console.error('[Scheduler] getTodayUncommuEvents failed:', err.message);
    return [];
  }
}

const client = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

function push(groupId, text) {
  return client.pushMessage(groupId, { type: 'text', text });
}

// Real LINE mention checked against official docs (2026-08-03): the
// {index,length,userId} "mention" object on a plain type:'text' message
// is the format LINE sends TO the bot describing a mention a HUMAN typed
// — it is NOT a valid way for the bot to SEND a real mention. Confirmed
// this was the actual bug behind "mentions never worked" (team only
// ever saw literal "@name" text, no tag, no notification). The correct
// outbound format is "Text message (v2)": type 'textV2' with {placeholder}
// tokens in the text and a matching `substitution` map. LINE also
// requires every mentioned userId to be a real member of the group the
// message is sent to — a pseudo-user id (UUID format, from sheet-only
// names like แพร/OAK who've never chatted) is not a real LINE account
// and would break the mention, so those silently fall back to plain
// name text instead of a broken/rejected mention attempt.
const REAL_LINE_ID = /^U[0-9a-f]{32}$/i;

function createMentionBuilder() {
  let text = '';
  const substitution = {};
  let n = 0;
  return {
    add(str) {
      text += str;
      return this;
    },
    addMention(user) {
      if (!user?.id) return this;
      if (!REAL_LINE_ID.test(user.id)) {
        // Not a real LINE account (sheet-only pseudo-user) — can't be
        // mentioned at all; show the plain name so the message still
        // reads correctly instead of silently dropping the reference.
        text += user.display_name || '';
        return this;
      }
      const key = `m${n++}`;
      substitution[key] = { type: 'mention', mentionee: { type: 'user', userId: user.id } };
      text += `{${key}}`;
      return this;
    },
    build() {
      return Object.keys(substitution).length
        ? { type: 'textV2', text, substitution }
        : { type: 'text', text };
    },
  };
}

function pushMessage(groupId, message) {
  return client.pushMessage(groupId, message);
}

// Convenience wrapper for the common case: plain text with a list of
// people tagged at the end (e.g. "reminder text @person1 @person2").
function pushWithMentions(groupId, baseText, users) {
  if (!users || !users.length) return push(groupId, baseText);
  const mb = createMentionBuilder();
  mb.add(baseText.endsWith('\n') ? baseText : baseText + '\n');
  for (const u of users) {
    if (!u?.id) continue;
    mb.addMention(u).add(' ');
  }
  return pushMessage(groupId, mb.build());
}

// Matches the sheet's own "หมวดหมู่" dropdown exactly — see classify.js
const DEPT_EMOJI = {
  'SETUP': '🔧',
  'DECORATION': '🎨',
  'SYSTEM / EQUIPMENT': '🔌',
  'ACTIVITY': '🎪',
  'CT ONLINE': '💻',
  'CT OFFLINE': '🖨️',
  'COLLABORATION': '🤝',
  'SPONSOR': '💰',
  'เอกสาร': '📄',
  'SLIDE / DECK': '🖼️',
  'ติดต่อ / ติดตาม': '☎️',
  'PRODUCTION': '📸',
  'MEETING': '🗓️',
};

// Groups a list of task rows by department (using explicit team_name if
// set, else classify.js's keyword guess). Module-level (not nested
// inside any function) so both sendEveningRecap's group message AND its
// personal-summary-to-Babe section can call it regardless of which
// branches ran first — a nested version previously only got defined
// when `groupId` was truthy, which crashed the personal summary with
// "groupByDept is not a function" on any day Migael wasn't yet in a
// group (confirmed via a minimal repro, not just inferred from reading).
function groupByDept(items) {
  const byTeam = {};
  for (const t of items) {
    const key = t.team_name || guessDepartment(t.title) || 'อื่นๆ';
    byTeam[key] = byTeam[key] || [];
    byTeam[key].push(t);
  }
  return byTeam;
}

// Bangkok "today" as a plain YYYY-MM-DD string, for date-only comparisons
// against due_date (which may or may not carry a time component).
function bangkokTodayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
}

// Header date like "จันทร์ 3 ส.ค." for message headers — short Thai
// weekday + day + short Thai month, matching the format agreed on for
// A/B/C message headers (never a bare ISO date).
function formatThaiHeaderDate() {
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok', weekday: 'long', day: 'numeric', month: 'short',
  }).format(new Date());
}

// Urgency rank for sorting: lower = more urgent. Tasks with no due date
// rank last (but still above people with zero tasks at all).
function urgencyRank(dueDateStr, todayIso) {
  if (!dueDateStr) return 3;
  const due = String(dueDateStr).slice(0, 10);
  if (due < todayIso) return 0; // overdue
  if (due === todayIso) return 1; // due today
  return 2; // due later
}

// Relative Thai label for a due date, matching the format agreed on
// (เลยกำหนด / due วันนี้ / due พรุ่งนี้ / due <short weekday>) — never a
// raw ISO date, per spec.
function dueLabel(dueDateStr, todayIso) {
  if (!dueDateStr) return null;
  const due = String(dueDateStr).slice(0, 10);
  if (due < todayIso) return 'เลยกำหนด';
  if (due === todayIso) return 'due วันนี้';
  const tomorrow = new Date(todayIso + 'T00:00:00+07:00');
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(tomorrow);
  if (due === tomorrowIso) return 'due พรุ่งนี้';
  const dueDateObj = new Date(due + 'T00:00:00+07:00');
  const weekday = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', weekday: 'short' }).format(dueDateObj);
  return `due ${weekday}`;
}

// Formats a real meeting's start_time like "31 ก.ค. 13:00 น." — per
// spec, distinct from the header date format (no weekday needed here).
function formatMeetingDateTime(dbDateString) {
  const d = new Date(String(dbDateString).replace(' ', 'T'));
  if (isNaN(d)) return String(dbDateString);
  const datePart = new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short',
  }).format(d);
  const timePart = new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  return `${datePart} ${timePart} น.`;
}

// ---- Morning: what to do today, grouped by person, sorted by urgency ----
// intro/outro let a one-off special announcement wrap the normal content
// (e.g. "Migael has some new features today...") without needing a
// separate message template — used for the 2026-08-02 rollout announcement.
async function sendMorningBriefing({ force = false, intro = null, outro = null } = {}) {
  const groupId = gs.getPrimaryGroupId();
  if (!groupId) return;

  const todayIso = bangkokTodayIso();
  const roster = gs.getRoster(groupId);
  const uncommuEvents = await getTodayUncommuEvents();
  const tasks = db.all(
    `SELECT t.id, t.title, t.status, t.due_date, t.is_urgent, u.id as assignee_id, u.display_name as assignee
     FROM tasks t
     LEFT JOIN users u ON t.assignee_id = u.id
     WHERE t.status NOT IN ('done', 'cancelled')
     ORDER BY t.due_date`
  );
  const events = db.all(
    // Real meetings only — excludes the all-day Calendar entries every
    // task with a due date also gets (see index.js's createCalendarEvent
    // calls with allDay:true). Those get stored with a midnight/no-time
    // start_time, so filtering out '00:00:00' keeps only genuinely timed
    // meetings here. Confirmed bug via live test: task due-dates were
    // showing up as "4 มีตติ้งวันนี้" in the morning summary before this.
    `SELECT title, start_time, meeting_link FROM events
     WHERE date(start_time) = date('now', '+7 hours')
       AND strftime('%H:%M:%S', start_time) IS NOT NULL
       AND strftime('%H:%M:%S', start_time) != '00:00:00'`
  );

  if (!tasks.length && !events.length && !roster.length && !force) return;

  // Group tasks by DISPLAY NAME, not raw assignee_id — confirmed live
  // (2026-08-02) that the same real person can have two different LINE
  // account ids (see fixDuplicateAssignees.js's file header for the full
  // story), which would otherwise still show as two separate name
  // headers here even after that fix keeps both id rows alive. Grouping
  // by name is robust to that regardless of how many ids end up sharing
  // it. Unassigned tasks get their own bucket at the very end (not a
  // real person, so never tagged with a question).
  const byPerson = new Map(); // key: display name -> {name, rank, items:[]}
  for (const r of roster) {
    byPerson.set(r.name, { name: r.name, rank: 4, items: [] }); // rank 4 = "no task yet", below rank 3
  }
  const unassigned = [];
  for (const t of tasks) {
    const rank = urgencyRank(t.due_date, todayIso);
    const label = dueLabel(t.due_date, todayIso);
    const line = t.title + (label ? ` (${label})` : '') + (t.is_urgent ? ' 🔴' : '');
    if (t.assignee) {
      if (!byPerson.has(t.assignee)) byPerson.set(t.assignee, { name: t.assignee, rank: 4, items: [] });
      const entry = byPerson.get(t.assignee);
      entry.items.push(line);
      entry.rank = Math.min(entry.rank, rank);
    } else {
      unassigned.push(line);
    }
  }

  const sortedPeople = [...byPerson.values()].sort((a, b) => a.rank - b.rank);

  let msg = '';
  if (intro) msg += `${intro}\n\n`;
  msg += `📋 วันนี้สิ่งที่ต้องทำ | ${formatThaiHeaderDate()}\n`;
  if (uncommuEvents.length) {
    msg += `\nวันนี้เป็นงาน: ${uncommuEvents.join(', ')}\n`;
  }
  for (const person of sortedPeople) {
    if (!person.items.length) continue; // handled together below, not per-person
    msg += `\n${person.name}\n`;
    for (const item of person.items) msg += `- ${item}\n`;
  }
  // People with zero tasks get ONE combined line instead of a repeated
  // "- วันนี้มีอะไรต้องทำมั้ย?" block per person — confirmed live
  // (2026-08-02) that repeating the same question under 4 separate name
  // headers read as spammy/redundant rather than personal.
  const noTaskNames = sortedPeople.filter((p) => !p.items.length).map((p) => p.name);
  if (noTaskNames.length) {
    msg += `\n${noTaskNames.join(', ')} — วันนี้มีอะไรต้องทำมั้ย?\n`;
  }
  if (unassigned.length) {
    msg += `\nยังไม่ระบุผู้รับผิดชอบ\n`;
    for (const item of unassigned) msg += `- ${item}\n`;
  }
  // Always say something about meetings, even "none today" — leaving
  // this section out entirely when events.length===0 (old behavior) read
  // as "did Migael even check?" rather than "confirmed, nothing today".
  if (events.length) {
    msg += `\nวันนี้มีมีตติ้ง 👇\n`;
    for (const e of events) {
      msg += `\n${e.title}\n${formatMeetingDateTime(e.start_time)}\n${e.meeting_link ? '🔗 ' + e.meeting_link : ''}\n`;
    }
  } else {
    msg += `\nวันนี้ไม่มีมีตติ้งนะคะ`;
  }
  if (!sortedPeople.length && !unassigned.length && !events.length) {
    msg += `\n(ยังไม่มีงานหรือคนในระบบเลยนะคะ)`;
  }
  if (outro) msg += `\n\n${outro}`;

  await push(groupId, msg.trim());
}
cron.schedule('0 10 * * *', withAlert('morning briefing', sendMorningBriefing), { timezone: 'Asia/Bangkok' });

// ---- Check-in (15:00): ask specifically about each person's tasks that
// are due today or already overdue — merged midday+afternoon slot per
// spec (was two separate broadcasts; team asked for one at 15:00). ----
async function sendAfternoonCheckin({ force = false } = {}) {
  const groupId = gs.getPrimaryGroupId();
  if (!groupId) return;

  const relevant = db.all(
    `SELECT t.title, u.id as assignee_id, u.display_name as assignee FROM tasks t
     LEFT JOIN users u ON t.assignee_id = u.id
     WHERE t.status NOT IN ('done', 'cancelled') AND date(t.due_date) <= date('now', '+7 hours')
     ORDER BY t.due_date`
  );
  if (!relevant.length && !force) return;

  // Group by person — one mention + one combined list, not a repeated
  // "@person — task ถึงไหนแล้วคะ?" line per task. Confirmed live
  // (2026-08-03): the team doesn't read a wall of near-identical lines,
  // it reads as spammy/confusing rather than personal.
  const byPerson = new Map(); // display name -> {user, items:[]}
  const unassigned = [];
  for (const t of relevant) {
    if (t.assignee_id) {
      if (!byPerson.has(t.assignee)) byPerson.set(t.assignee, { user: { id: t.assignee_id, display_name: t.assignee }, items: [] });
      byPerson.get(t.assignee).items.push(t.title);
    } else {
      unassigned.push(t.title);
    }
  }

  const mb = createMentionBuilder();
  mb.add(`🔄 เช็คความคืบหน้า | ${formatThaiHeaderDate()} 15:00\n`);
  if (!relevant.length) {
    mb.add('\n(ยังไม่มีงานที่ครบกำหนดวันนี้ในระบบนะคะ)');
  }
  for (const { user, items } of byPerson.values()) {
    mb.add('\n').addMention(user).add(` มีงาน:\n`);
    for (const title of items) mb.add(`- ${title}\n`);
    mb.add(`ถึงไหนแล้วบ้างคะ?\n`);
  }
  if (unassigned.length) {
    mb.add(`\nยังไม่ระบุผู้รับผิดชอบ:\n`);
    for (const title of unassigned) mb.add(`- ${title}\n`);
  }
  await pushMessage(groupId, mb.build());
}
cron.schedule('0 15 * * *', withAlert('afternoon checkin', sendAfternoonCheckin), { timezone: 'Asia/Bangkok' });

// ---- Reminder polling: every 5 minutes, check for meetings and overdue tasks ----
cron.schedule('*/5 * * * *', withAlert('meeting/overdue polling', async () => {
  await checkMeetingReminders();
  await checkOverdueTasks();
}), { timezone: 'Asia/Bangkok' });

async function checkMeetingReminders() {
  const groupId = gs.getPrimaryGroupId();
  if (!groupId) return;

  // Events starting in ~30 or ~10 minutes that haven't been reminded yet
  for (const window of [30, 10]) {
    const events = db.all(
      `SELECT * FROM events
       WHERE datetime(start_time) BETWEEN datetime('now', '+${window - 2} minutes')
                                       AND datetime('now', '+${window + 2} minutes')`
    );
    for (const e of events) {
      const already = db.get(
        `SELECT id FROM reminders WHERE ref_type='event' AND ref_id=? AND reminder_type=?`,
        [e.id, `pre_${window}min`]
      );
      if (already) continue;

      const attendees = db.all(
        `SELECT u.id, u.display_name FROM event_attendees ea JOIN users u ON ea.user_id = u.id WHERE ea.event_id = ?`,
        [e.id]
      );

      // Wording adapts to whether this is a real meeting (has a Meet
      // link) or a plain timed reminder created via the "เตือน X ตอน Y"
      // pattern — saying "มีมีตติ้ง" for a non-meeting reminder read oddly.
      const label = e.meeting_link ? 'มีมีตติ้ง' : 'ถึงเวลาแล้ว —';
      const baseText = `⏰ เตือนค่ะ อีก ${window} นาที ${label} "${e.title}"\n${e.meeting_link ? '🔗 ' + e.meeting_link : ''}`.trim();
      await pushWithMentions(groupId, baseText, attendees);

      db.run(
        `INSERT INTO reminders (id, ref_type, ref_id, reminder_type, scheduled_at, sent_at, group_id)
         VALUES (?, 'event', ?, ?, datetime('now'), datetime('now'), ?)`,
        [require('crypto').randomUUID(), e.id, `pre_${window}min`, groupId]
      );
    }
  }
}

async function checkOverdueTasks() {
  const groupId = gs.getPrimaryGroupId();
  if (!groupId) return;

  const overdue = db.all(
    `SELECT t.*, u.id as assignee_id2, u.display_name as assignee_name FROM tasks t
     LEFT JOIN users u ON t.assignee_id = u.id
     WHERE t.status NOT IN ('done', 'cancelled') AND datetime(t.due_date) < datetime('now', '+7 hours')`
  );

  // Collect everything due for a reminder right now, then send ONE
  // combined message instead of one push per task — with a dozen-plus
  // overdue rows this used to flood the chat with a wall of separate
  // red-alert messages.
  const dueForReminder = [];
  for (const t of overdue) {
    const intervalHours = t.is_urgent ? 24 : 48;
    const lastReminder = db.get(
      `SELECT * FROM reminders WHERE ref_type='task' AND ref_id=? AND reminder_type='overdue'
       ORDER BY sent_at DESC LIMIT 1`,
      [t.id]
    );
    const hoursSinceLast = lastReminder
      ? (Date.now() - new Date(lastReminder.sent_at).getTime()) / 3600000
      : Infinity;
    if (hoursSinceLast < intervalHours) continue;
    dueForReminder.push(t);
  }

  if (!dueForReminder.length) return;

  const mb = createMentionBuilder();
  mb.add(`🔴 แจ้งเตือนค่ะ งานที่เลยกำหนดเสร็จแล้ว (${dueForReminder.length} รายการ) ขออัปเดตสถานะด้วยค่ะ\n`);
  for (const t of dueForReminder) {
    mb.add(`- ${t.title}`);
    if (t.assignee_id2) mb.add(' ').addMention({ id: t.assignee_id2, display_name: t.assignee_name });
    mb.add('\n');
  }
  await pushMessage(groupId, mb.build());

  for (const t of dueForReminder) {
    db.run(
      `INSERT INTO reminders (id, ref_type, ref_id, reminder_type, scheduled_at, sent_at, group_id)
       VALUES (?, 'task', ?, 'overdue', datetime('now'), datetime('now'), ?)`,
      [require('crypto').randomUUID(), t.id, groupId]
    );
  }
}

// ---- Stale topic nudge: once a day, ping topics nobody's touched in a
// while, tagging whoever was involved — this is what keeps ideas/specs
// from silently dying in chat once the conversation moves on. ----
cron.schedule('30 10 * * *', withAlert('stale topic nudge', async () => {
  const groupId = gs.getPrimaryGroupId();
  if (!groupId) return;

  const staleTopics = db.all(
    `SELECT * FROM topics WHERE status = 'open' AND datetime(updated_at) < datetime('now', '-3 days')`
  );
  for (const t of staleTopics) {
    const participants = db.all(
      `SELECT u.id, u.display_name FROM topic_participants tp JOIN users u ON tp.user_id = u.id WHERE tp.topic_id = ?`,
      [t.id]
    );
    const baseText = `📌 เรื่อง "${t.title}" เงียบไปหลายวันแล้วนะคะ มีอัปเดตอะไรไหมคะ\n${t.summary}${t.reference_link ? '\n🔗 ' + t.reference_link : ''}`;
    await pushWithMentions(groupId, baseText, participants);
  }
}, { timezone: 'Asia/Bangkok' }));

// ---- Evening: recap + tomorrow prep ----
async function sendEveningRecap({ force = false } = {}) {
  const groupId = gs.getPrimaryGroupId();

  // Generate Babe's personal summary report (see reports.js — this is
  // now a short overview, not a raw checklist to copy-paste, since
  // Migael writes to the sheet herself now).
  let reportUrl = null;
  if (process.env.PUBLIC_BASE_URL) {
    const base = process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
    try {
      const { filename } = reports.generateDailyReport();
      reportUrl = `${base}/reports/${filename}`;
    } catch (err) {
      console.error('[Reports] failed to generate daily report:', err.message);
    }
  }

  if (groupId) {
    const done = db.all(
      `SELECT t.title, u.display_name as assignee FROM tasks t
       LEFT JOIN users u ON t.assignee_id = u.id
       WHERE t.status = 'done' AND date(t.completed_at) = date('now', '+7 hours')`
    );
    const pending = db.all(
      `SELECT t.title, u.display_name as assignee, tm.name as team_name FROM tasks t
       LEFT JOIN users u ON t.assignee_id = u.id
       LEFT JOIN teams tm ON t.team_id = tm.id
       WHERE t.status NOT IN ('done', 'cancelled') AND date(t.due_date) <= date('now', '+7 hours')`
    );

    if (done.length || pending.length || force) {
      const mb = createMentionBuilder();
      mb.add(`🌙 สรุปวันนี้ | ${formatThaiHeaderDate()}\n`);
      if (!done.length && !pending.length) {
        mb.add('\n(ยังไม่มีข้อมูลงานในระบบวันนี้ค่ะ)');
      }

      if (done.length) {
        mb.add(`\n✅ เสร็จแล้ว\n`);
        for (const t of done) mb.add(`- ${t.title}${t.assignee ? ' (' + t.assignee + ')' : ''}\n`);
      }

      if (pending.length) {
        mb.add(`\n⏳ ยังค้าง\n`);
        for (const t of pending) mb.add(`- ${t.title}${t.assignee ? ' (' + t.assignee + ')' : ''}\n`);
      }

      // Tag everyone in the group in one line asking about tomorrow —
      // per spec this replaces the old static "พรุ่งนี้" list (which
      // just echoed due_date, not an actual prompt for new work) and
      // avoids repeating the same question once per person (that read
      // as spammy — see prior discussion).
      const roster = gs.getRoster(groupId);
      if (roster.length) {
        mb.add('\n---\n');
        for (const r of roster) mb.addMention({ id: r.id, display_name: r.name }).add(' ');
        mb.add('พรุ่งนี้ใครมีงานอะไรเพิ่มมั้ยคะ บอกมาได้เลยนะคะ 🙏');
      }

      await pushMessage(groupId, mb.build());
    }
  }

  // Personal summary to Babe — per spec, this is now just a link to the
  // short overview report (see reports.js), sent as a link rather than
  // pasted inline text (Babe's own choice: "เป็นลิงค์ละกัน จะได้ไม่รก").
  // No more separate grouped-by-department text dump or CSV — the sheet
  // itself is the source of truth now that Migael writes to it directly.
  if (process.env.BABE_USER_ID && reportUrl) {
    await client.pushMessage(process.env.BABE_USER_ID, {
      type: 'text',
      text: `สรุปวันนี้ค่ะ 📊\n${reportUrl}`,
    });
  }
}
cron.schedule('0 22 * * *', withAlert('evening recap', sendEveningRecap), { timezone: 'Asia/Bangkok' });

// ---- Sheet sync: every 3 minutes, pick up any tasks the team added
// directly in the UNFEST'26_CHECKLIST sheet instead of through LINE ----
cron.schedule('*/3 * * * *', withAlert('sheet sync', () => sheetSync.run()), { timezone: 'Asia/Bangkok' });

// Also run once at startup so new sheet rows show up without waiting
// for the first scheduled sync after a deploy.
sheetSync.run();

module.exports = {
  sendMorningBriefing,
  sendAfternoonCheckin,
  sendEveningRecap,
  checkMeetingReminders,
  checkOverdueTasks,
};
