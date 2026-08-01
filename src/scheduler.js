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

const client = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

function push(groupId, text) {
  return client.pushMessage(groupId, { type: 'text', text });
}

// Real LINE mentions (not just "@name" text) require the Messaging API's
// mention object — a list of {index, length, userId} pointing at exact
// character ranges in the text. Plain "@name" text does NOT notify or
// highlight anyone; this builder is what actually pings the tagged person,
// and supports tags anywhere in the message (start, middle, or end),
// not just appended at the very end.
function createMentionBuilder() {
  let text = '';
  const mentionees = [];
  return {
    add(str) {
      text += str;
      return this;
    },
    addMention(user) {
      if (!user?.id) return this;
      const tag = `@${user.display_name}`;
      mentionees.push({ index: text.length, length: tag.length, type: 'user', userId: user.id });
      text += tag;
      return this;
    },
    build() {
      return mentionees.length
        ? { type: 'text', text, mention: { mentionees } }
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

// ---- Morning: what to do today ----
async function sendMorningBriefing({ force = false } = {}) {
  const groupId = gs.getPrimaryGroupId();
  if (!groupId) return;

  const tasks = db.all(
    `SELECT t.title, t.is_urgent, t.status, tm.name as team_name, u.display_name as assignee
     FROM tasks t
     LEFT JOIN teams tm ON t.team_id = tm.id
     LEFT JOIN users u ON t.assignee_id = u.id
     WHERE t.status != 'done' AND date(t.start_date) = date('now')`
  );

  const byTeam = {};
  for (const t of tasks) {
    const key = t.team_name || guessDepartment(t.title) || 'อื่นๆ';
    byTeam[key] = byTeam[key] || [];
    const statusTag = t.status === 'in_progress' ? ' (กำลังทำ)' : '';
    byTeam[key].push(t.title + statusTag + (t.is_urgent ? ' (ด่วน)' : ''));
  }

  const events = db.all(
    `SELECT title, start_time, meeting_link FROM events WHERE date(start_time) = date('now')`
  );

  if (!tasks.length && !events.length && !force) return;

  let msg = `สวัสดีค่ะทีม ☀️ สรุปสิ่งที่ต้องทำวันนี้\n`;
  if (!tasks.length && !events.length) {
    msg += `\n(ยังไม่มีงานหรือนัดที่ต้องเริ่มวันนี้ในระบบนะคะ)`;
  }
  for (const [team, items] of Object.entries(byTeam)) {
    const emoji = DEPT_EMOJI[team] || '📋';
    msg += `\n${emoji} ${team}\n`;
    for (const item of items) msg += `- ${item}\n`;
  }
  if (events.length) {
    msg += `\nมี ${events.length} มีตติ้งวันนี้ 👇\n`;
    for (const e of events) {
      msg += `${e.title} – ${e.start_time}\n${e.meeting_link ? '🔗 ' + e.meeting_link : ''}\n`;
    }
  }

  await push(groupId, msg.trim());
}
cron.schedule('0 10 * * *', () => sendMorningBriefing(), { timezone: 'Asia/Bangkok' });

// ---- Afternoon check-in: nudge on TODAY's tasks that aren't overdue yet ----
// This is separate from checkOverdueTasks() below — that one only fires
// once a task has passed its deadline. This one follows up mid-day on
// what was listed in the morning broadcast, even if it's not late yet.
async function sendAfternoonCheckin({ force = false } = {}) {
  const groupId = gs.getPrimaryGroupId();
  if (!groupId) return;

  const notStarted = db.all(
    `SELECT t.title, u.id as assignee_id, u.display_name as assignee FROM tasks t
     LEFT JOIN users u ON t.assignee_id = u.id
     WHERE t.status = 'to_do' AND date(t.due_date) = date('now')`
  );
  const inProgress = db.all(
    `SELECT t.title, u.id as assignee_id, u.display_name as assignee FROM tasks t
     LEFT JOIN users u ON t.assignee_id = u.id
     WHERE t.status = 'in_progress' AND date(t.due_date) = date('now')`
  );
  if (!notStarted.length && !inProgress.length && !force) return;

  const mb = createMentionBuilder();
  mb.add('แวะมาถามความคืบหน้าหน่อยค่ะ 🙂\n');
  if (!notStarted.length && !inProgress.length) {
    mb.add('(ยังไม่มีงานที่ครบกำหนดวันนี้ในระบบนะคะ)');
  }
  for (const t of notStarted) {
    mb.add(`${t.title} `);
    if (t.assignee_id) mb.addMention({ id: t.assignee_id, display_name: t.assignee });
    mb.add(' — เริ่มหรือยังคะ\n');
  }
  for (const t of inProgress) {
    mb.add(`${t.title} `);
    if (t.assignee_id) mb.addMention({ id: t.assignee_id, display_name: t.assignee });
    mb.add(' — เสร็จหรือยังคะ\n');
  }
  await pushMessage(groupId, mb.build());
}
cron.schedule('0 15 * * *', () => sendAfternoonCheckin(), { timezone: 'Asia/Bangkok' });

// ---- Reminder polling: every 5 minutes, check for meetings and overdue tasks ----
cron.schedule('*/5 * * * *', async () => {
  await checkMeetingReminders();
  await checkOverdueTasks();
}, { timezone: 'Asia/Bangkok' });

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
     WHERE t.status != 'done' AND datetime(t.due_date) < datetime('now')`
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
cron.schedule('30 10 * * *', async () => {
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
}, { timezone: 'Asia/Bangkok' });

// ---- Evening: recap + tomorrow prep ----
async function sendEveningRecap({ force = false } = {}) {
  const groupId = gs.getPrimaryGroupId();

  // Generate both the .txt overview and a sheet-ready CSV, reuse the
  // same links everywhere. The CSV is what Babe actually copy-pastes
  // into the real sheet — the plain checklist .txt was tedious to
  // transcribe by hand every evening.
  let reportUrl = null;
  let csvUrl = null;
  if (process.env.PUBLIC_BASE_URL) {
    const base = process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
    try {
      const { filename } = reports.generateDailyReport();
      reportUrl = `${base}/reports/${filename}`;
    } catch (err) {
      console.error('[Reports] failed to generate daily report:', err.message);
    }
    try {
      const { filename } = reports.generateDailyCsv();
      csvUrl = `${base}/reports/${filename}`;
    } catch (err) {
      console.error('[Reports] failed to generate daily CSV:', err.message);
    }
  }

  if (groupId) {
    const done = db.all(
      `SELECT t.title, tm.name as team_name FROM tasks t
       LEFT JOIN teams tm ON t.team_id = tm.id
       WHERE t.status = 'done' AND date(t.completed_at) = date('now')`
    );
    const pending = db.all(
      `SELECT t.title, u.display_name as assignee, tm.name as team_name FROM tasks t
       LEFT JOIN users u ON t.assignee_id = u.id
       LEFT JOIN teams tm ON t.team_id = tm.id
       WHERE t.status != 'done' AND date(t.due_date) <= date('now')`
    );
    const tomorrow = db.all(
      `SELECT title FROM tasks WHERE date(due_date) = date('now', '+1 day')`
    );

    // Same "group by department with an emoji header" template used by
    // the morning briefing and the in-chat status_check answer — this
    // recap used to be one long comma-separated wall of text instead,
    // which was the actual complaint (not just data accuracy).
    function groupByDept(items) {
      const byTeam = {};
      for (const t of items) {
        const key = t.team_name || guessDepartment(t.title) || 'อื่นๆ';
        byTeam[key] = byTeam[key] || [];
        byTeam[key].push(t);
      }
      return byTeam;
    }

    if (done.length || pending.length || tomorrow.length || force) {
      let msg = `สรุปวันนี้ค่ะ 🌙`;
      if (!done.length && !pending.length && !tomorrow.length) {
        msg += '\n\n(ยังไม่มีข้อมูลงานในระบบวันนี้ค่ะ)';
      }

      if (done.length) {
        msg += `\n\n✅ เสร็จแล้ววันนี้`;
        const byTeam = groupByDept(done);
        for (const [team, items] of Object.entries(byTeam)) {
          const emoji = DEPT_EMOJI[team] || '📋';
          msg += `\n${emoji} ${team}\n`;
          for (const item of items) msg += `- ${item.title}\n`;
        }
      }

      if (pending.length) {
        msg += `\n⬜ ยังค้าง`;
        const byTeam = groupByDept(pending);
        for (const [team, items] of Object.entries(byTeam)) {
          const emoji = DEPT_EMOJI[team] || '📋';
          msg += `\n${emoji} ${team}\n`;
          for (const item of items) msg += `- ${item.title}${item.assignee ? ' (' + item.assignee + ')' : ''}\n`;
        }
      }

      if (tomorrow.length) {
        msg += `\n📅 พรุ่งนี้\n${tomorrow.map((t) => '- ' + t.title).join('\n')}`;
      }

      await push(groupId, msg.trim());
    }
  }

  // Personal summary to Babeb — same grouped-by-department text as the
  // group message (readable, not a raw pipe-delimited data dump), plus
  // the CSV file which is the actual sheet-ready deliverable.
  if (process.env.BABE_USER_ID) {
    const donePersonal = db.all(
      `SELECT t.title, tm.name as team_name FROM tasks t
       LEFT JOIN teams tm ON t.team_id = tm.id
       WHERE t.status = 'done' AND date(t.completed_at) = date('now')`
    );
    const pendingPersonal = db.all(
      `SELECT t.title, u.display_name as assignee, tm.name as team_name FROM tasks t
       LEFT JOIN users u ON t.assignee_id = u.id
       LEFT JOIN teams tm ON t.team_id = tm.id
       WHERE t.status != 'done'`
    );

    let msg = `สรุปสำหรับเบ้บค่ะ 🌙`;
    if (donePersonal.length) {
      msg += `\n\n✅ เสร็จแล้ววันนี้ (${donePersonal.length})`;
      for (const [team, items] of Object.entries(groupByDept(donePersonal))) {
        msg += `\n${DEPT_EMOJI[team] || '📋'} ${team}\n`;
        for (const item of items) msg += `- ${item.title}\n`;
      }
    }
    if (pendingPersonal.length) {
      msg += `\n📋 ค้างทั้งหมด (${pendingPersonal.length})`;
      for (const [team, items] of Object.entries(groupByDept(pendingPersonal))) {
        msg += `\n${DEPT_EMOJI[team] || '📋'} ${team}\n`;
        for (const item of items) msg += `- ${item.title}${item.assignee ? ' (' + item.assignee + ')' : ''}\n`;
      }
    }
    await client.pushMessage(process.env.BABE_USER_ID, { type: 'text', text: msg.trim() });

    if (csvUrl) {
      const reportPageUrl = `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/report?csv=${encodeURIComponent(csvUrl)}`;
      await client.pushMessage(process.env.BABE_USER_ID, {
        type: 'text',
        text: `ดูตารางงานทั้งหมดแบบอ่านง่ายได้ที่นี่ค่ะ 📊 (มีลิงก์ดาวน์โหลด .csv ไว้ก็อปเข้า sheet ในหน้าเดียวกัน)\n${reportPageUrl}`,
      });
    }
  }
}
cron.schedule('0 22 * * *', () => sendEveningRecap(), { timezone: 'Asia/Bangkok' });

// ---- Sheet sync: every 3 minutes, pick up any tasks the team added
// directly in the UNFEST'26_CHECKLIST sheet instead of through LINE ----
cron.schedule('*/3 * * * *', () => sheetSync.run(), { timezone: 'Asia/Bangkok' });

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
