// scheduler.js — the three daily broadcasts + reminder polling.
// All times are Asia/Bangkok. Adjust cron expressions to taste once
// the team's actual working hours are confirmed.

const cron = require('node-cron');
const db = require('./db');
const line = require('@line/bot-sdk');
const reports = require('./reports');

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

// ---- Morning: what to do today ----
cron.schedule('0 10 * * *', async () => {
  const groups = db.all('SELECT id FROM line_groups');
  for (const g of groups) {
    const tasks = db.all(
      `SELECT t.title, t.is_urgent, tm.name as team_name, u.display_name as assignee
       FROM tasks t
       LEFT JOIN teams tm ON t.team_id = tm.id
       LEFT JOIN users u ON t.assignee_id = u.id
       WHERE t.group_id = ? AND t.status != 'done' AND date(t.due_date) = date('now')`,
      [g.id]
    );
    if (tasks.length === 0) continue;

    const byTeam = {};
    for (const t of tasks) {
      const key = t.team_name || 'ทั่วไป';
      byTeam[key] = byTeam[key] || [];
      byTeam[key].push(t.title + (t.is_urgent ? ' (ด่วน)' : ''));
    }

    let msg = `สวัสดีค่ะทีม ☀️ สรุปสิ่งที่ต้องทำวันนี้\n\n`;
    for (const [team, items] of Object.entries(byTeam)) {
      msg += `${team}: ${items.join(', ')}\n`;
    }

    const events = db.all(
      `SELECT title, start_time, meeting_link FROM events
       WHERE group_id = ? AND date(start_time) = date('now')`,
      [g.id]
    );
    if (events.length) {
      msg += `\nมี ${events.length} มีตติ้งวันนี้ 👇\n`;
      for (const e of events) {
        msg += `${e.title} – ${e.start_time}\n${e.meeting_link ? '🔗 ' + e.meeting_link : ''}\n`;
      }
    }

    await push(g.id, msg.trim());
  }
}, { timezone: 'Asia/Bangkok' });

// ---- Afternoon check-in: nudge on TODAY's tasks that aren't overdue yet ----
// This is separate from checkOverdueTasks() below — that one only fires
// once a task has passed its deadline. This one follows up mid-day on
// what was listed in the morning broadcast, even if it's not late yet.
cron.schedule('0 14 * * *', async () => {
  const groups = db.all('SELECT id FROM line_groups');
  for (const g of groups) {
    const notStarted = db.all(
      `SELECT t.title, u.id as assignee_id, u.display_name as assignee FROM tasks t
       LEFT JOIN users u ON t.assignee_id = u.id
       WHERE t.group_id = ? AND t.status = 'to_do' AND date(t.due_date) = date('now')`,
      [g.id]
    );
    const inProgress = db.all(
      `SELECT t.title, u.id as assignee_id, u.display_name as assignee FROM tasks t
       LEFT JOIN users u ON t.assignee_id = u.id
       WHERE t.group_id = ? AND t.status = 'in_progress' AND date(t.due_date) = date('now')`,
      [g.id]
    );
    if (!notStarted.length && !inProgress.length) continue;

    const mb = createMentionBuilder();
    mb.add('แวะมาถามความคืบหน้าหน่อยค่ะ 🙂\n');
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
    await pushMessage(g.id, mb.build());
  }
}, { timezone: 'Asia/Bangkok' });

// ---- Reminder polling: every 5 minutes, check for meetings and overdue tasks ----
cron.schedule('*/5 * * * *', async () => {
  await checkMeetingReminders();
  await checkOverdueTasks();
}, { timezone: 'Asia/Bangkok' });

async function checkMeetingReminders() {
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

      const baseText = `⏰ เตือนค่ะ อีก ${window} นาที มีมีตติ้ง "${e.title}"\n${e.meeting_link ? '🔗 ' + e.meeting_link : ''}`.trim();
      await pushWithMentions(e.group_id, baseText, attendees);

      db.run(
        `INSERT INTO reminders (id, ref_type, ref_id, reminder_type, scheduled_at, sent_at, group_id)
         VALUES (?, 'event', ?, ?, datetime('now'), datetime('now'), ?)`,
        [require('crypto').randomUUID(), e.id, `pre_${window}min`, e.group_id]
      );
    }
  }
}

async function checkOverdueTasks() {
  const overdue = db.all(
    `SELECT t.*, u.id as assignee_id2, u.display_name as assignee_name FROM tasks t
     LEFT JOIN users u ON t.assignee_id = u.id
     WHERE t.status != 'done' AND datetime(t.due_date) < datetime('now')`
  );
  for (const t of overdue) {
    // Reminder frequency depends on priority, not how long it's been
    // overdue — urgent tasks get nudged more often than normal ones.
    const intervalHours = t.is_urgent ? 24 : 48; // urgent: every 1 day, normal: every 2 days
    const lastReminder = db.get(
      `SELECT * FROM reminders WHERE ref_type='task' AND ref_id=? AND reminder_type='overdue'
       ORDER BY sent_at DESC LIMIT 1`,
      [t.id]
    );
    const hoursSinceLast = lastReminder
      ? (Date.now() - new Date(lastReminder.sent_at).getTime()) / 3600000
      : Infinity;

    if (hoursSinceLast < intervalHours) continue;

    const baseText = `🔴 แจ้งเตือนค่ะ งาน "${t.title}" เลยกำหนดเสร็จแล้ว ขออัปเดตสถานะด้วยค่ะ`;
    const assignee = t.assignee_id2 ? [{ id: t.assignee_id2, display_name: t.assignee_name }] : [];
    await pushWithMentions(t.group_id, baseText, assignee);

    db.run(
      `INSERT INTO reminders (id, ref_type, ref_id, reminder_type, scheduled_at, sent_at, group_id)
       VALUES (?, 'task', ?, 'overdue', datetime('now'), datetime('now'), ?)`,
      [require('crypto').randomUUID(), t.id, t.group_id]
    );
  }
}

// ---- Stale topic nudge: once a day, ping topics nobody's touched in a
// while, tagging whoever was involved — this is what keeps ideas/specs
// from silently dying in chat once the conversation moves on. ----
cron.schedule('30 10 * * *', async () => {
  const staleTopics = db.all(
    `SELECT * FROM topics WHERE status = 'open' AND datetime(updated_at) < datetime('now', '-3 days')`
  );
  for (const t of staleTopics) {
    const participants = db.all(
      `SELECT u.id, u.display_name FROM topic_participants tp JOIN users u ON tp.user_id = u.id WHERE tp.topic_id = ?`,
      [t.id]
    );
    const baseText = `📌 เรื่อง "${t.title}" เงียบไปหลายวันแล้วนะคะ มีอัปเดตอะไรไหมคะ\n${t.summary}${t.reference_link ? '\n🔗 ' + t.reference_link : ''}`;
    await pushWithMentions(t.group_id, baseText, participants);
  }
}, { timezone: 'Asia/Bangkok' });

// ---- Evening: recap + tomorrow prep ----
cron.schedule('0 22 * * *', async () => {
  // Generate the .txt overview report once, reuse the same link everywhere.
  let reportUrl = null;
  if (process.env.PUBLIC_BASE_URL) {
    try {
      const { filename } = reports.generateDailyReport();
      reportUrl = `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/reports/${filename}`;
    } catch (err) {
      console.error('[Reports] failed to generate daily report:', err.message);
    }
  }

  const groups = db.all('SELECT id FROM line_groups');
  for (const g of groups) {
    const done = db.all(
      `SELECT title FROM tasks WHERE group_id = ? AND status = 'done' AND date(completed_at) = date('now')`,
      [g.id]
    );
    const pending = db.all(
      `SELECT t.title, u.display_name as assignee FROM tasks t
       LEFT JOIN users u ON t.assignee_id = u.id
       WHERE t.group_id = ? AND t.status != 'done' AND date(t.due_date) <= date('now')`,
      [g.id]
    );
    const tomorrow = db.all(
      `SELECT title FROM tasks WHERE group_id = ? AND date(due_date) = date('now', '+1 day')`,
      [g.id]
    );

    if (!done.length && !pending.length && !tomorrow.length) continue;

    let msg = `สรุปวันนี้ค่ะ 🌙\n\n`;
    if (done.length) msg += `เสร็จแล้ว: ${done.map((d) => d.title).join(', ')}\n`;
    if (pending.length)
      msg += `ยังค้าง: ${pending.map((p) => `${p.title}${p.assignee ? ' (' + p.assignee + ')' : ''}`).join(', ')}\n`;
    if (tomorrow.length) msg += `\nพรุ่งนี้:\n- ${tomorrow.map((t) => t.title).join('\n- ')}`;

    // Group only gets the plain recap text — the .txt report link goes to
    // Babeb personally below, not into the group.
    await push(g.id, msg.trim());
  }

  // Personal summary to Babeb for manual sheet entry — sent to her 1:1 chat.
  if (process.env.BABE_USER_ID) {
    const allPending = db.all(
      `SELECT t.title, t.status, t.priority, t.is_urgent, u.display_name as assignee,
              p.name as project, tm.name as category, t.due_date
       FROM tasks t
       LEFT JOIN users u ON t.assignee_id = u.id
       LEFT JOIN projects p ON t.project_id = p.id
       LEFT JOIN teams tm ON t.team_id = tm.id
       WHERE t.status != 'done'`
    );
    const lines = allPending.map(
      (t) => `${t.title} | ${t.status} | ${t.priority || '-'} | ${t.assignee || '-'} | ${t.project || '-'} | ${t.category || '-'} | ${t.due_date || '-'}`
    );
    const summary = `สรุปงานทั้งหมดสำหรับกรอก sheet ค่ะ (ชื่องาน | สถานะ | ความสำคัญ | ผู้รับผิดชอบ | โปรเจกต์ | หมวดหมู่ | กำหนดเสร็จ):\n\n${lines.join('\n')}`;
    await client.pushMessage(process.env.BABE_USER_ID, { type: 'text', text: summary });

    if (reportUrl) {
      await client.pushMessage(process.env.BABE_USER_ID, {
        type: 'text',
        text: `รายงานภาพรวมวันนี้ (.txt) ค่ะ 📄\n${reportUrl}`,
      });
    }
  }
}, { timezone: 'Asia/Bangkok' });

module.exports = {};
