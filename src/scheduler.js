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
    // EMERGENCY KILL SWITCH (2026-08-29) — stronger than DEV_MODE: DEV_MODE
    // still sends (just redirects target), which was still cluttering
    // Babe's personal chat with confusing/wrong content. Set
    // PAUSE_BROADCASTS=true in env to make every single cron job a
    // total no-op — nothing sends anywhere, to anyone, until turned off.
    if (process.env.PAUSE_BROADCASTS === 'true') {
      console.log(`[withAlert] PAUSE_BROADCASTS is on — skipping: ${kind}`);
      return;
    }
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

// Extra safety net (2026-08-30) — on top of claimBroadcastSlot (per
// broadcast TYPE) and retry keys (per HTTP request), this blocks by
// actual CONTENT: same exact text to the same target within a 10-min
// window is refused outright, regardless of which code path produced
// it or why. Doesn't require knowing the root cause of a duplicate —
// if the exact same message is about to go out twice in quick
// succession, something is wrong, full stop.
function claimContentSlot(target, text) {
  const hash = require('crypto').createHash('sha256').update(`${target}|${text}`).digest('hex').slice(0, 16);
  const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
  try {
    db.run(`INSERT INTO broadcast_log (id, broadcast_type, sent_key) VALUES (?, ?, ?)`, [require('crypto').randomUUID(), `content:${hash}`, String(bucket)]);
    return true;
  } catch (err) {
    console.log('[claimContentSlot] duplicate content blocked (same message, same target, within 10 min)');
    return false;
  }
}

function push(groupId, text) {
  if (dryRunMode) { lastDryRunMessage = { type: 'text', text }; return Promise.resolve({ dryRun: true }); }
  const target = gs.resolveBroadcastTarget(groupId);
  if (!claimContentSlot(target, text)) return Promise.resolve({ blocked: true });
  const retryKey = require('crypto').randomUUID();
  db.run(`INSERT INTO push_call_log (id, target, retry_key, text_snippet) VALUES (?, ?, ?, ?)`, [require('crypto').randomUUID(), target, retryKey, text.slice(0, 60)]);
  client.setRequestOptionOnce({ retryKey });
  return client.pushMessage(target, { type: 'text', text });
}

// Dry-run mode: lets test commands compose the exact message that would
// be sent WITHOUT actually pushing it to LINE — every real push counts
// against the account's monthly free-message quota, and burned through
// it fast during heavy same-day testing (confirmed live 2026-08-03: hit
// the 300/month cap from testing alone). When enabled, push/pushMessage
// capture the message instead of sending and make it available via
// getLastDryRunMessage() for a debug endpoint to return.
let dryRunMode = false;
let lastDryRunMessage = null;
function setDryRun(on) { dryRunMode = on; lastDryRunMessage = null; }
function getLastDryRunMessage() { return lastDryRunMessage; }

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
      // Dev mode redirects everything to Babe's personal 1:1 chat (see
      // groupState.js) — a real @mention only works when the target is
      // a group the mentioned person is actually in, so keep it as
      // plain readable name text instead of a broken/rejected mention.
      if (!REAL_LINE_ID.test(user.id) || gs.isDevMode()) {
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
  if (dryRunMode) { lastDryRunMessage = message; return Promise.resolve({ dryRun: true }); }
  const target = gs.resolveBroadcastTarget(groupId);
  const contentKey = JSON.stringify(message);
  if (!claimContentSlot(target, contentKey)) return Promise.resolve({ blocked: true });
  const retryKey = require('crypto').randomUUID();
  db.run(`INSERT INTO push_call_log (id, target, retry_key, text_snippet) VALUES (?, ?, ?, ?)`, [require('crypto').randomUUID(), target, retryKey, contentKey.slice(0, 60)]);
  client.setRequestOptionOnce({ retryKey });
  return client.pushMessage(target, message);
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
function urgencyRank(dateStr, todayIso) {
  if (!dateStr) return 3;
  const d = String(dateStr).slice(0, 10);
  if (d < todayIso) return 0; // overdue
  if (d === todayIso) return 1; // today
  return 2; // later
}

// Relative Thai label for a date, matching the format agreed on
// (เลยกำหนด / วันนี้ / พรุ่งนี้ / <short weekday>) — never a
// raw ISO date, per spec.
function dueLabel(dateStr, todayIso) {
  if (!dateStr) return null;
  const d = String(dateStr).slice(0, 10);
  if (d < todayIso) return 'เลยกำหนด';
  if (d === todayIso) return 'วันนี้';
  const tomorrow = new Date(todayIso + 'T00:00:00+07:00');
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(tomorrow);
  if (d === tomorrowIso) return 'พรุ่งนี้';
  const dateObj = new Date(d + 'T00:00:00+07:00');
  const weekday = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', weekday: 'short' }).format(dateObj);
  return weekday;
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

// Dedup guard for once-a-day broadcasts (2026-08-26 incident — see
// broadcast_log table comment in db.js for the full story). Whichever
// process's INSERT lands first "wins" the right to send; every other
// process (if more than one happens to be alive at once) gets a UNIQUE
// constraint failure and skips — a hard guarantee independent of ever
// figuring out WHY multiple processes were running. `force` (used by
// manual/debug-triggered previews) bypasses the guard entirely, since
// that's an explicit human "send it again right now" request.
function claimBroadcastSlot(type, force) {
  if (force) return true;
  const key = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  try {
    db.run(`INSERT INTO broadcast_log (id, broadcast_type, sent_key) VALUES (?, ?, ?)`, [require('crypto').randomUUID(), type, key]);
    return true;
  } catch (err) {
    console.log(`[claimBroadcastSlot] ${type} already sent today — skipping duplicate (another process/run got there first)`);
    return false;
  }
}

// ---- Morning: what to do today, grouped by person, sorted by urgency ----
// intro/outro let a one-off special announcement wrap the normal content
// (e.g. "Migael has some new features today...") without needing a
// separate message template — used for the 2026-08-02 rollout announcement.
async function sendMorningBriefing({ force = false, intro = null, outro = null } = {}) {
  if (!claimBroadcastSlot('morning_briefing', force)) return;
  const groupId = gs.getPrimaryGroupId();
  if (!groupId) return;

  // SIMPLIFIED (2026-08-30, per Babe's explicit request after repeated
  // wrong-data + duplicate-send incidents) — no more computed per-
  // person/category task breakdown pulled from our own DB, which can
  // drift out of sync with reality. Just point straight at the actual
  // Google Sheet, the real source of truth, every time. The detailed
  // logic below is left in place (not deleted) in case this gets
  // revisited later — just bypassed for now via this early return.
  {
    const link = checklistSheetLink();
    let text = `📋 วันนี้สิ่งที่ต้องทำ | ${formatThaiHeaderDate()}\nเช็ครายละเอียดงานวันนี้ได้ที่ชีทเลยค่ะ`;
    if (link) text += `\n${link}`;
    await push(groupId, text);
    return;
  }

  const todayIso = bangkokTodayIso();
  const roster = gs.getRoster(groupId);
  const uncommuEvents = await getTodayUncommuEvents();
  const tasks = db.all(
    `SELECT t.id, t.title, t.status, t.start_date, t.due_date, t.is_urgent, u.id as assignee_id, u.display_name as assignee, tm.name as category
     FROM tasks t
     LEFT JOIN users u ON t.assignee_id = u.id
     LEFT JOIN teams tm ON t.team_id = tm.id
     WHERE t.status NOT IN ('done', 'cancelled')
     ORDER BY t.start_date`
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

  // Group by CATEGORY (team) instead of by person — confirmed live
  // (2026-08-06) that grouping by person made someone with many tasks
  // (e.g. 7+) read as an unscannable wall of text nobody actually read,
  // whereas Babe's own personal 1:1 query to Migael (which naturally
  // organized the same data by category) was much easier to scan. Each
  // task line carries a real mention of its assignee inline instead of
  // plain "(name)" text, per the same request.
  const CATEGORY_ORDER = ['PRODUCTION', 'CT ONLINE', 'CT OFFLINE', 'DECORATION', 'เอกสาร', 'MEETING', 'ติดต่อ / ติดตาม'];
  const byCategory = new Map(); // category name -> {rank, items:[{line, mentionUser}]}
  const unassigned = [];
  for (const t of tasks) {
    const rank = urgencyRank(t.start_date, todayIso);
    const label = dueLabel(t.start_date, todayIso);
    const line = t.title + (label ? ` (${label})` : '') + (t.is_urgent ? ' 🔴' : '');
    const mentionUser = t.assignee ? { id: t.assignee_id, display_name: t.assignee } : null;
    const cat = t.category || null;
    if (cat) {
      if (!byCategory.has(cat)) byCategory.set(cat, { rank: 4, items: [] });
      const entry = byCategory.get(cat);
      entry.items.push({ line, mentionUser });
      entry.rank = Math.min(entry.rank, rank);
    } else {
      unassigned.push({ line, mentionUser });
    }
  }
  const sortedCategories = [...byCategory.entries()].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a[0]);
    const bi = CATEGORY_ORDER.indexOf(b[0]);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a[1].rank - b[1].rank;
  });

  const mb = createMentionBuilder();
  if (intro) mb.add(`${intro}\n\n`);
  mb.add(`📋 วันนี้สิ่งที่ต้องทำ | ${formatThaiHeaderDate()}\n`);
  if (uncommuEvents.length) {
    mb.add(`\nวันนี้เป็นงาน: ${uncommuEvents.join(', ')}\n`);
  }
  for (const [cat, { items }] of sortedCategories) {
    mb.add(`\n${cat}\n`);
    for (const { line, mentionUser } of items) {
      mb.add(`- ${line}`);
      if (mentionUser) mb.add(' ').addMention(mentionUser);
      mb.add('\n');
    }
  }
  if (unassigned.length) {
    mb.add(`\nยังไม่ระบุหมวดหมู่\n`);
    for (const { line, mentionUser } of unassigned) {
      mb.add(`- ${line}`);
      if (mentionUser) mb.add(' ').addMention(mentionUser);
      mb.add('\n');
    }
  }
  // Anyone on the roster with literally zero active tasks anywhere still
  // gets asked, combined into one line rather than repeated per person.
  const busyNames = new Set(tasks.filter((t) => t.assignee).map((t) => t.assignee));
  const noTaskNames = roster.filter((r) => !busyNames.has(r.name)).map((r) => r.name);
  if (noTaskNames.length) {
    mb.add(`\n${noTaskNames.join(', ')} — วันนี้มีอะไรต้องทำมั้ย?\n`);
  }
  // Always say something about meetings, even "none today" — leaving
  // this section out entirely when events.length===0 (old behavior) read
  // as "did Migael even check?" rather than "confirmed, nothing today".
  if (events.length) {
    mb.add(`\nวันนี้มีมีตติ้ง 👇\n`);
    for (const e of events) {
      mb.add(`\n${e.title}\n${formatMeetingDateTime(e.start_time)}\n${e.meeting_link ? '🔗 ' + e.meeting_link : ''}\n`);
    }
  } else {
    mb.add(`\nวันนี้ไม่มีมีตติ้งนะคะ`);
  }
  if (!sortedCategories.length && !unassigned.length && !events.length) {
    mb.add(`\n(ยังไม่มีงานหรือคนในระบบเลยนะคะ)`);
  }
  if (outro) mb.add(`\n\n${outro}`);

  await pushMessage(groupId, mb.build());
}
cron.schedule('0 10 * * *', withAlert('morning briefing', sendMorningBriefing), { timezone: 'Asia/Bangkok' });

// ---- Check-in (15:00): ask specifically about each person's tasks that
// are due today or already overdue — merged midday+afternoon slot per
// spec (was two separate broadcasts; team asked for one at 15:00). ----
async function sendAfternoonCheckin({ force = false } = {}) {
  if (!claimBroadcastSlot('afternoon_checkin', force)) return;
  const groupId = gs.getPrimaryGroupId();
  if (!groupId) return;

  // SIMPLIFIED (2026-08-30) — see sendMorningBriefing's comment above.
  {
    const link = checklistSheetLink();
    let text = `🔄 เช็คความคืบหน้า | ${formatThaiHeaderDate()} 15:00\nอัปเดตสถานะงานได้ที่ชีทเลยค่ะ`;
    if (link) text += `\n${link}`;
    await push(groupId, text);
    return;
  }

  const relevant = db.all(
    `SELECT t.title, u.id as assignee_id, u.display_name as assignee FROM tasks t
     LEFT JOIN users u ON t.assignee_id = u.id
     WHERE t.status NOT IN ('done', 'cancelled') AND date(t.start_date) <= date('now', '+7 hours')
     ORDER BY t.start_date`
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

  // Events starting in ~30 or ~10 minutes that haven't been reminded yet.
  // Batched into ONE message per window instead of one push per event —
  // confirmed live (2026-08-03) that two events in the same window sent
  // as two separate messages read as spammy and wastes the LINE OA's
  // monthly free-message quota for no real benefit.
  for (const window of [30, 10]) {
    const events = db.all(
      `SELECT * FROM events
       WHERE datetime(start_time) BETWEEN datetime('now', '+${window - 2} minutes')
                                       AND datetime('now', '+${window + 2} minutes')
         AND (skip_team_reminder IS NULL OR skip_team_reminder = 0)`
    );

    const toRemind = events.filter((e) => !db.get(
      `SELECT id FROM reminders WHERE ref_type='event' AND ref_id=? AND reminder_type=?`,
      [e.id, `pre_${window}min`]
    ));
    if (!toRemind.length) continue;

    // Same atomic-claim-before-send fix as checkOverdueTasks below.
    for (const e of toRemind) {
      db.run(
        `INSERT INTO reminders (id, ref_type, ref_id, reminder_type, scheduled_at, sent_at, group_id)
         VALUES (?, 'event', ?, ?, datetime('now'), datetime('now'), ?)`,
        [require('crypto').randomUUID(), e.id, `pre_${window}min`, groupId]
      );
    }

    const mb = createMentionBuilder();
    mb.add(`⏰ เตือนค่ะ อีก ${window} นาที ถึงเวลาแล้ว:\n`);
    const allAttendees = new Map();
    for (const e of toRemind) {
      const label = e.meeting_link ? 'มีมีตติ้ง —' : '';
      mb.add(`\n${label} "${e.title}"`.trim() + '\n');
      if (e.meeting_link) mb.add(`🔗 ${e.meeting_link}\n`);
      const attendees = db.all(
        `SELECT u.id, u.display_name FROM event_attendees ea JOIN users u ON ea.user_id = u.id WHERE ea.event_id = ?`,
        [e.id]
      );
      for (const a of attendees) allAttendees.set(a.id, a);
    }
    if (allAttendees.size) {
      mb.add('\n');
      for (const a of allAttendees.values()) mb.addMention(a).add(' ');
    }
    await pushMessage(groupId, mb.build());
  }
}

async function checkOverdueTasks() {
  // DISABLED (2026-08-30, per Babe's explicit request) — this computed
  // "overdue" status from our own DB's task records, which drifted out
  // of sync with the real Google Sheet more than once (confirmed real
  // incident: nagged about a task the team had already marked done in
  // the sheet). Team-facing task status now comes from the Sheet only
  // (see sendMorningBriefing/sendAfternoonCheckin's simplified sheet-
  // link messages) — logic below left in place but unreachable.
  return;

  const groupId = gs.getPrimaryGroupId();
  if (!groupId) return;

  // Quiet hours: overdue-task nagging is never time-sensitive to a
  // specific moment (unlike a meeting reminder, which must fire at the
  // actual meeting time) — it can always wait until a reasonable hour.
  // Confirmed live (2026-08-03 → 04): this fired at 02:05 Bangkok, which
  // is clearly not an acceptable time to be pinging the team.
  const hourBangkok = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', hour12: false }).format(new Date()));
  if (hourBangkok < 9 || hourBangkok >= 22) return;

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

  // FIX (real incident confirmed live 2026-08-28 via push_call_log —
  // two genuinely separate sends 5 minutes apart, different retry keys):
  // this used to send FIRST, then record "reminded" afterward. Any gap
  // between those two steps — even just bad luck — leaves a window
  // where the next 5-minute tick still sees "never reminded" and fires
  // again for real. Claim the reminder BEFORE sending instead, same
  // atomic-insert-wins pattern as claimBroadcastSlot: worst case (send
  // fails after claiming) we skip one legitimate nudge, which is far
  // safer than the team getting spammed with duplicates again.
  for (const t of dueForReminder) {
    db.run(
      `INSERT INTO reminders (id, ref_type, ref_id, reminder_type, scheduled_at, sent_at, group_id)
       VALUES (?, 'task', ?, 'overdue', datetime('now'), datetime('now'), ?)`,
      [require('crypto').randomUUID(), t.id, groupId]
    );
  }

  const mb = createMentionBuilder();
  mb.add(`🔴 แจ้งเตือนค่ะ งานที่เลยกำหนดเสร็จแล้ว (${dueForReminder.length} รายการ) ขออัปเดตสถานะด้วยค่ะ\n`);
  for (const t of dueForReminder) {
    mb.add(`- ${t.title}`);
    if (t.assignee_id2) mb.add(' ').addMention({ id: t.assignee_id2, display_name: t.assignee_name });
    mb.add('\n');
  }
  await pushMessage(groupId, mb.build());
}

// ---- Approaching-deadline reminder: per Babe's explicit request
// (2026-08-21) once "วันที่เริ่มต้น" became the date that drives daily
// summaries, "กำหนดเสร็จ" (due date) needed its own separate purpose —
// a heads-up a couple days BEFORE the real deadline hits, distinct from
// checkOverdueTasks above (which only fires once the deadline has
// already passed). Same quiet-hours/batching/reminder-dedup pattern. ----
async function checkApproachingDeadlines() {
  const groupId = gs.getPrimaryGroupId();
  if (!groupId) return;
  // DISABLED (2026-08-30) — same reason as checkOverdueTasks above.
  return;

  const hourBangkok = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', hour12: false }).format(new Date()));
  if (hourBangkok < 9 || hourBangkok >= 22) return;

  const approaching = db.all(
    `SELECT t.*, u.id as assignee_id2, u.display_name as assignee_name FROM tasks t
     LEFT JOIN users u ON t.assignee_id = u.id
     WHERE t.status NOT IN ('done', 'cancelled')
       AND t.due_date IS NOT NULL
       AND date(t.due_date) BETWEEN date('now', '+7 hours') AND date('now', '+7 hours', '+2 days')`
  );

  const dueForReminder = [];
  for (const t of approaching) {
    // One reminder per task for this whole approaching-window — no
    // repeat-interval needed like overdue nagging has, since this is a
    // one-time heads-up, not an ongoing nag.
    const already = db.get(
      `SELECT id FROM reminders WHERE ref_type='task' AND ref_id=? AND reminder_type='deadline_approaching'`,
      [t.id]
    );
    if (already) continue;
    dueForReminder.push(t);
  }

  if (!dueForReminder.length) return;

  // Same atomic-claim-before-send fix as checkOverdueTasks above.
  for (const t of dueForReminder) {
    db.run(
      `INSERT INTO reminders (id, ref_type, ref_id, reminder_type, scheduled_at, sent_at, group_id)
       VALUES (?, 'task', ?, 'deadline_approaching', datetime('now'), datetime('now'), ?)`,
      [require('crypto').randomUUID(), t.id, groupId]
    );
  }

  const mb = createMentionBuilder();
  mb.add(`⏳ แจ้งเตือนค่ะ งานที่ใกล้ถึงกำหนดส่งแล้ว (${dueForReminder.length} รายการ)\n`);
  for (const t of dueForReminder) {
    const label = dueLabel(t.due_date, bangkokTodayIso());
    mb.add(`- ${t.title}${label ? ` (กำหนดส่ง ${label})` : ''}`);
    if (t.assignee_id2) mb.add(' ').addMention({ id: t.assignee_id2, display_name: t.assignee_name });
    mb.add('\n');
  }
  await pushMessage(groupId, mb.build());
}
cron.schedule('0 11 * * *', withAlert('approaching deadline check', checkApproachingDeadlines), { timezone: 'Asia/Bangkok' });

// ---- Stale topic nudge: once a day, ping topics nobody's touched in a
// while, tagging whoever was involved — this is what keeps ideas/specs
// from silently dying in chat once the conversation moves on. ----
cron.schedule('30 10 * * *', withAlert('stale topic nudge', async () => {
  if (!claimBroadcastSlot('stale_topic_nudge', false)) return;
  const groupId = gs.getPrimaryGroupId();
  if (!groupId) return;
  // DISABLED (2026-08-30) — same reason as checkOverdueTasks above.
  return;

  const staleTopics = db.all(
    `SELECT * FROM topics WHERE status = 'open' AND datetime(updated_at) < datetime('now', '-3 days')`
  );
  for (const t of staleTopics) {
    const participants = db.all(
      `SELECT u.id, u.display_name FROM topic_participants tp JOIN users u ON tp.user_id = u.id WHERE tp.topic_id = ?`,
      [t.id]
    );
    const baseText = `📌 เรื่อง "${t.title}" เงียบไปหลายวันแล้วนะคะ มีอัปเดตอะไรไหมคะ\n${t.summary}${t.reference_link ? '\n🔗 ' + t.reference_link : ''}`;
    const sendResult = await pushWithMentions(groupId, baseText, participants);

    // Link this SPECIFIC sent message to the topic via LINE's real
    // reply/quote mechanism (2026-08-13 fix, v2) — a session-based
    // "most recently active" link only ever worked for the LAST nudge
    // in a batch; if several topics get nudged in one run, replies to
    // the earlier ones had no way to resolve. Storing the exact sent
    // message id means a genuine LINE quote-reply to ANY of them
    // resolves correctly regardless of order or how many were sent.
    const sentId = sendResult?.sentMessages?.[0]?.id;
    if (sentId) {
      db.run(
        `INSERT OR REPLACE INTO quoted_message_links (line_message_id, ref_type, ref_id) VALUES (?, 'topic', ?)`,
        [sentId, t.id]
      );
    }
    // Also keep the session-based link as a fallback for a reply that
    // ISN'T a formal LINE quote (just typed underneath) — still only
    // reliable for the last-sent nudge, but better than nothing.
    const nudgeSessionId = gs.openSession(groupId, null);
    gs.linkSession(nudgeSessionId, 'topic', t.id);
  }
}, { timezone: 'Asia/Bangkok' }));

// ---- Evening: recap + tomorrow prep ----
async function sendEveningRecap({ force = false } = {}) {
  if (!claimBroadcastSlot('evening_recap', force)) return;
  const groupId = gs.getPrimaryGroupId();
  if (!groupId) return;

  // SIMPLIFIED (2026-08-30) — see sendMorningBriefing's comment above.
  {
    const link = checklistSheetLink();
    let text = `🌙 สรุปวันนี้ | ${formatThaiHeaderDate()}\nดูสถานะงานล่าสุดได้ที่ชีทเลยค่ะ`;
    if (link) text += `\n${link}`;
    await push(groupId, text);
    return;
  }

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
       WHERE t.status NOT IN ('done', 'cancelled') AND date(t.start_date) <= date('now', '+7 hours')`
    );

    if (done.length || pending.length || force) {
      const mb = createMentionBuilder();
      mb.add(`🌙 สรุปวันนี้ | ${formatThaiHeaderDate()}\n`);
      if (!done.length && !pending.length) {
        mb.add('\n(ยังไม่มีข้อมูลงานในระบบวันนี้ค่ะ)');
      }

      // Group by person (matches the morning summary's format) instead
      // of a flat list with "(name)" tacked on the end of each line —
      // confirmed live (2026-08-03) that made it hard for someone to
      // scan for just their own items.
      function groupByAssignee(items) {
        const byPerson = new Map();
        const noName = [];
        for (const t of items) {
          if (!t.assignee) { noName.push(t.title); continue; }
          if (!byPerson.has(t.assignee)) byPerson.set(t.assignee, []);
          byPerson.get(t.assignee).push(t.title);
        }
        return { byPerson, noName };
      }

      if (done.length) {
        mb.add(`\n✅ เสร็จแล้ว\n`);
        const { byPerson, noName } = groupByAssignee(done);
        for (const [name, titles] of byPerson.entries()) {
          mb.add(`\n${name}\n`);
          for (const title of titles) mb.add(`- ${title}\n`);
        }
        if (noName.length) {
          mb.add(`\nยังไม่ระบุผู้รับผิดชอบ\n`);
          for (const title of noName) mb.add(`- ${title}\n`);
        }
      }

      if (pending.length) {
        mb.add(`\n⏳ ยังค้าง\n`);
        const { byPerson, noName } = groupByAssignee(pending);
        for (const [name, titles] of byPerson.entries()) {
          mb.add(`\n${name}\n`);
          for (const title of titles) mb.add(`- ${title}\n`);
        }
        if (noName.length) {
          mb.add(`\nยังไม่ระบุผู้รับผิดชอบ\n`);
          for (const title of noName) mb.add(`- ${title}\n`);
        }
      }

      // Tag everyone in the group in one line asking about tomorrow —
      // per spec this replaces the old static "พรุ่งนี้" list (which
      // just echoed due_date, not an actual prompt for new work) and
      // avoids repeating the same question once per person (that read
      // as spammy — see prior discussion).
      // Dedupe by display_name — a person can have two different LINE
      // account ids in the roster (see fixDuplicateAssignees.js's file
      // header) which would otherwise tag the same person twice here.
      const rosterRaw = gs.getRoster(groupId);
      const seenNames = new Set();
      const roster = rosterRaw.filter((r) => {
        if (seenNames.has(r.name)) return false;
        seenNames.add(r.name);
        return true;
      });
      if (roster.length) {
        mb.add('\n---\n');
        for (const r of roster) mb.addMention({ id: r.id, display_name: r.name }).add(' ');
        mb.add('พรุ่งนี้ใครมีงานอะไรเพิ่มมั้ยคะ บอกมาได้เลยนะคะ 🙏');
      }
      // Per Babe's explicit request (2026-08-21): remind the team every
      // evening to add their own checklist items directly in the sheet,
      // with the link right there so nobody has to go dig for it.
      if (process.env.UNFEST_CHECKLIST_SHEET_ID) {
        mb.add(`\n\nใครมีงานอะไรเพิ่ม อย่าลืมไปเพิ่ม checklist ในชีทด้วยนะคะ 📋\nhttps://docs.google.com/spreadsheets/d/${process.env.UNFEST_CHECKLIST_SHEET_ID}/edit`);
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
    if (dryRunMode) {
      lastDryRunMessage = { ...(lastDryRunMessage ? { groupMessage: lastDryRunMessage } : {}), personalReport: `สรุปวันนี้ค่ะ 📊\n${reportUrl}` };
    } else {
      await client.pushMessage(process.env.BABE_USER_ID, {
        type: 'text',
        text: `สรุปวันนี้ค่ะ 📊\n${reportUrl}`,
      });
    }
  }
}
cron.schedule('0 22 * * *', withAlert('evening recap', sendEveningRecap), { timezone: 'Asia/Bangkok' });

// ---- Secondary group (e.g. CR-Lab) light-touch pointers ----
// CR-Lab is the same 5-person team as the primary UNFEST'26 group, just
// a different LINE chat where they happen to talk more day-to-day. Per
// Babe's explicit request (2026-08-24): do NOT duplicate the full
// morning/checkin/evening broadcasts here — that would just be spammy
// noise for the same people twice. Instead, two short pointer messages
// a day that nudge the team toward the real checklist sheet. Both are
// no-ops if SECONDARY_GROUP_ID isn't set, so this is fully inert until
// Migael actually joins that group and the id is configured.
function checklistSheetLink() {
  return process.env.UNFEST_CHECKLIST_SHEET_ID
    ? `https://docs.google.com/spreadsheets/d/${process.env.UNFEST_CHECKLIST_SHEET_ID}/edit`
    : null;
}

async function sendSecondaryMidday({ force = false } = {}) {
  if (!claimBroadcastSlot('secondary_midday', force)) return;
  const groupId = process.env.SECONDARY_GROUP_ID;
  if (!groupId) return;

  const row = db.get(
    `SELECT COUNT(*) as n FROM tasks WHERE status NOT IN ('done', 'cancelled')`
  );
  const n = row ? row.n : 0;
  if (!n && !force) return;

  const link = checklistSheetLink();
  let text = `📋 วันนี้มีงานค้างในเช็คลิสต์ ${n} รายการ ดูรายละเอียดที่ชีทได้เลย หรือดูที่มิเกลเคยบอกไว้ในกลุ่ม UNFEST'26 / CR-Lab ก็ได้ค่ะ`;
  if (link) text += `\n📋 ${link}`;
  await push(groupId, text);
}
cron.schedule('0 15 * * *', withAlert('secondary midday pointer', sendSecondaryMidday), { timezone: 'Asia/Bangkok' });

async function sendSecondaryEveningPointer({ force = false } = {}) {
  if (!claimBroadcastSlot('secondary_evening_pointer', force)) return;
  const groupId = process.env.SECONDARY_GROUP_ID;
  if (!groupId) return;

  const link = checklistSheetLink();
  let text = `📋 ใครมีงาน/สิ่งที่ต้องทำเพิ่ม บอกมิเกลในนี้ได้เลยนะคะ หรือไปอัปเดตในชีทตรงๆ ก็ได้ค่ะ กันตกหล่นค่ะ 🙏`;
  if (link) text += `\n${link}`;
  await push(groupId, text);
}
cron.schedule('0 22 * * *', withAlert('secondary evening pointer', sendSecondaryEveningPointer), { timezone: 'Asia/Bangkok' });

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
  sendSecondaryMidday,
  sendSecondaryEveningPointer,
  checkMeetingReminders,
  checkOverdueTasks,
  setDryRun,
  getLastDryRunMessage,
  push, // exposed temporarily for direct real-send diagnostics (2026-08-27)
};
