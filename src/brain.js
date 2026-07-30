// brain.js — Migael's decision-making core.
// Every incoming message that should trigger Migael (name mentioned, or
// we're in "listening mode" for that group) gets sent here. Claude reads
// the message + recent context + team roster, and returns a structured
// decision: what kind of thing is this (task / event / status check /
// casual chat), what data to extract, and what Migael should say back.

const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'migael-monday-system-prompt.md'),
  'utf8'
);

// Migael must always know "now" in Thailand time — otherwise relative
// expressions like "สามโมง", "พรุ่งนี้", "วันที่ 30" get resolved against
// the wrong day (this was a real bug in the previous Migael build).
function getBangkokNowString() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('th-TH-u-ca-gregory', {
    timeZone: 'Asia/Bangkok',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const isoDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now); // YYYY-MM-DD
  return `${parts} (เวลาไทย, Asia/Bangkok) — วันที่ ISO: ${isoDate}`;
}

/**
 * Decide what to do with a message.
 * @param {object} ctx
 *   groupId, userId, userName, messageText,
 *   recentMessages: [{userName, text, ts}],   // listening-mode context
 *   teamRoster: [{name, team}],
 *   openThread: {type, id, summary} | null      // active task/event being discussed
 */
async function interpret(ctx) {
  const contextBlock = ctx.recentMessages
    .map((m) => `${m.userName}: ${m.text}`)
    .join('\n');

  const rosterBlock = ctx.teamRoster
    .map((u) => `- ${u.name} (${u.team})`)
    .join('\n');

  const tasksBlock = (ctx.groupData?.tasks || [])
    .map((t) => `- ${t.title} | สถานะ: ${t.status} | ผู้รับผิดชอบ: ${t.assignee || 'ไม่ระบุ'} | กำหนด: ${t.due_date || '-'}${t.is_urgent ? ' | ด่วน' : ''}`)
    .join('\n') || '(ไม่มีงานค้างในระบบตอนนี้)';

  const eventsBlock = (ctx.groupData?.events || [])
    .map((e) => `- ${e.title} | เวลา: ${e.start_time}${e.meeting_link ? ' | ' + e.meeting_link : ''}`)
    .join('\n') || '(ไม่มีนัดที่กำลังจะถึง)';

  const topicsBlock = (ctx.groupData?.topics || [])
    .map((t) => `- [id: ${t.id}] "${t.title}" — ${t.summary}${t.reference_link ? ' | ' + t.reference_link : ''} (อัปเดตล่าสุด: ${t.updated_at})`)
    .join('\n') || '(ยังไม่มีหัวข้อที่ติดตามไว้ในกลุ่มนี้)';

  const userPrompt = `
ตอนนี้คือ: ${getBangkokNowString()}

กลุ่ม: ${ctx.groupName}
ทีมในกลุ่มนี้:
${rosterBlock || '(ยังไม่มีข้อมูล — ต้อง onboard)'}

งานที่ยังค้างอยู่ในระบบตอนนี้ (ข้อมูลจริงจาก DB — ใช้ตอบ status_check หรือคำถามเกี่ยวกับตารางงาน อย่าเดาเอง):
${tasksBlock}

นัดหมาย/มีตติ้งที่กำลังจะถึง (ข้อมูลจริงจาก DB):
${eventsBlock}

หัวข้อ/ไอเดียที่กำลังติดตามอยู่ในกลุ่มนี้ (ข้อมูลจริงจาก DB — เทียบความหมายกับ "ใช้ทำอะไร" ของแต่ละหัวข้อ ไม่ใช่แค่จับคำตรงตัว แม้ทีมจะใช้คำคนละคำกับ title/summary ที่เก็บไว้ก็ให้จับคู่ตามความหมายได้ เช่นถามว่า "เรื่องจอฉาย" ก็อาจตรงกับ topic ชื่อ "สเปคโปรเจกเตอร์ Epson" ถ้าเนื้อหาเกี่ยวข้องกัน — ถ้าข้อความล่าสุดพูดถึงเรื่องที่ตรงกับอันใดอันหนึ่ง ให้ใช้ intent "log_topic" พร้อมใส่ topic_id ของอันนั้นเสมอ เพื่ออัปเดตสรุปแทนที่จะสร้างซ้ำ; ถ้ามีคนถามว่า "คุยถึงไหนแล้ว" หรือ "อัปเดตเรื่อง X หน่อย" ให้ใช้ intent "recap_topic" พร้อมใส่ topic_id ของอันที่ตรงที่สุด แล้วตอบสรุปจากข้อมูลนี้ตรงๆ):
${topicsBlock}

บทสนทนาล่าสุด (ใหม่สุดอยู่ล่าง):
${contextBlock}

ข้อความล่าสุดจาก ${ctx.userName}: "${ctx.messageText}"

${ctx.wasAddressed ? 'มิเกลถูกเรียกชื่อโดยตรง หรือกำลังอยู่ในเรื่องที่คุยค้างไว้ — ตอบได้เต็มที่ตามปกติ' : 'มิเกลไม่ได้ถูกเรียกชื่อในข้อความนี้ — ยังคงวิเคราะห์และบันทึกข้อมูลที่จับได้ตามปกติ (เช่น งานเสร็จแล้ว, อัปเดตหัวข้อ) แต่ reply_message ให้เป็นค่าว่าง "" เว้นแต่กรณีที่ควรพูดเสริมแบบ Participate Mode (ดูกฎในหัวข้อ Two-Layer Access Model) หรือมีอะไรที่ทีมควรรู้ทันที'}

${ctx.openThread ? `หมายเหตุ: กำลังอยู่ในโหมดฟังต่อเนื่องจากเรื่อง "${ctx.openThread.summary}" (${ctx.openThread.type}, id: ${ctx.openThread.id})
ถ้า type คือ event และข้อความล่าสุดเป็นการแก้ไขรายละเอียด (เช่น "ผิดนะ ต้องเป็นบ่ายสี่") ให้ตอบ intent เป็น "correct_event" พร้อมใส่ extracted.event_id = "${ctx.openThread.id}"
ถ้า type คือ topic และข้อความล่าสุดคุยเรื่องเดิมต่อ ให้ตอบ intent เป็น "log_topic" พร้อมใส่ extracted.topic_id = "${ctx.openThread.id}" และเขียน topic_summary ใหม่ทั้งหมด (ไม่ต่อท้าย)
ไม่ต้องสร้างของใหม่ซ้ำในทั้งสองกรณี` : ''}

วิเคราะห์ข้อความนี้และตอบกลับเป็น JSON เท่านั้น ตามโครงสร้าง:
{
  "intent": "create_task" | "create_event" | "create_multiple_tasks" | "correct_event" | "status_check" | "status_update" | "add_detail_to_open_thread" | "log_topic" | "recap_topic" | "casual_chat" | "onboarding_reply" | "general_qa" | "drive_search" | "none",
  "confidence": "high" | "low",
  "extracted": {
    "title": "ชื่องาน/นัดหมาย ถ้ามี",
    "assignee": "ชื่อคนรับผิดชอบ ถ้าเป็นเรื่อง task",
    "due_date": "ISO datetime ถ้าเป็น task ที่มีกำหนดเสร็จ",
    "start_time": "ISO datetime ถ้าเป็น event (ต้องมีค่านี้ถึงจะสร้าง event ได้จริง)",
    "end_time": "ISO datetime ถ้ามีเวลาจบชัดเจน",
    "calendar_name": "ชื่อ calendar ที่เลือกเอง ตามกฎในหัวข้อ Calendar Mapping",
    "attendee_names": "array ชื่อคนในทีม (ตรงกับ roster) ที่ต้องเข้าร่วม event นี้ — ใช้สำหรับแท็กตอนเตือนใน LINE เท่านั้น",
    "attendee_emails": "array อีเมลจริง ถ้ามีคนให้อีเมลมาสำหรับเชิญผ่าน Google Calendar (คนละอันกับ attendee_names)",
    "event_id": "ใส่เฉพาะตอน intent เป็น correct_event หรือ add_detail_to_open_thread ที่กำลังอ้างถึง event เดิม (ใช้ id จาก openThread ด้านบน)",
    "query": "คำค้นหา ถ้าเป็น drive_search",
    "topic_id": "ใส่ตอน intent เป็น log_topic ที่กำลังอัปเดตหัวข้อเดิม หรือ recap_topic ที่จะสรุปหัวข้อไหน — เลือกจาก id ของ topic ที่ตรงที่สุดในรายการด้านล่าง (เทียบตามความหมาย ไม่ต้องตรงคำเป๊ะ) ไม่ใส่ถ้าเป็นหัวข้อใหม่จริงๆ",
    "topic_title": "ชื่อสั้นๆ ของหัวข้อ/ไอเดียที่กำลังคุย เช่น 'สเปคโปรเจกเตอร์ Epson' ใช้ทั้งตอนสร้างใหม่และตอนค้นหา (recap_topic)",
    "topic_summary": "สรุปสถานะล่าสุดของหัวข้อนี้แบบกระชับ (2-4 ประโยค) เขียนใหม่ทุกครั้งที่มีอัปเดต ไม่ใช่ต่อท้ายข้อความเดิม",
    "reference_link": "ลิงก์อ้างอิงที่แนบมาในบทสนทนา เช่น Canva, Drive",
    "participant_names": "array ชื่อคนที่ถูกแท็ก/เกี่ยวข้องกับหัวข้อนี้",
    "items": "array ของ {title, assignee_name, due_date, is_urgent} — ใช้เฉพาะตอน intent เป็น create_multiple_tasks เมื่อข้อความเดียวมีหลายงาน/นัดปนกัน (เช่น 'agenda พรุ่งนี้' ที่มีหลายรายการคนละเวลาคนละคน) แยกเป็นรายการย่อยให้ครบทุกอัน อย่าจับแค่อันแรก"
  },
  "needs_clarification": true | false,
  "clarifying_question": "ถ้า needs_clarification เป็น true ให้ใส่คำถามที่จะถามทีมเป็นภาษาไทยธรรมชาติ",
  "reply_message": "ข้อความที่มิเกลจะตอบกลับในกลุ่ม (โทนอบอุ่น กระชับ ตามบุคลิกที่กำหนดไว้)"
}

ถ้า intent เป็น "none" (เช่นข้อความไม่เกี่ยวอะไรกับมิเกลเลย) ให้ reply_message เป็นค่าว่าง ""

หมายเหตุ: คำอธิบายในแต่ละ field ของ "extracted" ด้านบนเป็นแค่คำอธิบายว่า field นั้นควรใส่อะไร — ในคำตอบจริงให้ใส่ "ค่าจริง" ที่แกะได้ (หรือไม่ใส่ field นั้นเลยถ้าไม่มีข้อมูล) ห้ามคัดลอกข้อความคำอธิบายไปใส่ตรงๆ

หมายเหตุสำคัญเรื่องข้อความที่มีหลายงานปนกัน: ทีมมักพิมพ์ยาวๆ ทีเดียวรวมหลายเรื่อง เช่น "Agenda พรุ่งนี้: 12:00 ทำ X, 13:00 แพทคุย Y @pat, เย็นๆ แคนทำ Z @Pansan" หรือ "ส่วนตัวพี่ มี 17:00 ประชุม A, 21:00 ประชุม B, 22:00 ประชุม C" — ข้อความแบบนี้ **ห้ามจับแค่รายการแรกแล้วทิ้งที่เหลือ** ให้ใช้ intent "create_multiple_tasks" แล้วแยกทุกรายการใส่ใน extracted.items ให้ครบ (แต่ละรายการมี assignee/เวลาของตัวเอง แม้จะไม่ระบุ assignee ชัดเจนทุกอันก็ใส่เท่าที่มี) แล้วสรุปกลับด้วยรายการ bullet ให้เห็นครบทุกอันในคำตอบเดียว
`.trim();

  const resp = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = resp.content.find((b) => b.type === 'text')?.text || '{}';
  const clean = text.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(clean);
  } catch (err) {
    console.error('Failed to parse Claude response as JSON:', text);
    return { intent: 'none', reply_message: '' };
  }
}

module.exports = { interpret };
