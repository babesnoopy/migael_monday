// index.js — LINE webhook entrypoint
require('dotenv').config();
const fs = require('fs');
const express = require('express');
const line = require('@line/bot-sdk');
const db = require('./db');
const brain = require('./brain');
const gs = require('./groupState');
const calendarApi = require('./calendar');
const driveApi = require('./drive');
const recallApi = require('./recall');
const { randomUUID } = require('crypto');
require('./scheduler'); // starts cron jobs once db is ready (see scheduler.js)

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);

const UPLOADS_DIR = require('path').join(__dirname, '..', 'data', 'uploads');

const app = express();
app.use('/reports', express.static(require('path').join(__dirname, '..', 'data', 'reports')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Keep a short rolling window of recent messages per group in memory.
// This is just for "listening mode" context — the durable record lives
// in tasks/events once Migael has extracted something.
const RECENT_WINDOW = 15;
const recentByGroup = new Map(); // groupId -> [{userName, text, ts}]

// Remembers the last image someone sent in their personal chat with
// Migael, briefly — so a FOLLOW-UP text message like "ส่งรูปนี้เข้ากลุ่ม
// ให้หน่อย" can reference "this image" even though LINE sends the image
// and the instruction as two separate message events, not one.
const recentPersonalImage = new Map(); // userId -> {base64, mediaType, ts}
const RELAY_IMAGE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes


function pushRecent(groupId, entry) {
  const arr = recentByGroup.get(groupId) || [];
  arr.push(entry);
  if (arr.length > RECENT_WINDOW) arr.shift();
  recentByGroup.set(groupId, arr);
}

// Migael must answer status/schedule questions ("งานของฉันวันนี้มีอะไรบ้าง")
// from real data, not guesses. This pulls a lightweight snapshot of every
// current task + upcoming event.
//
// NOT filtered by group_id on purpose: this Migael instance only ever
// lives in one real LINE group (the UNFEST team group) — group_id
// scoping was leftover multi-tenant design that caused real bugs (tasks
// vanishing whenever a group got recreated/re-added, since a "new" LINE
// group has a different id even if it's meant to be the same team chat).
// The groupId param is kept only for callers that still need to know
// which chat triggered the lookup — it doesn't filter the data anymore.
// If this ever needs to support multiple real teams/groups in the
// future, reintroduce scoping deliberately then, with a stable concept
// of "team" that doesn't break every time a LINE group gets rebuilt.
function getGroupDataSnapshot(_groupId) {
  const tasks = db.all(
    `SELECT t.id, t.title, t.status, u.display_name as assignee, tm.name as team, t.start_date, t.due_date, t.is_urgent
     FROM tasks t
     LEFT JOIN users u ON t.assignee_id = u.id
     LEFT JOIN teams tm ON t.team_id = tm.id
     WHERE t.status NOT IN ('done', 'cancelled')
     ORDER BY t.due_date`
  );
  const events = db.all(
    `SELECT id, title, start_time, meeting_link FROM events
     WHERE datetime(start_time) >= datetime('now', '+7 hours', '-1 hour')
     ORDER BY (CASE WHEN strftime('%H:%M:%S', start_time) = '00:00:00' THEN 1 ELSE 0 END) ASC, start_time
     LIMIT 30`
  );
  const topics = db.all(
    `SELECT id, title, summary, reference_link, updated_at FROM topics
     WHERE status = 'open'
     ORDER BY updated_at DESC LIMIT 15`
  );
  return { tasks, events, topics };
}

// Unified onboarding message — used for (1) Migael's first join to a group,
// (2) memberJoined LINE events, and (3) a person's first message before
// they've introduced themselves. All three used to say different things;
// now they all explain who Migael is + what she can do, so nobody gets a
// worse greeting just because of which path triggered it.
function onboardingMessage(name) {
  const greetName = name ? ' ' + name : '';
  return `สวัสดีค่ะ${greetName} 👋 เรามิเกล ผู้ช่วยเบ้บนะคะ\nก่อนอื่นรบกวนทุกคนแนะนำตัวให้มิเกลรู้จักหน่อยค่ะ — ชื่ออะไร ทำหน้าที่อะไร รับผิดชอบเรื่องไหนบ้าง อยู่แผนกไหน\n\nส่วนมิเกลจะมาเป็นผู้ช่วยของเบ้บภาพรวมทั้งหมด และช่วยทีม manage นะคะ **เรียก "มิเกล" ทุกครั้งถ้าอยากให้ทำอะไร** พิมพ์ตามธรรมชาติได้เลย ไม่ต้องเป๊ะตามฟอร์ม เช่น มิเกลสร้าง google meet .... แจ้ง วัน เวลาให้เรียบร้อย หรือถ้าแค่ลงคิวก็แจ้งได้ค่ะ เช่น มิเกล ลงคิว set up วันที่ 31 งาน workshop หรือเวลาทุกคน brainstorm กัน มิเกลจะคอยอ่านแล้วจะเก็บเป็น data ไว้นะคะ ถ้าอยากเอากลับมาคุยต่อหรือจะใช้ไอเดียไหน พิมพ์แจ้งมิเกลได้เลยค่ะ ส่วนถ้ามีการ assign งานระหว่างวันก็ได้เช่นกันค่ะ นอกจากนี้ถ้าอยากให้มิเกลช่วยหาข้อมูล/ตอบคำถาม (research) อะไร ก็เรียก "มิเกล" นำหน้าเหมือนกันนะคะ\n\nและทุกวันก่อนเริ่มงาน (10:00) และหลังเลิกงาน (22:00) มิเกลจะพิมพ์สรุปงานและสิ่งที่ต้องทำในแต่ละวันนะคะ\n\nใครมีคำถามส่วนไหนเพิ่มเติมสามารถทักถามได้เลยค่ะ ยินดีที่ได้รู้จักทุกคนนะคะ`;
}

// Picks the LINE group personal-chat task delegation should relay into,
// when the person didn't name a group explicitly. Defaults to an env
// override (PERSONAL_RELAY_GROUP_ID) if set; otherwise falls back to the
// most recently created group Migael is in. Fine while there's a single
// active team group (e.g. the "test" group) — set the env var once the
// team has multiple groups so relaying doesn't guess wrong.
function getDefaultRelayGroupId() {
  return gs.getPrimaryGroupId();
}

async function handleEvent(event) {
  // Migael was just added to a (new or existing) group — greet right away,
  // don't wait for someone to type first. Works for any group she's added
  // to, not just the ones set up so far.
  if (event.type === 'join' && event.source.type === 'group') {
    const groupId = event.source.groupId;
    gs.upsertGroup(groupId, null);
    return reply(event.replyToken, onboardingMessage(null));
  }

  // Someone joins the group later (after Migael's already in it) — greet
  // them the same way as the initial onboarding, so nobody who joins after
  // day 1 gets missed. LINE only gives userIds here, so fetch names to
  // personalize the reply where possible.
  if (event.type === 'memberJoined' && event.source.type === 'group') {
    const groupId = event.source.groupId;
    gs.upsertGroup(groupId, null);

    const newMembers = event.joined?.members || [];
    const names = (await Promise.all(
      newMembers
        .filter((m) => m.type === 'user')
        .map((m) => client.getGroupMemberProfile(groupId, m.userId).then((p) => p.displayName).catch(() => null))
    )).filter(Boolean);
    const greetName = names.length ? names.join(', ') : null;

    return reply(event.replyToken, onboardingMessage(greetName));
  }

  if (event.type !== 'message') return;

  // Register the sender as a member (and their group) for message types
  // that get dropped below (stickers, etc.) before any processing
  // happens. Confirmed live (2026-08-23): พี่กบ's first message in the
  // new group was a sticker; since registration only ever happened for
  // text/image messages, he was never added and stayed invisible to
  // every roster/summary/mention lookup even though he had genuinely
  // messaged the group. A sticker carries no useful text to analyze,
  // but "this real person exists and is in this group" is true
  // regardless of what they sent. Scoped to non-text/image only, so it
  // never runs twice or interferes with the real isNew/onboarding check
  // that the text/image path already does further below.
  if (event.source.type === 'group' && event.source.userId && event.message.type !== 'text' && event.message.type !== 'image') {
    const profile = await client.getGroupMemberProfile(event.source.groupId, event.source.userId).catch(() => null);
    gs.upsertGroup(event.source.groupId, null);
    gs.upsertUser(event.source.userId, profile ? profile.displayName : 'ทีม', event.source.groupId);
  }

  if (event.message.type !== 'text' && event.message.type !== 'image') return;

  // Always download and analyze every image the moment it arrives — we
  // don't keep raw image bytes around, so an image only ever gets looked
  // at right now or never. This now happens BEFORE branching on personal
  // vs. group chat — images sent in Babe's personal chat need this too
  // (e.g. "ส่งรูปนี้เข้ากลุ่มให้หน่อย"), not just group chat images.
  let imageBase64 = null;
  let imageMediaType = null;
  let text;
  if (event.message.type === 'image') {
    try {
      const stream = await client.getMessageContent(event.message.id);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      imageBase64 = Buffer.concat(chunks).toString('base64');
      imageMediaType = 'image/jpeg';
    } catch (err) {
      console.error('[Image] Failed to download from LINE:', err.message);
      return;
    }
    text = '(ส่งรูปภาพมา ไม่มีข้อความบรรยาย)';
  } else {
    text = event.message.text;
  }

  if (event.source.type !== 'group') return handlePersonal(event, { text, imageBase64, imageMediaType });

  const groupId = event.source.groupId;
  const userId = event.source.userId;

  const profile = await client.getGroupMemberProfile(groupId, userId).catch(() => null);
  const userName = profile ? profile.displayName : 'ทีม';

  gs.upsertGroup(groupId, null);
  const { isNew } = gs.upsertUser(userId, userName, groupId);
  if (isNew && event.message.type === 'image') return; // nothing sensible to onboard from a bare photo

  pushRecent(groupId, { userName, text, ts: Date.now() });

  // Migael listens to and analyzes every message now — not just ones that
  // name her — so she can passively track task completions, topic updates,
  // etc. as the team talks normally. She only SPEAKS when addressed by
  // name, continuing an open thread, or (rarely) judges a casual exchange
  // is worth proactively joining. This trades more Anthropic API calls
  // (one per group message, not just ones naming her) for actually
  // "managing" the team instead of only reacting when summoned.
  //
  // For a brand-new person, always treat this first message as addressed
  // (force wasAddressed=true) so brain.interpret actually reads it — a
  // real bug in an earlier version short-circuited straight to the
  // onboarding prompt without looking at the message at all, so someone
  // whose very first message WAS a full self-introduction got asked to
  // introduce themselves again instead of being recognized.
  // Catch the Thai name plus common English spellings/typos of it —
  // someone typing "miguel"/"migael"/"migel" instead of "มิเกล" should
  // still count as calling her by name, not go silent.
  const mentionsMigael = text.includes('มิเกล') || /\bmi\s?g[ua]?e?l\b/i.test(text);
  const session = gs.getActiveSession(groupId);
  // A genuine LINE reply/quote to a specific message Migael sent takes
  // priority over the generic "most recently active session" — resolves
  // correctly even when several things (e.g. multiple stale-topic
  // nudges) were sent close together, which the session-only approach
  // could never disambiguate (see quoted_message_links in db.js).
  const quotedMessageId = event.message?.quotedMessageId;
  const quotedLink = quotedMessageId
    ? db.get(`SELECT ref_type, ref_id FROM quoted_message_links WHERE line_message_id = ?`, [quotedMessageId])
    : null;
  const effectiveSessionForThread = quotedLink
    ? { linked_ref_type: quotedLink.ref_type, linked_ref_id: quotedLink.ref_id }
    : session;
  // FIX (real complaint): having an open session used to make wasAddressed
  // true on its own, which told Claude "you were addressed, feel free to
  // reply" for EVERY follow-up message in a tracked thread — even casual
  // ambient additions nobody directed at her. That's what caused the
  // repeated identical "บันทึกไว้แล้วค่ะ..." replies. Session presence no
  // longer counts as being addressed by itself; participate=true (set by
  // Claude specifically when a message is genuinely answering a question
  // Migael just asked) is what re-enables a reply for real Q&A follow-ups,
  // while ambient continuations stay silent by default.
  const wasAddressed = mentionsMigael || isNew || !!quotedLink;

  // Deterministic admin command: list everyone Migael currently knows
  // about + their team, straight from the DB — a quick, honest way to
  // verify what actually got captured from onboarding (rather than
  // trusting a Claude-written summary that might gloss over gaps).
  if (mentionsMigael && /ลิงก์.*หัวข้อ|หัวข้อ.*ลิงก์|ดูหัวข้อทั้งหมด|รวมหัวข้อ/i.test(text)) {
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    return reply(event.replyToken, base
      ? `ดูหัวข้อที่บันทึกไว้ทั้งหมดได้ที่นี่เลยค่ะ 📌\n${base}/topics`
      : 'ยังไม่ได้ตั้งค่า PUBLIC_BASE_URL เลยส่งลิงก์ให้ไม่ได้ค่ะ');
  }

  if (mentionsMigael && /(ทีม|สมาชิก).*มีใครบ้าง|ทุกคนที่รู้จัก|เช็ค.*(ทีม|สมาชิก)/i.test(text)) {
    // Only people who've actually messaged in THIS (real) group — not
    // anyone left over from a test group during earlier development.
    const roster = db.all(
      `SELECT DISTINCT u.display_name, tm.name as team
       FROM users u
       JOIN group_members gm ON gm.user_id = u.id
       LEFT JOIN teams tm ON u.team_id = tm.id
       WHERE gm.group_id = ?
       ORDER BY tm.name, u.display_name`,
      [groupId]
    );
    if (!roster.length) {
      return reply(event.replyToken, 'ยังไม่มีใครแนะนำตัวในระบบเลยค่ะ');
    }
    const lines = roster.map((r) => `- ${r.display_name}${r.team ? ' (' + r.team + ')' : ' (ยังไม่ระบุแผนก)'}`);
    return reply(event.replyToken, `ตอนนี้มิเกลรู้จัก ${roster.length} คนค่ะ:\n${lines.join('\n')}`);
  }

  // Deterministic admin command: manually trigger a sheet sync right now,
  // instead of waiting for the 3-minute cron — useful right after someone
  // edits the sheet directly and wants Migael to pick it up immediately.
  if (mentionsMigael && /sync\s*(ชีท|sheet)|(ชีท|sheet)\s*sync|อัพเดท(จาก)?ชีท/i.test(text)) {
    await require('./sheetSync').run();
    return reply(event.replyToken, 'sync จากชีทให้แล้วค่ะ ✅ ลองถามงานอีกทีได้เลยนะคะ');
  }

  // Deterministic admin commands: fire any of the daily broadcasts right
  // now for testing, instead of waiting for the real scheduled time
  // (10:00 / 14:00 / 22:00). force:true so a test still sends something
  // to look at even on a day with no real tasks/events yet.
  if (mentionsMigael && /ทดสอบ.*สรุปเช้า|สรุปเช้า.*ทดสอบ/i.test(text)) {
    await require('./scheduler').sendMorningBriefing({ force: true });
    return reply(event.replyToken, 'ส่งสรุปเช้าไปที่กรุ๊ปแล้วค่ะ ✅');
  }
  if (mentionsMigael && /ทดสอบ.*สรุปเย็น|สรุปเย็น.*ทดสอบ/i.test(text)) {
    await require('./scheduler').sendEveningRecap({ force: true });
    return reply(event.replyToken, 'ส่งสรุปเย็นไปที่กรุ๊ป (และแชทส่วนตัวเบ้บ) แล้วค่ะ ✅');
  }
  if (mentionsMigael && /ทดสอบ.*(ระหว่างวัน|เช็คงาน)|(ระหว่างวัน|เช็คงาน).*ทดสอบ/i.test(text)) {
    await require('./scheduler').sendAfternoonCheckin({ force: true });
    await require('./scheduler').checkMeetingReminders();
    await require('./scheduler').checkOverdueTasks();
    return reply(event.replyToken, 'เช็คระหว่างวัน (ถามความคืบหน้า + เตือนมีตติ้ง/งานเลยกำหนด) ให้แล้วค่ะ ✅');
  }

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

  const snapshot = getGroupDataSnapshot(groupId);

  const decision = await brain.interpret({
    groupName: groupId,
    userName,
    messageText: text,
    recentMessages: recentByGroup.get(groupId) || [],
    teamRoster: roster,
    openThread: effectiveSessionForThread ? buildOpenThreadSummary(effectiveSessionForThread) : null,
    groupData: snapshot,
    wasAddressed,
    isQuoteReplyToMigael: !!quotedLink,
    imageBase64,
    imageMediaType,
  });
  // BUG FIX: the schema has two separate fields — reply_message and
  // clarifying_question — but every call site below only ever reads
  // reply_message. When needs_clarification=true, Claude (correctly,
  // per its instructions) puts the actual question into
  // clarifying_question, leaving reply_message empty — so the question
  // silently never got sent, even though she was clearly addressed by
  // name. Folding it in here once fixes every downstream usage.
  if (!decision.reply_message && decision.clarifying_question) {
    decision.reply_message = decision.clarifying_question;
  }

  // Only open/continue a listening-mode session when there's something
  // worth linking (task/event/topic capture) — not for every ambient
  // message, so casual chit-chat doesn't spam listening_sessions.
  const linkableIntents = ['create_task', 'create_event', 'correct_event', 'log_topic', 'add_detail_to_open_thread'];
  const sessionId = session
    ? session.id
    : linkableIntents.includes(decision.intent)
      ? gs.openSession(groupId, userId)
      : null;

  console.log(`[Decision] group=${groupId} text="${text}" intent=${decision.intent} needs_clarification=${decision.needs_clarification} participate=${decision.participate} is_meeting=${decision.extracted?.is_meeting} calendar_name=${decision.extracted?.calendar_name} stated_name=${decision.extracted?.stated_name} team_name=${decision.extracted?.team_name}`);
  const overrideReply = await applyDecision({ decision, groupId, userId, userName, sessionId, text });

  // If this is a brand-new person, only skip the onboarding prompt when
  // their message actually WAS a self-introduction (intent came back as
  // onboarding_reply) — anything else (a random question, "hi", etc.)
  // still gets the full onboarding prompt, same as before.
  let finalReply = overrideReply || decision.reply_message;
  if (isNew && decision.intent !== 'onboarding_reply') {
    finalReply = onboardingMessage(userName);
  }

  // Hard gate, enforced in code (not just prompt wording): when Migael
  // wasn't addressed by name and isn't in an open listening-mode thread,
  // she only speaks if the model explicitly set participate=true. This
  // stops her replying to things not directed at her (someone asking a
  // teammate where Babe is, casual chat, etc.) even if Claude drafted a
  // reply_message anyway — prompt-only compliance wasn't reliable enough.
  // A self-introduction is always an answer to a question Migael herself
  // asked (during onboarding) — treat it as addressed even if the person
  // never typed "มิเกล" and isn't flagged isNew (e.g. they already have a
  // row from an earlier attempt). Otherwise the reply silently gets
  // swallowed by the participate gate even though the info was captured.
  const isSelfIntro = decision.intent === 'onboarding_reply';
  if (!wasAddressed && !decision.participate && !isSelfIntro) {
    finalReply = null;
  }

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

async function applyDecision({ decision, groupId, userId, userName, sessionId, text }) {
  // Needed for the pending-action-item confirm check below — applyDecision
  // only ever received the session ID before, not the row itself.
  const session = sessionId ? db.get(`SELECT * FROM listening_sessions WHERE id = ?`, [sessionId]) : null;
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
  // Common nicknames that don't literally appear in someone's LINE
  // display name — e.g. Babe's LINE display name is "my babe" (English),
  // but the team refers to her in Thai as "เบ้บ", which would never
  // match via a plain LIKE search against "my babe". Without this, any
  // task assigned to/by "เบ้บ" would silently fail to link to her account.
  const NAME_ALIASES = {
    'เบ้บ': process.env.BABE_USER_ID,
    'babe': process.env.BABE_USER_ID,
  };

  function resolveAssigneeId(name) {
    if (!name) return null;
    const aliasId = NAME_ALIASES[name.trim().toLowerCase()] || NAME_ALIASES[name.trim()];
    if (aliasId) return aliasId;
    const user = db.get(`SELECT id FROM users WHERE display_name LIKE ?`, [`%${name}%`]);
    return user ? user.id : null;
  }

  // Code-level duplicate guard (2026-08-06) — a prompt-only "check the
  // active task list before creating" rule wasn't reliable enough on
  // its own: confirmed live that the exact same batch of tasks (same
  // titles, same assignees) got created 2-3 separate times over the
  // course of a morning, ~30-40 minutes apart, because the team kept
  // re-sending semantically identical instructions and Claude didn't
  // always catch that they matched something already created earlier
  // that same session. This is a deterministic backstop: same
  // normalized title + same assignee + still active (not done/
  // cancelled) = treat as the same task, don't insert a new row.
  function normalizeTaskTitle(t) {
    return (t || '').trim().toLowerCase().replace(/[\u0E48-\u0E4B]/g, '').replace(/\s+/g, ' ');
  }
  function findDuplicateActiveTask(title, assigneeId) {
    if (!title) return null;
    const key = normalizeTaskTitle(title);
    const candidates = db.all(
      `SELECT id, title FROM tasks WHERE assignee_id IS ? AND status NOT IN ('done', 'cancelled')`,
      [assigneeId]
    );
    return candidates.find((c) => normalizeTaskTitle(c.title) === key) || null;
  }


  // Resolves Claude's whole-sentence category classification (the 13
  // sheet categories — see brain.js's "category" field) to a real
  // team_id, creating the team row on first use. This is what makes
  // status_check/reports show the REAL category instead of falling back
  // to classify.js's cruder keyword guess — that guesser only exists for
  // rows where Claude didn't/couldn't classify (e.g. sheet-imported rows
  // with no chat context at all).
  function resolveTeamId(categoryName) {
    if (!categoryName) return null;
    let team = db.get(`SELECT id FROM teams WHERE name = ?`, [categoryName]);
    if (!team) {
      const teamId = randomUUID();
      db.run(`INSERT INTO teams (id, name) VALUES (?, ?)`, [teamId, categoryName]);
      team = { id: teamId };
    }
    return team.id;
  }

  // Shared by create_event (single) and create_multiple_tasks (batch) —
  // actually creates the Google Calendar event + events row. Extracted
  // so batched queue items (e.g. "ลงคิว X พรุ่งบ่ายโมง กับลงคิว Y บ่ายสาม"
  // in one message) get real calendar entries too, not just internal
  // task rows — that gap was the whole reason batched queue items never
  // showed up in Calendar even though a single one did.
  // The sheet's 13 task categories don't map 1:1 onto the 6 real Google
  // Calendars (only MEETING/PRODUCTION/SETUP-DEC/CONTENT/UNCOMMU/UNCRLAB
  // actually exist) — without this, categories like "CT ONLINE" or
  // "DECORATION" never matched any real calendar name and silently fell
  // back to the catch-all UNCRLAB every time, even though a more specific
  // calendar existed. Maps every sheet category to the calendar it
  // belongs under.
  const CATEGORY_TO_CALENDAR = {
    'SETUP': 'SETUP/DEC',
    'DECORATION': 'SETUP/DEC',
    'SYSTEM / EQUIPMENT': 'SETUP/DEC',
    'ACTIVITY': 'UNCOMMU',
    'CT ONLINE': 'CONTENT',
    'CT OFFLINE': 'CONTENT',
    'PRODUCTION': 'PRODUCTION',
    'MEETING': 'MEETING',
    // No dedicated calendar for these — land on the shared team calendar.
    'COLLABORATION': 'UNCRLAB',
    'SPONSOR': 'UNCRLAB',
    'เอกสาร': 'UNCRLAB',
    'SLIDE / DECK': 'UNCRLAB',
    'ติดต่อ / ติดตาม': 'UNCRLAB',
  };

  async function createCalendarEvent({ title, startTime, endTime, calendarName, isMeeting, isOnsite, attendeeEmails, attendeeNames, allDay }) {
    const mappedName = CATEGORY_TO_CALENDAR[calendarName] || calendarName;
    let calendarRow = null;
    if (mappedName) {
      calendarRow = db.get(`SELECT * FROM calendars WHERE name = ?`, [mappedName])
        || db.get(`SELECT * FROM calendars WHERE name LIKE ?`, [`%${mappedName}%`]);
    }
    if (!calendarRow) calendarRow = db.get(`SELECT * FROM calendars WHERE name LIKE '%UNCRLAB%'`);
    const calendarId = calendarRow ? calendarRow.id : 'primary';
    console.log(`[Calendar] "${title}" — calendar_name="${calendarName}" → resolved to "${calendarRow?.name || 'primary (fallback failed!)'}"`);

    const created = await calendarApi.createEvent({
      calendarId,
      title: title || '(untitled)',
      startTime,
      endTime: endTime || startTime,
      attendeeEmails: attendeeEmails || [],
      createMeetLink: !!isMeeting && !isOnsite, // onsite meetings get no video link — nobody uses it
      allDay: !!allDay,
    });

    const id = randomUUID();
    db.run(
      `INSERT INTO events (id, title, start_time, meeting_link, calendar_id, google_event_id, group_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, title || '(untitled)', startTime, created?.meetLink || null, calendarRow?.id || null, created?.id || null, groupId, userId]
    );
    linkAttendees(id, attendeeNames);

    // Send มิเกล's Recall.ai bot to sit in on real online meetings
    // automatically — no one has to remember to record/transcribe
    // manually. Onsite meetings have no Meet link (isOnsite skips
    // createMeetLink above) so this naturally only fires for real
    // video calls. Fire-and-forget: never let a Recall scheduling
    // hiccup block the actual Calendar event from being created.
    if (isMeeting && !isOnsite && created?.meetLink) {
      recallApi.scheduleBotForMeeting({ meetingUrl: created.meetLink, joinAt: startTime })
        .then((bot) => {
          if (bot?.id) db.run(`UPDATE events SET recall_bot_id = ?, recall_bot_status = ? WHERE id = ?`, [bot.id, bot.status, id]);
        })
        .catch((err) => console.error('[Recall] schedule failed for event', id, err.message));
    }

    return { id, meetLink: created?.meetLink || null };
  }

  // D-Phase 2: mirror a newly created task into the UNFEST'26_CHECKLIST
  // sheet too — best-effort, same non-blocking pattern as status_update's
  // sheet writes (Phase 1). Never let a sheet hiccup break task creation
  // in chat; the DB insert above is what actually matters to the team.
  // Left blank on purpose: "โครงการ" (project) — nothing in brain.js's
  // create_task schema currently identifies which real project (UNFEST'26
  // vs UNCOMMU etc.) a chat-created task belongs to, and guessing wrong
  // here writes a wrong value into a real team-facing sheet. Per spec,
  // leaving a genuinely unknown field blank is correct; don't invent one.
  async function writeNewTaskToSheet({ title, assignee, category, dueDate, status }) {
    try {
      const sheetWrite = require('./sheetWrite');
      await sheetWrite.appendNewTask({
        title,
        assignee: assignee || '',
        project: '',
        category: category || '',
        startDateIso: new Date().toISOString().slice(0, 10),
        dueDateIso: dueDate || null,
        status,
      });
    } catch (err) {
      console.error('[SheetWrite] appendNewTask failed:', err.message);
    }
  }

  if (decision.intent === 'create_task') {
    // Guard added to match create_event's existing pattern — without
    // this, the "ask before creating a vague-titled task" rule in
    // brain.js (see status_update/create_task clarification notes in
    // the system prompt) had no actual effect: needs_clarification=true
    // still resulted in a real DB row + sheet write with the vague
    // title, because nothing here ever checked the flag. The clarifying
    // question is already in decision.reply_message; don't create
    // anything until it's answered.
    if (decision.needs_clarification) return null;

    const assigneeIdForNewTask = resolveAssigneeId(ex.assignee);
    const dup = findDuplicateActiveTask(ex.title, assigneeIdForNewTask);
    if (dup) {
      return `งานนี้มีอยู่ในระบบแล้วนะคะ (${dup.title}) เลยไม่สร้างซ้ำให้ ถ้าอยากเปลี่ยนอะไรบอกได้เลยค่ะ`;
    }

    const id = randomUUID();
    // Supports being created already-closed (initial_status), for
    // messages that describe something already done/cancelled that was
    // never tracked as a task before (e.g. "note พรุ่งนี้ไม่มี X แล้วนะคะ")
    // — without this, that information had nowhere to go and just
    // vanished even though Migael's reply sounded like it was recorded.
    const initialStatus = ex.initial_status === 'done' ? 'done' : ex.initial_status === 'cancelled' ? 'cancelled' : 'to_do';
    db.run(
      `INSERT INTO tasks (id, title, assignee_id, created_by, due_date, group_id, status, team_id, is_urgent, start_date, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ex.title || '(untitled)', assigneeIdForNewTask, userId, ex.due_date || null, groupId, initialStatus, resolveTeamId(ex.category), ex.is_urgent ? 1 : 0, ex.due_date || null, initialStatus === 'done' ? new Date().toISOString() : null]
    );
    gs.linkSession(sessionId, 'task', id);
    await writeNewTaskToSheet({ title: ex.title || '(untitled)', assignee: ex.assignee, category: ex.category, dueDate: ex.due_date, status: initialStatus });

    // No specific time was given (start_time only gets set for real
    // events) — still put it on the calendar as an all-day entry on its
    // due date, so every task is visible in Calendar too, not just the
    // in-app task list.
    if (ex.due_date) {
      const { id: eventId } = await createCalendarEvent({
        title: ex.title,
        startTime: ex.due_date,
        calendarName: ex.category,
        allDay: true,
      });
      db.run(`UPDATE tasks SET calendar_event_id = ? WHERE id = ?`, [eventId, id]);
    }
  }

  if (decision.intent === 'create_multiple_tasks' && ex.items?.length) {
    // One message containing several tasks (e.g. an agenda dump) — capture
    // every item, don't just grab the first and drop the rest.
    // Same guard as create_task/create_event: if Claude needs
    // clarification on this whole batch (e.g. one item's title was too
    // vague), don't create ANY of them yet — the clarifying question is
    // already in decision.reply_message. Partial-batch creation would be
    // confusing (some items exist, some don't, with no clear signal why).
    if (decision.needs_clarification) return null;

    const created = [];
    for (const item of ex.items) {
      // Same fix as the single-item create_event path above: only a
      // REAL meeting (is_meeting=true) gets a Calendar event. A timed
      // "คิว"/reminder item (is_meeting=false, just has a start_time) is
      // a task with a due time — no Calendar entry, no 30/10-min-before
      // alarm, no risk of a duplicate/garbled meeting link going out.
      if (item.start_time && item.is_meeting === true) {
        await createCalendarEvent({
          title: item.title,
          startTime: item.start_time,
          endTime: item.end_time,
          calendarName: item.calendar_name,
          isMeeting: true,
          isOnsite: item.is_onsite === true,
          attendeeEmails: item.attendee_emails,
          attendeeNames: item.attendee_names,
        });
      } else {
        const itemAssigneeId = resolveAssigneeId(item.assignee_name);
        const dup = findDuplicateActiveTask(item.title, itemAssigneeId);
        if (dup) {
          created.push({ title: item.title, assignee: item.assignee_name, skippedDuplicate: true });
          continue;
        }
        const id = randomUUID();
        const dueDate = item.start_time || item.due_date || null;
        db.run(
          `INSERT INTO tasks (id, title, assignee_id, created_by, due_date, group_id, status, is_urgent, team_id, start_date)
           VALUES (?, ?, ?, ?, ?, ?, 'to_do', ?, ?, ?)`,
          [id, item.title || '(untitled)', itemAssigneeId, userId, dueDate, groupId, item.is_urgent ? 1 : 0, resolveTeamId(item.category), dueDate]
        );
        await writeNewTaskToSheet({ title: item.title || '(untitled)', assignee: item.assignee_name, category: item.category, dueDate });
        // Only sync to Calendar as an all-day entry when there's just a
        // due DATE and no specific time — a timed item (item.start_time)
        // is deliberately kept task-only per the fix above.
        if (item.due_date && !item.start_time) {
          const { id: eventId } = await createCalendarEvent({
            title: item.title,
            startTime: item.due_date,
            calendarName: item.category,
            allDay: true,
          });
          db.run(`UPDATE tasks SET calendar_event_id = ? WHERE id = ?`, [eventId, id]);
        }
      }
      created.push({ title: item.title, assignee: item.assignee_name });
    }
    const newOnes = created.filter((c) => !c.skippedDuplicate);
    const skipped = created.filter((c) => c.skippedDuplicate);
    const lines = newOnes.map((c) => `- ${c.title}${c.assignee ? ' (' + c.assignee + ')' : ''}`);
    let summary = newOnes.length
      ? `บันทึกให้แล้วค่ะ ${newOnes.length} รายการ 📋\n${lines.join('\n')}`
      : `ไม่มีรายการใหม่ที่ต้องบันทึกเพิ่มค่ะ (มีอยู่ในระบบแล้วทั้งหมด)`;
    if (skipped.length) {
      summary += `\n\n(ข้ามไป ${skipped.length} รายการที่มีอยู่แล้ว: ${skipped.map((s) => s.title).join(', ')})`;
    }
    return decision.reply_message || summary;
  }

  if (decision.intent === 'create_event') {
    // If Claude still needs clarification, don't create anything yet —
    // the clarifying question is already in decision.reply_message.
    if (decision.needs_clarification) return null;

    // Guard: events.start_time is NOT NULL in the schema. Without a time
    // there's nothing valid to create — ask instead of inserting NULL.
    if (!ex.start_time) {
      return decision.reply_message || 'นัดนี้ยังไม่มีเวลาเลยค่ะ ขอเวลาด้วยได้ไหมคะ';
    }

    const isMeeting = ex.is_meeting === true;
    const isOnsite = ex.is_onsite === true;

    // MAJOR FIX (2026-08-04, per Babe's explicit request): "คิว"/reminder
    // items (is_meeting=false — "เตือน X ตอน Y", "ลงคิวเตือนแพทเรื่อง Z")
    // no longer touch Google Calendar or the events table AT ALL. They
    // used to get a real Calendar entry too, which caused a cluster of
    // real problems: (1) they picked up the 30/10-min-before meeting
    // reminder treatment meant for real meetings, firing standalone
    // alarms at odd times instead of just showing up in the next
    // scheduled summary round like a normal task; (2) rescheduling them
    // routed through correct_event, which kept failing to find the
    // event; (3) they cluttered the calendar with entries that were
    // never real meetings, sometimes with duplicate/garbled meeting
    // links that risk going out to clients. A "คิว" item is just a task
    // with a due time — it only ever needs the task+sheet row already
    // written above. Real meetings (is_meeting=true) are unaffected —
    // those still get a full Calendar event with a Meet link.
    if (!isMeeting) {
      if (!ex.title) return decision.reply_message;
      const assigneeName = ex.attendee_names?.[0] || null;
      const queueAssigneeId = resolveAssigneeId(assigneeName);
      const dup = findDuplicateActiveTask(ex.title, queueAssigneeId);
      if (dup) {
        return `งานนี้มีอยู่ในระบบแล้วนะคะ (${dup.title}) เลยไม่สร้างซ้ำให้ค่ะ`;
      }
      const taskId = randomUUID();
      db.run(
        `INSERT INTO tasks (id, title, assignee_id, created_by, due_date, group_id, status, is_urgent, start_date)
         VALUES (?, ?, ?, ?, ?, ?, 'to_do', ?, ?)`,
        [taskId, ex.title, queueAssigneeId, userId, ex.start_time, groupId, ex.is_urgent ? 1 : 0, ex.start_time]
      );
      await writeNewTaskToSheet({ title: ex.title, assignee: assigneeName, category: ex.category, dueDate: ex.start_time });
      gs.linkSession(sessionId, 'task', taskId);
      return decision.reply_message;
    }

    const { meetLink, id } = await createCalendarEvent({
      title: ex.title,
      startTime: ex.start_time,
      endTime: ex.end_time,
      calendarName: ex.calendar_name,
      isMeeting,
      isOnsite,
      attendeeEmails: ex.attendee_emails,
      attendeeNames: ex.attendee_names,
    });
    gs.linkSession(sessionId, 'event', id);

    if (meetLink) {
      return `${decision.reply_message}\n🔗 ${meetLink}`;
    }
    return decision.reply_message;
  }

  if (decision.intent === 'correct_event' && ex.event_id) {
    const eventRow = db.get(`SELECT * FROM events WHERE id = ?`, [ex.event_id]);
    if (!eventRow) {
      return `หาข้อมูลนัดเดิมไม่เจอเลยค่ะ ขอโทษด้วย รบกวนพิมพ์รายละเอียดใหม่ทั้งหมดได้ไหมคะ`;
    }

    // Cancellation, not a reschedule — confirmed live gap (2026-08-08):
    // there was no way to cancel a meeting at all, only create/reschedule
    // one. "คุยไปแล้วค่ะ เมื่อวาน เอาออกได้เลยกับ adit" went completely
    // unactionable since the system had nothing to do with it. Deletes
    // the real Calendar event too, not just the local record — an
    // orphaned real Calendar invite left behind would be its own source
    // of confusion (people still seeing/joining a cancelled meeting).
    if (ex.cancel === true) {
      if (eventRow.google_event_id && eventRow.calendar_id) {
        await calendarApi.deleteEvent(eventRow.calendar_id, eventRow.google_event_id);
      }
      db.run(`DELETE FROM events WHERE id = ?`, [eventRow.id]);
      return decision.reply_message || `ยกเลิกนัด "${eventRow.title}" ให้แล้วค่ะ ✅`;
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

  if (decision.intent === 'onboarding_reply') {
    // Use the name they actually gave (not their LINE display name,
    // which could be an unrelated nickname/handle) so future assignee
    // matching and status checks work off the name the team really
    // calls them by.
    if (ex.stated_name) {
      db.run(`UPDATE users SET display_name = ? WHERE id = ?`, [ex.stated_name, userId]);
    }
    if (ex.team_name) {
      gs.setUserTeam(userId, ex.team_name, ex.project_id || null);
    }
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
    // If Claude decided this needs confirmation first (an ambient
    // mention that wasn't explicitly addressed to Migael, or genuine
    // uncertainty about whether it's actually a new topic), don't write
    // anything yet — the offer-to-save question is already in
    // reply_message/clarifying_question.
    if (decision.needs_clarification) return null;

    // Defensive check (don't just trust the prompt): if Claude sent a
    // topic_id (meaning "update this existing one") but ALSO gave a
    // topic_title that doesn't match that topic's real title, the two
    // fields contradict each other — this exact mismatch caused a real
    // bug where unrelated content got silently merged into an old
    // topic's summary while the reply text described it as a brand-new
    // save. Force it to create a new topic instead whenever that happens.
    let effectiveTopicId = ex.topic_id;
    if (effectiveTopicId) {
      const existing = db.get(`SELECT title FROM topics WHERE id = ?`, [effectiveTopicId]);
      if (existing && ex.topic_title && existing.title.trim() !== ex.topic_title.trim()) {
        console.log(`[Topic] Title mismatch — topic_id pointed to "${existing.title}" but topic_title was "${ex.topic_title}". Creating a new topic instead of merging.`);
        effectiveTopicId = null;
      }
    }

    if (effectiveTopicId) {
      // Updating an existing topic: rewrite the summary, don't append —
      // keeps it recap-able instead of turning into a growing log.
      db.run(
        // Category can drift as a topic accumulates real content over
        // the day (e.g. content that looked like UNLIVE at first turns
        // out to actually be UNCINEMA once more detail comes in) — allow
        // it to be corrected on update, not just locked in from creation.
        `UPDATE topics SET summary = ?, reference_link = COALESCE(?, reference_link), category = COALESCE(?, category), status = COALESCE(?, status), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [ex.topic_summary || '', ex.reference_link || null, ex.topic_category || null, ex.topic_status || null, effectiveTopicId]
      );
      linkTopicParticipants(effectiveTopicId, ex.participant_names);
    } else {
      const id = randomUUID();
      db.run(
        `INSERT INTO topics (id, group_id, title, summary, reference_link, created_by, category, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, groupId, ex.topic_title, ex.topic_summary || '', ex.reference_link || null, userId, ex.topic_category || 'UNFEST', ex.topic_status || 'open']
      );
      linkTopicParticipants(id, ex.participant_names);
      gs.linkSession(sessionId, 'topic', id);
    }

    // Meeting-note action items Claude spotted but must NOT auto-create
    // (per Babe's explicit design, 2026-08-21 — the earlier version
    // created "มั่วๆ" junk tasks straight from group chat with no
    // confirm step). Store as a pending proposal linked to this session
    // so a follow-up "ใช่"/confirm reply can create them for real.
    if (ex.proposed_tasks?.length) {
      const proposalId = randomUUID();
      db.run(
        `INSERT INTO pending_action_items (id, group_id, items, created_by) VALUES (?, ?, ?, ?)`,
        [proposalId, groupId, JSON.stringify(ex.proposed_tasks), userId]
      );
      gs.linkSession(sessionId, 'action_items', proposalId);
      const lines = ex.proposed_tasks.map((t, i) => `${i + 1}. ${t.assignee_name ? t.assignee_name + ' - ' : ''}${t.title}`);
      return `เจอ action item จากโน้ตนี้ ${ex.proposed_tasks.length} อันค่ะ อยากให้สร้างเป็นงานเลยมั้ยคะ:\n${lines.join('\n')}\n\nพิมพ์ "ใช่" เพื่อสร้างทั้งหมด หรือบอกว่าอยากตัดอันไหนออกก็ได้ค่ะ`;
    }

    // FIX (real bug confirmed live 2026-08-24/25): a topic-linked
    // listening session used to stay open indefinitely — only closing
    // once a later message got judged totally unrelated (intent=none).
    // That let a stale-but-still-"open" session quietly pull in
    // completely unrelated later messages (a repeated Dome Playback
    // link share, then separately a PR-team note) into an old,
    // unrelated meeting-summary topic just because its session
    // happened to still be open, even though the semantic "does this
    // really match" prompt rule said not to. Topics don't need
    // turn-by-turn session continuity the way tasks/events do — genuine
    // continuations are still caught either by a real LINE reply/quote
    // to Migael's own message (quotedLink, checked earlier and always
    // wins) or by matching an existing topic's meaning against the
    // full topicsBlock list Claude already sees every time. Closing
    // here removes the sticky "openThread" pull entirely once a topic
    // write is done, so the next unrelated message is evaluated fresh.
    if (sessionId) gs.closeSession(sessionId, 'topic_logged');

    return decision.reply_message || `บันทึกไว้แล้วค่ะ 📌 "${ex.topic_title}"`;
  }

  // Confirming (or adjusting) a pending action-item proposal — only
  // reachable when a listening session is linked to one (see log_topic's
  // proposed_tasks handling above). Deliberately simple/deterministic
  // (no LLM judgment call on "did they say yes") since silently
  // creating tasks is exactly the failure mode this whole feature exists
  // to prevent — an ambiguous reply here should NOT create anything.
  if (session?.linked_ref_type === 'action_items' && session.linked_ref_id) {
    const proposal = db.get(`SELECT * FROM pending_action_items WHERE id = ?`, [session.linked_ref_id]);
    if (proposal && /^(ใช่|yes|ok|โอเค|ตกลง|confirm|ยืนยัน)/i.test(text.trim())) {
      const items = JSON.parse(proposal.items);
      const created = [];
      const skipped = [];
      for (const item of items) {
        const assigneeId = resolveAssigneeId(item.assignee_name);
        const dup = findDuplicateActiveTask(item.title, assigneeId);
        if (dup) { skipped.push(item.title); continue; }
        const id = randomUUID();
        db.run(
          `INSERT INTO tasks (id, title, assignee_id, created_by, group_id, status, start_date) VALUES (?, ?, ?, ?, ?, 'to_do', datetime('now'))`,
          [id, item.title, assigneeId, userId, groupId]
        );
        await writeNewTaskToSheet({ title: item.title, assignee: item.assignee_name });
        created.push(item.title);
      }
      gs.closeSession(sessionId, 'confirmed');
      let msg = created.length ? `สร้างงานให้แล้วค่ะ ✅ ${created.length} รายการ:\n${created.map((t) => '- ' + t).join('\n')}` : 'ไม่มีรายการใหม่ที่ต้องสร้างเพิ่มค่ะ';
      if (skipped.length) msg += `\n\n(ข้ามไป ${skipped.length} รายการที่มีอยู่แล้ว)`;
      return msg;
    }
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

  // status_update: closes/cancels/reschedules a task the team already
  // has. Always writes the local DB first (source of truth for the
  // chat) — the sheet write below is best-effort: if it fails (network
  // blip, token expiry, sheet structure changed), the DB still reflects
  // reality and the person gets a normal confirmation. We don't want a
  // sheet API hiccup to make Migael claim a task didn't close when it
  // did. Errors are logged, not surfaced as a failure in the chat.
  if (decision.intent === 'status_update' && (ex.task_id || ex.task_ids?.length)) {
    const taskIds = ex.task_ids?.length ? ex.task_ids : [ex.task_id];
    const sheetWrite = require('./sheetWrite');
    const updated = [];

    for (const taskId of taskIds) {
      const taskRow = db.get(`SELECT * FROM tasks WHERE id = ?`, [taskId]);
      if (!taskRow) continue; // skip silently — bulk case shouldn't fail the whole batch over one stale id
      let sheetResult = null;

      if (ex.new_status === 'done') {
        db.run(`UPDATE tasks SET status = 'done', completed_at = CURRENT_TIMESTAMP WHERE id = ?`, [taskRow.id]);
        try { sheetResult = await sheetWrite.markDone(taskRow.title); }
        catch (err) { console.error('[SheetWrite] markDone failed:', err.message); }
      } else if (ex.new_status === 'cancelled') {
        db.run(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`, [taskRow.id]);
        try { sheetResult = await sheetWrite.markCancelled(taskRow.title); }
        catch (err) { console.error('[SheetWrite] markCancelled failed:', err.message); }
      } else if (ex.new_status === 'in_progress') {
        db.run(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`, [taskRow.id]);
      }

      if (ex.new_due_date) {
        db.run(`UPDATE tasks SET due_date = ? WHERE id = ?`, [ex.new_due_date, taskRow.id]);
        try { sheetResult = await sheetWrite.reschedule(taskRow.title, ex.new_due_date); }
        catch (err) { console.error('[SheetWrite] reschedule failed:', err.message); }
      }

      if (sheetResult && sheetResult.ok === false && sheetResult.reason === 'not_found_in_sheet') {
        console.log(`[SheetWrite] "${taskRow.title}" has no matching sheet row — DB updated, sheet unchanged.`);
      }
      updated.push(taskRow.title);
    }

    if (!updated.length) {
      return decision.reply_message || 'หางานนี้ในระบบไม่เจอเลยค่ะ ขอโทษด้วย';
    }
    if (updated.length === 1) {
      return decision.reply_message || `อัปเดตให้แล้วค่ะ ✅ ${updated[0]}`;
    }
    return decision.reply_message || `อัปเดตให้แล้วค่ะ ✅ ${updated.length} งาน:\n${updated.map((t) => '- ' + t).join('\n')}`;
  }

  return null;
}

async function handlePersonal(event, { text, imageBase64, imageMediaType }) {
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

  const relayGroupId = getDefaultRelayGroupId();

  // FIX (real bug confirmed live 2026-08-25): personal chat never had
  // any listening-mode session/continuity at all — openThread was
  // hardcoded to null. Every message was interpreted from scratch with
  // zero memory of what was just discussed. Confirmed this caused a
  // real meeting request to get created THREE separate times: Babe
  // asked to create a meeting, Migael asked who's attending, Babe
  // answered "มีแค่เบ้บ" — but with no session, that reply had nothing
  // to attach to and got misread as an unrelated question, so Babe
  // re-asked twice more, each treated as a brand-new create_event call.
  // Sessions are just keyed by an arbitrary string (not necessarily a
  // real LINE group id — see groupState.js), so "personal:<userId>" is
  // a safe, separate key per person's personal chat, distinct from any
  // real team group's session state.
  const personalSessionKey = `personal:${userId}`;
  const personalSession = gs.getActiveSession(personalSessionKey);
  const personalQuotedMessageId = event.message?.quotedMessageId;
  const personalQuotedLink = personalQuotedMessageId
    ? db.get(`SELECT ref_type, ref_id FROM quoted_message_links WHERE line_message_id = ?`, [personalQuotedMessageId])
    : null;
  const effectiveSessionForThread = personalQuotedLink
    ? { linked_ref_type: personalQuotedLink.ref_type, linked_ref_id: personalQuotedLink.ref_id }
    : personalSession;
  const quotedLink = personalQuotedLink;

  // Remember an image sent here so a follow-up text instruction (sent as
  // a separate LINE message) can still reference "this image".
  if (imageBase64) {
    recentPersonalImage.set(userId, { base64: imageBase64, mediaType: imageMediaType, ts: Date.now() });
  }

  // "ส่งรูปนี้เข้ากลุ่มให้หน่อย บอกว่า..." — relay an image (+ caption) to
  // the team group as a message from Migael herself, without going
  // through the task/event decision pipeline (this isn't a task, it's a
  // broadcast). Handled as its own deterministic path since forwarding
  // a real image needs a public URL, not something brain.interpret's
  // JSON decision format was built to carry.
  const relayImageMatch = /ส่ง.*(รูป|ภาพ).*เข้า.*กลุ่ม|ส่ง.*กลุ่ม.*(รูป|ภาพ)/i.test(text);
  if (relayImageMatch && relayGroupId) {
    const cached = recentPersonalImage.get(userId);
    const freshEnough = cached && (Date.now() - cached.ts) < RELAY_IMAGE_MAX_AGE_MS;
    if (!freshEnough) {
      return reply(event.replyToken, 'ไม่เห็นรูปที่ส่งมาเมื่อกี้เลยค่ะ รบกวนส่งรูปมาอีกครั้งได้ไหมคะ');
    }
    try {
      if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      const filename = `${randomUUID()}.jpg`;
      fs.writeFileSync(require('path').join(UPLOADS_DIR, filename), Buffer.from(cached.base64, 'base64'));
      const publicUrl = `${(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')}/uploads/${filename}`;

      await client.pushMessage(relayGroupId, { type: 'image', originalContentUrl: publicUrl, previewImageUrl: publicUrl });

      // Extract just the caption Babe wants said (strip the "ส่งรูปนี้เข้า
      // กลุ่ม" instruction part) — fall back to the whole message if we
      // can't cleanly separate it.
      const captionMatch = text.match(/(?:บอกว่า|แจ้งว่า)\s*(.+)/);
      const caption = captionMatch ? captionMatch[1].trim() : text;
      await client.pushMessage(relayGroupId, { type: 'text', text: caption });

      recentPersonalImage.delete(userId);
      return reply(event.replyToken, 'ส่งรูปเข้ากลุ่มพร้อมข้อความให้แล้วค่ะ ✅');
    } catch (err) {
      console.error('[handlePersonal] Failed to relay image:', err.message);
      return reply(event.replyToken, 'ขอโทษค่ะ ส่งรูปเข้ากลุ่มไม่สำเร็จ ลองอีกครั้งได้ไหมคะ');
    }
  }

  // A bare image with no relay instruction (yet) — just acknowledge it's
  // received and cached, don't do anything else with it.
  if (imageBase64) {
    return reply(event.replyToken, 'ได้รับรูปแล้วค่ะ ถ้าอยากให้ส่งเข้ากลุ่มทีม บอกมิเกลได้เลยนะคะ');
  }

  const decision = await brain.interpret({
    groupName: 'personal',
    userName: 'เบ้บ',
    messageText: text,
    recentMessages: [],
    teamRoster: relayGroupId ? gs.getRoster(relayGroupId) : [],
    openThread: effectiveSessionForThread ? buildOpenThreadSummary(effectiveSessionForThread) : null,
    groupData: relayGroupId ? getGroupDataSnapshot(relayGroupId) : {},
    wasAddressed: true,
    isQuoteReplyToMigael: !!quotedLink,
  });
  // Personal chat never had this logging at all — the group handler's
  // [Decision] line only fires on the group code path, so debugging any
  // "personal chat didn't respond" report meant flying blind. Confirmed
  // live (2026-08-21) investigating a pasted meeting-note message with
  // no visibility into what Claude actually decided.
  console.log(`[Decision:personal] text="${text.slice(0, 80)}" intent=${decision.intent} needs_clarification=${decision.needs_clarification} participate=${decision.participate} reply_len=${(decision.reply_message || '').length}`);
  if (!decision.reply_message && decision.clarifying_question) {
    decision.reply_message = decision.clarifying_question;
  }

  // Task/event creation from personal chat now actually persists (it used
  // to just have Claude describe a fake confirmation with nothing saved).
  // Reuse the same applyDecision path the group uses, targeting the team
  // group so the task is real and reminders/status checks pick it up too.
  // needs_clarification means nothing was actually created yet (e.g.
  // Claude needs more info) — decision.reply_message in that case is a
  // QUESTION for Babe, not a confirmation, so it must never be relayed
  // into the team group. Only relay once something real happened.
  // log_topic included so "เก็บบันทึกลิงก์นี้ไว้หน่อย" in personal chat
  // actually persists — it was missing from this list, so the DB write
  // (which lives in applyDecision's log_topic branch) never ran even
  // though Claude's reply confidently said it was saved.
  const isDelegatable = ['create_task', 'create_multiple_tasks', 'create_event', 'correct_event', 'log_topic', 'add_detail_to_open_thread'].includes(decision.intent);

  // CHANGED (real incident): this used to relay EVERYTHING delegatable
  // to the team group automatically, assuming personal chat was only
  // ever used to delegate team work. It's also used for things that are
  // purely personal to Babe (e.g. "เตือนเบ้บให้นอน") — those got posted
  // into the real, populated team group as if they were team tasks. Now
  // relaying only happens when Babe explicitly asks for it in the same
  // message (matches the same "ส่งเข้ากลุ่ม" pattern used for image
  // relay) — default is personal-only, never auto-broadcast.
  const explicitRelayRequested = /ส่งเข้ากลุ่ม|แจ้งทีม|บอกทีม|บอกในกลุ่ม|เข้ากลุ่มทีม/i.test(text);

  // Same session lifecycle as the group handler (see linkableIntents
  // there) — only opens/reuses a session when something worth tracking
  // across turns is happening, keyed to this person's own personal chat.
  const linkableIntents = ['create_task', 'create_event', 'correct_event', 'log_topic', 'add_detail_to_open_thread'];
  const sessionId = personalSession
    ? personalSession.id
    : linkableIntents.includes(decision.intent)
      ? gs.openSession(personalSessionKey, userId)
      : null;

  let groupOverrideReply = null;
  let relayed = false;
  if (isDelegatable && relayGroupId && !decision.needs_clarification) {
    // Always persist for real (this is the actual DB write) regardless
    // of whether Babe wants it relayed — a personal reminder still
    // needs to actually exist somewhere, not just get a fake-confirmed
    // reply. Only the GROUP PUSH below is conditional on explicit ask.
    groupOverrideReply = await applyDecision({
      decision,
      groupId: relayGroupId,
      userId,
      userName: 'เบ้บ',
      sessionId,
      text,
    });

    if (explicitRelayRequested) {
      // Tell the team group about the new task/event, as a message from
      // Migael herself (not "from Babe") — same as if she'd created it
      // from a message posted directly in the group.
      const teamMessage = groupOverrideReply || decision.reply_message;
      if (teamMessage) {
        relayed = true;
        await client.pushMessage(relayGroupId, { type: 'text', text: teamMessage }).catch((err) => {
          console.error('[handlePersonal] Failed to relay to team group:', err.message);
        });
      }
    }
  }

  if (sessionId && decision.intent === 'none') {
    gs.closeSession(sessionId, 'topic_changed');
  }

  const personalReply = decision.reply_message
    ? decision.reply_message + (relayed ? '\nส่งเข้ากลุ่มทีมให้แล้วนะคะ' : '')
    : groupOverrideReply;

  if (personalReply) {
    await reply(event.replyToken, personalReply);
  }
}

function reply(token, text) {
  const result = client.replyMessage(token, { type: 'text', text });
  // Track every message Migael sends as a reply, not just proactive
  // topic nudges — confirmed live (2026-08-21): a genuine LINE quote-
  // reply to Migael's own onboarding greeting ("เดี๋ยววันนี้สรุป role...")
  // went completely unanswered, because wasAddressed only recognized
  // literal "มิเกล" mentions or a link recorded specifically for topic
  // nudges — replying directly to something Migael said wasn't itself
  // enough to count as addressing her. Now ANY reply Migael sends gets
  // logged generically (ref_type='migael_message', no specific ref_id
  // needed), so a quote-reply to it is recognized as addressed even
  // without a task/topic/event attached.
  result.then((res) => {
    const sentId = res?.sentMessages?.[0]?.id;
    if (sentId) {
      try {
        db.run(`INSERT OR REPLACE INTO quoted_message_links (line_message_id, ref_type, ref_id) VALUES (?, 'migael_message', ?)`, [sentId, sentId]);
      } catch (err) { /* best-effort — never block the reply on this */ }
    }
  }).catch(() => {});
  return result;
}

// Lightweight read-only debug endpoint — lets us check what Migael
// actually has in the DB without needing to message her through LINE.
// Not linked from anywhere; fine to leave in.
// Public, read-only page listing everything Migael has logged as a
// "topic" (meeting recaps, shared links/specs, ongoing discussions) — the
// team asked for somewhere to see the full picture at a glance, similar
// to how a shared sheet would work, without needing write access to an
// actual Google Sheet (which risks breaking the checklist's formulas).
// Always rendered live from the DB, so it's never stale.
// Same idea as /topics — a browsable, live HTML view of the task list,
// since the raw .csv just renders as an unreadable wall of text when
// opened directly in a browser. The .csv still exists for actually
// importing into the sheet; this is for looking at it comfortably.
app.get('/report', (req, res) => {
  const guessDept = require('./classify').guessDepartment;
  const tasks = db.all(
    `SELECT t.title, t.status, t.start_date, t.due_date, t.is_urgent, t.note,
            u.display_name as assignee, tm.name as team, p.name as project
     FROM tasks t
     LEFT JOIN users u ON t.assignee_id = u.id
     LEFT JOIN teams tm ON t.team_id = tm.id
     LEFT JOIN projects p ON t.project_id = p.id
     ORDER BY t.status = 'done', t.due_date`
  );

  const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));

  const STATUS_LABEL = { done: 'เสร็จ', in_progress: 'กำลังทำ', review: 'ตรวจ', to_do: 'ต้องทำ' };
  const STATUS_COLOR = { done: '#4ade80', in_progress: '#facc15', review: '#a78bfa', to_do: '#94a3b8' };

  const rows = tasks.map((t) => {
    const status = t.status || 'to_do';
    const color = STATUS_COLOR[status] || '#999';
    const category = t.team || guessDept(t.title) || '';
    return `
    <tr data-status="${escapeHtml(status)}">
      <td class="status"><span class="pill" style="background:${color}22;color:${color};border:1px solid ${color}55">${escapeHtml(STATUS_LABEL[status] || status)}</span></td>
      <td class="title">${escapeHtml(t.title)}${t.is_urgent ? ' <span class="urgent">ด่วน</span>' : ''}</td>
      <td>${escapeHtml(t.project)}</td>
      <td>${escapeHtml(category)}</td>
      <td>${escapeHtml(t.assignee) || '-'}</td>
      <td class="date">${escapeHtml(t.start_date) || '-'}</td>
      <td class="date">${escapeHtml(t.due_date) || '-'}</td>
      <td>${!t.note ? '<span class="newflag">🆕 ใหม่</span>' : ''}</td>
    </tr>`;
  }).join('');

  const statusList = ['to_do', 'in_progress', 'review', 'done'];
  const filterPills = statusList.map((s) => {
    const n = tasks.filter((t) => (t.status || 'to_do') === s).length;
    return `<button class="filterpill" data-filter="${s}" style="border-color:${STATUS_COLOR[s]}55;color:${STATUS_COLOR[s]}">${STATUS_LABEL[s]} (${n})</button>`;
  }).join('');

  const csvUrl = req.query.csv || '';

  res.send(`<!DOCTYPE html>
<html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Migael — สรุปงาน</title>
<style>
  body { font-family: -apple-system, "Noto Sans Thai", sans-serif; background: #1a1a1a; color: #eee; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #999; font-size: 13px; margin-bottom: 16px; }
  .sub a { color: #7ab8ff; }
  .searchbar { width: 100%; box-sizing: border-box; padding: 10px 14px; margin-bottom: 16px; border-radius: 8px; border: 1px solid #3a3a3a; background: #232323; color: #eee; font-size: 14px; }
  .searchbar:focus { outline: none; border-color: #7ab8ff; }
  table { width: 100%; border-collapse: collapse; background: #232323; border-radius: 8px; overflow: hidden; }
  th { background: #2f2f2f; text-align: left; padding: 10px 12px; font-size: 13px; color: #bbb; position: sticky; top: 0; }
  td { padding: 10px 12px; font-size: 14px; border-top: 1px solid #333; vertical-align: top; }
  .title { font-weight: 600; }
  .urgent { color: #f87171; font-size: 11px; font-weight: 600; }
  .date { color: #888; font-size: 12px; white-space: nowrap; }
  .empty { padding: 40px; text-align: center; color: #888; }
  tr.hidden { display: none; }
  #count { color: #999; font-size: 12px; margin-bottom: 8px; }
  .pillbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .filterpill { padding: 6px 12px; border-radius: 999px; background: transparent; border: 1px solid #444; color: #ccc; font-size: 12px; cursor: pointer; }
  .filterpill.active { background: #333; font-weight: 600; }
  .pill { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .newflag { color: #4ade80; font-size: 11px; font-weight: 600; white-space: nowrap; }
</style></head>
<body>
  <h1>📊 สรุปงานทั้งหมด</h1>
  <div class="sub">อัปเดตสดจากฐานข้อมูลทุกครั้งที่เปิดหน้านี้ — ทั้งหมด ${tasks.length} รายการ${csvUrl ? ` · <a href="${escapeHtml(csvUrl)}">ดาวน์โหลด .csv</a>` : ''}</div>
  ${tasks.length ? `
  <input class="searchbar" id="search" type="text" placeholder="🔍 ค้นหาด้วย keyword — ชื่องาน, โปรเจกต์, ผู้รับผิดชอบ">
  <div class="pillbar"><button class="filterpill active" data-filter="ALL">ทั้งหมด (${tasks.length})</button>${filterPills}</div>
  <div id="count"></div>
  <table>
    <thead><tr><th>สถานะ</th><th>งาน</th><th>โปรเจกต์</th><th>หมวดหมู่</th><th>ผู้รับผิดชอบ</th><th>เริ่ม</th><th>กำหนดเสร็จ</th><th>ต้องเพิ่มในชีทหลักไหม</th></tr></thead>
    <tbody id="rows">${rows}</tbody>
  </table>
  <script>
    const input = document.getElementById('search');
    const trs = Array.from(document.querySelectorAll('#rows tr'));
    const countEl = document.getElementById('count');
    const pills = Array.from(document.querySelectorAll('.filterpill'));
    let activeStatus = 'ALL';
    function applyFilter() {
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      trs.forEach((tr) => {
        const matchesText = !q || tr.textContent.toLowerCase().includes(q);
        const matchesStatus = activeStatus === 'ALL' || tr.dataset.status === activeStatus;
        const match = matchesText && matchesStatus;
        tr.classList.toggle('hidden', !match);
        if (match) shown++;
      });
      countEl.textContent = (q || activeStatus !== 'ALL') ? \`เจอ \${shown} จาก \${trs.length} รายการ\` : '';
    }
    input.addEventListener('input', applyFilter);
    pills.forEach((pill) => {
      pill.addEventListener('click', () => {
        pills.forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        activeStatus = pill.dataset.filter;
        applyFilter();
      });
    });
  </script>
  ` : '<div class="empty">ยังไม่มีงานในระบบค่ะ</div>'}
</body></html>`);
});

app.get('/topics', (req, res) => {
  const topics = db.all(
    `SELECT t.*, GROUP_CONCAT(DISTINCT u.display_name) as participants
     FROM topics t
     LEFT JOIN topic_participants tp ON tp.topic_id = t.id
     LEFT JOIN users u ON tp.user_id = u.id
     GROUP BY t.id
     ORDER BY t.updated_at DESC`
  );

  const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));

  const CATEGORY_COLORS = {"UNFEST":"#7ab8ff","UNFILM":"#4ade80","UNCINEMA":"#3b82f6","UNLIVE":"#22d3ee","UNDEMO":"#facc15","UNFOLD":"#f97316","SPONSOR":"#e879f9","MANAGEMENT/SETUP":"#a3a3a3","SYSTEM":"#fb7185"};
  const rows = topics.map((t) => {
    const cat = t.category || 'UNFEST';
    const color = CATEGORY_COLORS[cat] || '#999';
    return `
    <tr data-category="${escapeHtml(cat)}">
      <td class="cat"><span class="pill" style="background:${color}22;color:${color};border:1px solid ${color}55">${escapeHtml(cat)}</span></td>
      <td class="title">${escapeHtml(t.title)}</td>
      <td class="summary">${escapeHtml(t.summary).replace(/\n/g, '<br>')}</td>
      <td class="link">${t.reference_link ? t.reference_link.split(',').map((u) => u.trim()).filter(Boolean).map((u, i) => `<a href="${escapeHtml(u)}" target="_blank" rel="noopener">เปิดลิงก์${i > 0 ? ' ' + (i + 1) : ''}</a>`).join('<br>') : '-'}</td>
      <td class="people">${escapeHtml(t.participants) || '-'}</td>
      <td class="date">${escapeHtml(t.updated_at)}</td>
    </tr>`;
  }).join('');
  const categoryList = ['UNFEST', 'UNFILM', 'UNCINEMA', 'UNLIVE', 'UNDEMO', 'UNFOLD', 'SPONSOR', 'MANAGEMENT/SETUP', 'SYSTEM'];
  const filterPills = categoryList.map((cat) => {
    const color = CATEGORY_COLORS[cat];
    const n = topics.filter((t) => (t.category || 'UNFEST') === cat).length;
    return `<button class="filterpill" data-filter="${cat}" style="border-color:${color}55;color:${color}">${cat} (${n})</button>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Migael — หัวข้อที่บันทึกไว้</title>
<style>
  body { font-family: -apple-system, "Noto Sans Thai", sans-serif; background: #1a1a1a; color: #eee; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #999; font-size: 13px; margin-bottom: 16px; }
  .searchbar { width: 100%; box-sizing: border-box; padding: 10px 14px; margin-bottom: 16px; border-radius: 8px; border: 1px solid #3a3a3a; background: #232323; color: #eee; font-size: 14px; }
  .searchbar:focus { outline: none; border-color: #7ab8ff; }
  table { width: 100%; border-collapse: collapse; background: #232323; border-radius: 8px; overflow: hidden; }
  th { background: #2f2f2f; text-align: left; padding: 10px 12px; font-size: 13px; color: #bbb; position: sticky; top: 0; }
  td { padding: 10px 12px; font-size: 14px; border-top: 1px solid #333; vertical-align: top; }
  .title { font-weight: 600; min-width: 160px; }
  .summary { color: #ddd; max-width: 420px; }
  .link a { color: #7ab8ff; }
  .people { color: #aaa; white-space: nowrap; }
  .date { color: #888; font-size: 12px; white-space: nowrap; }
  .empty { padding: 40px; text-align: center; color: #888; }
  tr.hidden { display: none; }
  #count { color: #999; font-size: 12px; margin-bottom: 8px; }
  .pillbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .filterpill { padding: 6px 12px; border-radius: 999px; background: transparent; border: 1px solid #444; color: #ccc; font-size: 12px; cursor: pointer; }
  .filterpill.active { background: #333; font-weight: 600; }
  .pill { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .cat { min-width: 90px; }
</style></head>
<body>
  <h1>📌 หัวข้อที่มิเกลบันทึกไว้</h1>
  <div class="sub">อัปเดตสดจากฐานข้อมูลทุกครั้งที่เปิดหน้านี้ — ทั้งหมด ${topics.length} รายการ</div>
  ${topics.length ? `
  <input class="searchbar" id="search" type="text" placeholder="🔍 ค้นหาด้วย keyword — ชื่อหัวข้อ, เนื้อหา, หรือชื่อคน">
  <div class="pillbar"><button class="filterpill active" data-filter="ALL">ทั้งหมด (${topics.length})</button>${filterPills}</div>
  <div id="count"></div>
  <table>
    <thead><tr><th>หมวด</th><th>หัวข้อ</th><th>สรุป</th><th>ลิงก์</th><th>คนที่เกี่ยวข้อง</th><th>อัปเดตล่าสุด</th></tr></thead>
    <tbody id="rows">${rows}</tbody>
  </table>
  <script>
    const input = document.getElementById('search');
    const trs = Array.from(document.querySelectorAll('#rows tr'));
    const countEl = document.getElementById('count');
    const pills = Array.from(document.querySelectorAll('.filterpill'));
    let activeCategory = 'ALL';
    function applyFilter() {
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      trs.forEach((tr) => {
        const matchesText = !q || tr.textContent.toLowerCase().includes(q);
        const matchesCategory = activeCategory === 'ALL' || tr.dataset.category === activeCategory;
        const match = matchesText && matchesCategory;
        tr.classList.toggle('hidden', !match);
        if (match) shown++;
      });
      countEl.textContent = (q || activeCategory !== 'ALL') ? \`เจอ \${shown} จาก \${trs.length} รายการ\` : '';
    }
    input.addEventListener('input', applyFilter);
    pills.forEach((pill) => {
      pill.addEventListener('click', () => {
        pills.forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        activeCategory = pill.dataset.filter;
        applyFilter();
      });
    });
  </script>
  ` : '<div class="empty">ยังไม่มีหัวข้อที่บันทึกไว้ค่ะ</div>'}
</body></html>`);
});

// Trigger report generation on demand, for previewing without waiting
// for the 22:00 job.
app.get('/debug/generate-reports', (req, res) => {
  const reports = require('./reports');
  const txt = reports.generateDailyReport();
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  res.json({ txt: `${base}/reports/${txt.filename}` });
});

app.get('/debug/sync-now', async (req, res) => {
  await require('./sheetSync').run();
  res.json({ ok: true });
});

app.get('/debug/roster', (req, res) => {
  const primaryGroupId = gs.getPrimaryGroupId();
  const roster = db.all(
    `SELECT DISTINCT u.display_name, tm.name as team
     FROM users u
     JOIN group_members gm ON gm.user_id = u.id
     LEFT JOIN teams tm ON u.team_id = tm.id
     WHERE gm.group_id = ?
     ORDER BY tm.name, u.display_name`,
    [primaryGroupId]
  );
  res.json({ primaryGroupId, roster });
});
app.get('/debug/all-users', (req, res) => {
  res.json(db.all('SELECT id, display_name FROM users'));
});
app.get('/debug/preview-sheet-deletions', async (req, res) => {
  try {
    const sheetSync = require('./sheetSync');
    const preview = await sheetSync.previewDeletions();
    res.json(preview);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Preview endpoints — compose the exact broadcast message WITHOUT
// sending it to LINE (see scheduler.js's dry-run mode). Use these for
// testing from now on instead of the "ทดสอบ..." chat commands, which
// send a REAL message and count against the account's monthly free
// message quota (confirmed live 2026-08-03: burned through 300/month
// from same-day testing alone).
app.get('/debug/preview-morning', async (req, res) => {
  const scheduler = require('./scheduler');
  scheduler.setDryRun(true);
  await scheduler.sendMorningBriefing({ force: true });
  res.json(scheduler.getLastDryRunMessage());
  scheduler.setDryRun(false);
});
app.get('/debug/preview-checkin', async (req, res) => {
  const scheduler = require('./scheduler');
  scheduler.setDryRun(true);
  await scheduler.sendAfternoonCheckin({ force: true });
  res.json(scheduler.getLastDryRunMessage());
  scheduler.setDryRun(false);
});
app.get('/debug/preview-evening', async (req, res) => {
  const scheduler = require('./scheduler');
  scheduler.setDryRun(true);
  await scheduler.sendEveningRecap({ force: true });
  res.json(scheduler.getLastDryRunMessage());
  scheduler.setDryRun(false);
});
app.get('/debug/cleanup-duplicate-test-meetings-2026-08-25', async (req, res) => {
  // Cleans up the 3 duplicate "ทดสอบระบบ" meetings created by the
  // personal-chat session-continuity bug (see handlePersonal comments) —
  // keeps the most recent one, cancels the other 2 Recall bots + deletes
  // their Calendar events + local rows.
  const dupIds = ['e95addef-050d-4c11-84dd-a7c1f83f3849', 'd41840d4-023d-4838-a85c-8d44392a1f48'];
  const results = [];
  for (const id of dupIds) {
    const row = db.get(`SELECT * FROM events WHERE id = ?`, [id]);
    if (!row) { results.push({ id, skipped: true }); continue; }
    if (row.recall_bot_id) await recallApi.deleteScheduledBot(row.recall_bot_id);
    if (row.google_event_id && row.calendar_id) await calendarApi.deleteEvent(row.calendar_id, row.google_event_id);
    db.run(`DELETE FROM events WHERE id = ?`, [id]);
    results.push({ id, cleaned: true });
  }
  res.json({ ok: true, results });
});

app.get('/debug/recent-events', (req, res) => {
  const rows = db.all(
    `SELECT id, title, start_time, meeting_link, recall_bot_id, recall_bot_status, created_at FROM events ORDER BY created_at DESC LIMIT 10`
  );
  res.json(rows);
});

app.get('/debug/groups', (req, res) => {
  const groups = db.all('SELECT * FROM line_groups ORDER BY created_at DESC');
  // group_name is always null (never populated anywhere) — show member
  // names instead so groups are actually distinguishable from this
  // endpoint, e.g. to tell a small test group apart from the real one.
  const withMembers = groups.map((g) => ({
    ...g,
    members: db.all(
      `SELECT u.display_name FROM group_members gm JOIN users u ON gm.user_id = u.id WHERE gm.group_id = ?`,
      [g.id]
    ).map((m) => m.display_name),
  }));
  res.json(withMembers);
});

// ONE-TIME data-cleanup endpoint (2026-08-25) — splits real content that
// got merged into "สรุปประชุม SQNXR 21 AUG" by the openThread bug fixed
// above (see the log_topic session-close comment). Idempotent: checks
// for the specific polluted marker text before doing anything, so it's
// safe to hit more than once and safe to leave deployed — it becomes a
// no-op forever once the one real fix has run. Should still be deleted
// as part of the /debug/* access-protection cleanup (outstanding item).
app.get('/debug/fix-sqnxr-topic-2026-08-25', (req, res) => {
  const marker = 'Playback dome ให้พี่เนส';
  const staleLinkMarker = '1kgIQh2KUc8esqZONM3Q1mvwHrd4u-Zr9';
  const topic = db.get(`SELECT * FROM topics WHERE title = 'สรุปประชุม SQNXR 21 AUG'`);
  if (!topic) {
    return res.json({ ok: true, alreadyClean: true, reason: 'topic not found' });
  }

  const needsSummarySplit = topic.summary && topic.summary.includes(marker);
  const needsLinkClear = topic.reference_link && topic.reference_link.includes(staleLinkMarker);
  if (!needsSummarySplit && !needsLinkClear) {
    return res.json({ ok: true, alreadyClean: true });
  }

  let newPrTopicId = null;
  if (needsSummarySplit) {
    const cleanedSqnxr = `สรุปประชุมความร่วมมือ UNFEST'26 × CLOUD11 × SQNXR — ตกลงทำสัญญา 2 รูปแบบ (Commercial + Non-commercial), โซน Dome เวลา 18:00-22:00 น. (ฉาย Visual 10-15 นาที/รอบ, 18+ หลัง 20:00), Live DJ/Party 22:00-24:00 น., ระบบจองรอบผ่านแอป (60 คน/รอบ สรุปชัดภายใน 3/9), พื้นที่โดม/สวนห้ามบูธ Hard Sale (โลโก้สปอนเซอร์ฉายใน Dome หรือประชาสัมพันธ์ชั้น 6 ได้), การแถลงข่าวแยกราชการ/สื่อหลัก, Talk/Knowledge Sharing อาจปรับเป็นเสวนาเวทีหลัก (World Topic 12/?) หรือบันทึกเทปล่วงหน้า, ส่ง Template visual + สเปค Dome ให้ทีมศิลปินแล้ว, คุณวิวอยากจ้าง staff ทีมเราช่วยดูแล Dome (รอสรุปดีเทล), เซ็นเรียบร้อย — Paid Media Budget: 95,000-125,000 THB แบ่งเป็น Media/News Page 24% (20,000-30,000 THB), Boost Post 12% (15,000+ boost 3 โพสต์ × 5,000 บาท/โพสต์), Paid KOLs 64% (60,000-80,000 THB แบ่ง Nano/Micro/Macro ตามอัตราส่วน 3:1:1) — เบ้บได้สร้างโฟลเดอร์ไดรฟ์ไว้รวมไฟล์จาก co-curate — พี่กบได้รับมอบหมายให้ทำการบ้าน PR — CFO คน Lotus กำลังเพ่งเล็งโปรเจกต์นี้ว่ารอดไม่รอด`;

    const prTeamSummary = `อัปเดตจากทีม PR (แยกออกมาจาก "สรุปประชุม SQNXR 21 AUG" เพราะเป็นคนละเรื่อง — เดิมถูกบันทึกปนกันไปเพราะ session ค้าง): มี yoga techno ในตอนเช้า (เพิ่มเติมจากคุยกับพี่น้ต), Immersive Run club ระยะทาง, คลิป 15 วิ ต้องน่าสนใจตั้งแต่ 3 วิแรก เลือก highlight กิจกรรม/ศิลปิน (พี่เจ, พี่นัท), Highlight เปิดตัว 25% ให้คนเห็นภาพรวมคร่าวๆ ก่อน ยังไม่ต้องเป็น headline เน้นให้ Interesting, วันที่ 9 ยังไม่ชัวร์ว่าโดมจะเสดหรือเปล่า, ตั้งแต่วันที่ 3 เป็นต้นไปเข้าสู่ช่วง Set up — ทีม PR ขอวันสรุปการเซ็ตอัพในแต่ละพื้นที่ เพื่อจะได้ลงรูปจริงของหน้างาน`;

    db.run(`UPDATE topics SET summary = ? WHERE id = ?`, [cleanedSqnxr, topic.id]);

    newPrTopicId = randomUUID();
    db.run(
      `INSERT INTO topics (id, group_id, title, summary, reference_link, created_by, category, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newPrTopicId, topic.group_id, 'อัปเดตทีม PR — Highlight Clip & กำหนดการ Set up', prTeamSummary, null, topic.created_by, 'UNFEST', 'open']
    );
  }

  if (needsLinkClear) {
    // These Dome Playback links already live correctly on their own
    // dedicated topic ("DOME PLAYBACK — Immersive Dome x Physical
    // Sensory") — clearing the duplicate here, not moving it anywhere.
    db.run(`UPDATE topics SET reference_link = NULL WHERE id = ?`, [topic.id]);
  }
  db.run(`UPDATE topics SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [topic.id]);

  res.json({ ok: true, cleanedTopicId: topic.id, newPrTopicId, linkCleared: needsLinkClear });
});

app.get('/debug/dedupe-pr-topic-2026-08-25', (req, res) => {
  const rows = db.all(
    `SELECT id, created_at FROM topics WHERE title = 'อัปเดตทีม PR — Highlight Clip & กำหนดการ Set up' ORDER BY created_at ASC`
  );
  if (rows.length <= 1) {
    return res.json({ ok: true, alreadyClean: true, count: rows.length });
  }
  const keepId = rows[0].id;
  const deleteIds = rows.slice(1).map((r) => r.id);
  for (const id of deleteIds) {
    db.run(`DELETE FROM topics WHERE id = ?`, [id]);
    db.run(`DELETE FROM topic_participants WHERE topic_id = ?`, [id]);
  }
  res.json({ ok: true, kept: keepId, deleted: deleteIds });
});

app.get('/debug/fix-dome-playback-links-2026-08-25', (req, res) => {
  // The topic's summary always had BOTH Drive links (Sunyata + Lactobacillus),
  // but reference_link only ever got the first one saved — the second link
  // typed in the same message got silently dropped by the old single-link
  // logic. Restoring both, comma-joined, now that /topics renders each
  // comma-separated link as its own clickable button.
  const topic = db.get(`SELECT * FROM topics WHERE title = 'DOME PLAYBACK — Immersive Dome x Physical Sensory'`);
  if (!topic) return res.json({ ok: true, alreadyClean: true, reason: 'topic not found' });

  const bothLinks = 'https://drive.google.com/drive/folders/1kglQh2KUc8esqZONM3Q1mvwHrd4u-Zr9?usp=drive_link, https://drive.google.com/drive/folders/1XjtJ1yrio1P2PX71PbtoC-Vlu6d9H5Os?usp=drive_link';
  if (topic.reference_link === bothLinks) return res.json({ ok: true, alreadyClean: true });

  db.run(`UPDATE topics SET reference_link = ? WHERE id = ?`, [bothLinks, topic.id]);
  res.json({ ok: true, topicId: topic.id, reference_link: bothLinks });
});

app.get('/debug/fix-dome-playback-link-typo-2026-08-25', (req, res) => {
  // The "correct" link saved by the previous cleanup was itself wrong —
  // 1kgl... vs the real 1kgI... (lowercase L vs capital I, visually
  // identical in this font, confirmed against the exact text Babe
  // pasted straight from the original source). Fixing to the real ID.
  const topic = db.get(`SELECT * FROM topics WHERE title = 'DOME PLAYBACK — Immersive Dome x Physical Sensory'`);
  if (!topic) return res.json({ ok: true, alreadyClean: true, reason: 'topic not found' });

  const correctLinks = 'https://drive.google.com/drive/folders/1kgIQh2KUc8esqZONM3Q1mvwHrd4u-Zr9?usp=drive_link, https://drive.google.com/drive/folders/1XjtJ1yrio1P2PX71PbtoC-Vlu6d9H5Os?usp=drive_link';
  db.run(`UPDATE topics SET reference_link = ? WHERE id = ?`, [correctLinks, topic.id]);
  // The summary text has the same typo'd ID baked in too — fix both
  // spots so search/recap replies show the correct link as well, not
  // just the button.
  const fixedSummary = (topic.summary || '').split('1kglQh2KUc8esqZONM3Q1mvwHrd4u-Zr9').join('1kgIQh2KUc8esqZONM3Q1mvwHrd4u-Zr9');
  db.run(`UPDATE topics SET summary = ? WHERE id = ?`, [fixedSummary, topic.id]);

  res.json({ ok: true, topicId: topic.id, reference_link: correctLinks });
});

// Recall.ai bot status updates (bot.joining_call, bot.in_call_recording,
// bot.done, bot.fatal, etc.) — see src/recall.js for why we only record
// (no Recall-side transcript). Phase 1: just track status on the event
// row so we can see it's working. Phase 2 (next): when status is "done",
// fetch the recording and kick off Whisper transcription + summary.
//
// Signature verification via Svix (the delivery service Recall.ai uses)
// — needs the RAW request body (not JSON-parsed) to compute/compare the
// signature correctly, so this route uses express.raw() instead of the
// express.json() every other route gets, then parses JSON manually only
// after verification passes.
const { Webhook: SvixWebhook } = require('svix');
app.post('/webhook/recall', express.raw({ type: 'application/json' }), (req, res) => {
  res.json({ ok: true }); // ack fast, same reasoning as the LINE webhook below

  const secret = process.env.RECALL_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[Recall webhook] RECALL_WEBHOOK_SECRET not set — refusing to process unverified webhook');
    return;
  }

  let payload;
  try {
    const wh = new SvixWebhook(secret);
    // req.body is a raw Buffer here (see express.raw() above) — Svix
    // wants the exact bytes/string it originally signed, and needs
    // svix-id/svix-timestamp/svix-signature headers to check against.
    payload = wh.verify(req.body, req.headers);
  } catch (err) {
    console.error('[Recall webhook] signature verification failed:', err.message);
    return;
  }

  const { event, data } = payload || {};
  const botId = data?.bot?.id;
  const statusCode = data?.data?.code;
  if (!botId || !statusCode) return;

  db.run(`UPDATE events SET recall_bot_status = ? WHERE recall_bot_id = ?`, [statusCode, botId]);
  console.log(`[Recall webhook] bot=${botId} event=${event} status=${statusCode}`);
});

app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  // Respond to LINE immediately, BEFORE doing any slow work (Claude +
  // Google Calendar calls can take several seconds). This was the real
  // root cause of duplicate meetings/tasks: LINE times out waiting for
  // our response and redelivers the webhook while we're still mid-
  // processing, and each redelivery got a NEW webhookEventId (not the
  // same one), so the old dedupe check never caught it. Responding fast
  // removes the reason LINE would redeliver in the first place.
  res.json({ ok: true });

  for (const event of req.body.events) {
    // Dedupe key: prefer the actual LINE message id (stable and IDENTICAL
    // across any redelivery of the same message — unlike webhookEventId,
    // which is per delivery attempt, not per message). Falls back to
    // replyToken (also unique per event) for event types with no message.
    const dedupeKey = event.message?.id || event.replyToken || event.webhookEventId;
    if (dedupeKey) {
      const seen = db.get(`SELECT id FROM processed_webhook_events WHERE id = ?`, [dedupeKey]);
      if (seen) continue; // already handled — skip to avoid duplicate actions
      db.run(`INSERT OR IGNORE INTO processed_webhook_events (id) VALUES (?)`, [dedupeKey]);
    }
    handleEvent(event).catch((err) => {
      console.error('[webhook] handleEvent error:', err);
      require('./alertBabe').alertBabe('webhook message handling failed', err);
    });
  }
});

const PORT = process.env.PORT || 3000;

db.init().then(async () => {
  await require('./calendarSeed').run();
  // seed.js (one-time import from seed-tasks.json) removed from boot —
  // Babe's explicit instruction (2026-08-02): task data comes from the
  // live sheet only via sheetSync.js, one source, to avoid duplicate/
  // stale entries like "Post promote session dome 1" that no longer
  // exist in the sheet but never had a way to close. fixTestDebris.js
  // already purged the old seed-imported rows this run; leaving the
  // seed.js call in would just re-import them right back on next boot,
  // since its own guard checks for a marker row that no longer exists.
  require('./cleanup').run();
  require('./fixNatavan').run();
  require('./fixTopics').run();
  require('./fixDuplicateAssignees').run();
  require('./fixTestDebris').run();
  require('./resetToSheet').run();
  app.listen(PORT, () => console.log(`Migael listening on port ${PORT}`));
});
