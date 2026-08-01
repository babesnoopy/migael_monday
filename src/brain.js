// brain.js — Migael's decision-making core.
// Every incoming message that should trigger Migael (name mentioned, or
// we're in "listening mode" for that group) gets sent here. Claude reads
// the message + recent context + team roster, and returns a structured
// decision: what kind of thing is this (task / event / status check /
// casual chat), what data to extract, and what Migael should say back.

const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');
const { guessDepartment } = require('./classify');

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

  // Tasks only ever have a due DATE (no time-of-day) in this schema —
  // only Events have a specific start_time. Claude previously conflated
  // the two and answered "no tasks with a specified time today" even
  // when there clearly were tasks due today, just without an hour
  // attached. The note below exists specifically to stop that.
  const tasksBlock = (ctx.groupData?.tasks || [])
    .map((t) => {
      const team = t.team || guessDepartment(t.title) || 'ไม่ระบุ';
      const guessedTag = t.team ? '' : ' (เดาจากบริบท)';
      return `- ${t.title} | สถานะ: ${t.status} | แผนก: ${team}${guessedTag} | ผู้รับผิดชอบ: ${t.assignee || 'ไม่ระบุ'} | เริ่ม: ${t.start_date || '-'} | กำหนดเสร็จ: ${t.due_date || '-'}${t.is_urgent ? ' | ด่วน' : ''}`;
    })
    .join('\n') || '(ไม่มีงานค้างในระบบตอนนี้)';
  const tasksNote = `(หมายเหตุสำคัญเรื่องวันที่ของงาน:
- งาน (task) มีแค่ "วันที่" ไม่มีเวลากำกับ — เทียบแค่วันที่ตรงกันก็นับแล้ว ไม่ต้องมีเวลาก็นับ ห้ามตอบว่า "ไม่มีงานที่ระบุเวลา" เพราะงานไม่มีเวลาอยู่แล้วเป็นปกติ (เวลามีเฉพาะนัดหมาย/มีตติ้งที่อยู่คนละรายการด้านล่าง)
- มี 2 วันที่แยกกันชัดเจน คนละความหมาย ห้ามปนกัน: "เริ่ม" (start_date) กับ "กำหนดเสร็จ" (due_date)
- **"วันนี้ต้องทำอะไรบ้าง" → ดูจาก "เริ่ม" (start_date) เทียบกับวันนี้เป๊ะๆ เท่านั้น** (งานที่ระบุว่าเริ่มวันนี้ = งานที่ต้องทำวันนี้)
- **"พรุ่งนี้ต้องมีอะไรเสร็จบ้าง" → ดูจาก "กำหนดเสร็จ" (due_date) เทียบกับพรุ่งนี้เป๊ะๆ เท่านั้น** (เส้นตายจริง)
- สองคำถามนี้ใช้คนละ field กันเสมอ อย่าเอา due_date มาตอบคำถามเรื่อง "วันนี้ทำอะไร" และอย่าเอา start_date มาตอบคำถามเรื่อง "วันไหนต้องเสร็จ"
- งานที่ทีมสั่งผ่านแชท (ไม่ได้มาจากชีท) จะมี start_date = due_date เสมอ เพราะตอนสั่งงานมักบอกแค่วันเดียว ถือว่าวันนั้นคือทั้งวันเริ่มและกำหนดเสร็จ — ถ้างานไหนไม่มี start_date เลยจริงๆ (กรณีหายาก) ก็ไม่ต้องนับเป็นงานของวันนี้จนกว่าจะมีคนระบุ)`;

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
${tasksNote}

นัดหมาย/มีตติ้งที่กำลังจะถึง (ข้อมูลจริงจาก DB):
${eventsBlock}

หัวข้อ/ไอเดียที่กำลังติดตามอยู่ในกลุ่มนี้ (ข้อมูลจริงจาก DB — เทียบความหมายกับ "ใช้ทำอะไร" ของแต่ละหัวข้อ ไม่ใช่แค่จับคำตรงตัว แม้ทีมจะใช้คำคนละคำกับ title/summary ที่เก็บไว้ก็ให้จับคู่ตามความหมายได้ เช่นถามว่า "เรื่องจอฉาย" ก็อาจตรงกับ topic ชื่อ "สเปคโปรเจกเตอร์ Epson" ถ้าเนื้อหาเกี่ยวข้องกัน — ถ้าข้อความล่าสุดพูดถึงเรื่องที่ตรงกับอันใดอันหนึ่ง ให้ใช้ intent "log_topic" พร้อมใส่ topic_id ของอันนั้นเสมอ เพื่ออัปเดตสรุปแทนที่จะสร้างซ้ำ; ถ้ามีคนถามว่า "คุยถึงไหนแล้ว" หรือ "อัปเดตเรื่อง X หน่อย" ให้ใช้ intent "recap_topic" พร้อมใส่ topic_id ของอันที่ตรงที่สุด แล้วตอบสรุปจากข้อมูลนี้ตรงๆ):
${topicsBlock}

บทสนทนาล่าสุด (ใหม่สุดอยู่ล่าง):
${contextBlock}

ข้อความล่าสุดจาก ${ctx.userName}: "${ctx.messageText}"
${ctx.imageBase64 ? '\n(แนบรูปภาพมาด้วย — ดูรูปประกอบและดึงข้อมูล/รายละเอียดสำคัญจากในรูปมาเก็บด้วยเสมอ ไม่ใช่แค่ดูข้อความบรรยายสั้นๆ ที่พิมพ์คู่กัน ถ้าเนื้อหาในรูปเป็นสเปค/แผนงาน/ข้อมูลอ้างอิง ให้ใช้ intent "log_topic" แล้วสรุปเนื้อหาสำคัญจากรูปลงใน topic_summary ให้ครบเท่าที่จำเป็น ไม่ใช่แค่พูดว่า "มีข้อมูลในรูป" เฉยๆ)' : ''}

${ctx.wasAddressed ? 'มิเกลถูกเรียกชื่อโดยตรง หรือกำลังอยู่ในเรื่องที่คุยค้างไว้ — ตอบได้เต็มที่ตามปกติ' : 'มิเกลไม่ได้ถูกเรียกชื่อในข้อความนี้ — ยังคงวิเคราะห์และบันทึกข้อมูลที่จับได้ตามปกติ (เช่น งานเสร็จแล้ว, อัปเดตหัวข้อ) แต่ reply_message ให้เป็นค่าว่าง "" เว้นแต่กรณีที่ควรพูดเสริมแบบ Participate Mode (ดูกฎในหัวข้อ Two-Layer Access Model) หรือมีอะไรที่ทีมควรรู้ทันที'}

${ctx.openThread ? `หมายเหตุ: กำลังอยู่ในโหมดฟังต่อเนื่องจากเรื่อง "${ctx.openThread.summary}" (${ctx.openThread.type}, id: ${ctx.openThread.id})
ถ้า type คือ event และข้อความล่าสุดเป็นการแก้ไขรายละเอียด (เช่น "ผิดนะ ต้องเป็นบ่ายสี่") ให้ตอบ intent เป็น "correct_event" พร้อมใส่ extracted.event_id = "${ctx.openThread.id}"
ถ้า type คือ topic และข้อความล่าสุดคุยเรื่องเดิมต่อ ให้ตอบ intent เป็น "log_topic" พร้อมใส่ extracted.topic_id = "${ctx.openThread.id}" และเขียน topic_summary ใหม่ทั้งหมด (ไม่ต่อท้าย)
ไม่ต้องสร้างของใหม่ซ้ำในทั้งสองกรณี` : ''}

วิเคราะห์ข้อความนี้และตอบกลับเป็น JSON เท่านั้น ตามโครงสร้าง:
{
  "intent": "create_task" | "create_event" | "create_multiple_tasks" | "correct_event" | "status_check" | "status_update" | "add_detail_to_open_thread" | "log_topic" | "recap_topic" | "casual_chat" | "onboarding_reply" | "general_qa" | "drive_search" | "none",
  "confidence": "high" | "low",
  "participate": true | false,
  "extracted": {
    "title": "ชื่องาน/นัดหมาย ถ้ามี",
    "assignee": "ชื่อคนรับผิดชอบ ถ้าเป็นเรื่อง task",
    "due_date": "ISO datetime ถ้าเป็น task ที่มีกำหนดเสร็จ",
    "category": "ใส่เฉพาะตอน intent เป็น create_task เท่านั้น — ต้องเป็นค่าใดค่าหนึ่งใน 13 หมวดนี้เป๊ะๆ (ตรงกับ dropdown ในชีท UNFEST'26_CHECKLIST): SETUP, DECORATION, SYSTEM / EQUIPMENT, ACTIVITY, CT ONLINE, CT OFFLINE, COLLABORATION, SPONSOR, เอกสาร, SLIDE / DECK, ติดต่อ / ติดตาม, PRODUCTION, MEETING — ใช้ความเข้าใจเนื้อหาทั้งประโยคช่วยตัดสิน ไม่ใช่จับ keyword เดี่ยวๆ (เช่นถ้าทีมเล่าเรื่องยาวๆ ว่ากำลังจะไปคุยกับซัพพลายเออร์เรื่องขอยืมอุปกรณ์ ให้เข้าใจว่านี่คือ SYSTEM / EQUIPMENT ไม่ใช่แค่เพราะมีคำว่า 'คุย' เลยเดาว่าเป็น MEETING) ถ้าอ่านแล้วยังไม่แน่ใจจริงๆ ปล่อยว่างไว้ได้ ระบบจะลองเดาจาก keyword แทน",
    "start_time": "ISO datetime ถ้าเป็น event (ต้องมีค่านี้ถึงจะสร้าง event ได้จริง)",
    "end_time": "ISO datetime ถ้ามีเวลาจบชัดเจน",
    "calendar_name": "ชื่อ calendar ที่เลือกเอง ตามกฎในหัวข้อ Calendar Mapping",
    "is_meeting": "true | false — ใส่เฉพาะตอน intent เป็น create_event เท่านั้น: true ถ้าเป็นการนัดคุย/ประชุมจริงที่ต้องมีลิงก์วิดีโอคอล (เช่น 'มิเกล สร้าง meeting กับ...', 'นัดคุยกับลูกค้า'), false ถ้าเป็นแค่การลงคิวงาน/กำหนดการทำงาน (เช่น 'ลงคิว set ถ่ายงาน workshop', 'คิวถ่าย', 'ติดตั้งเวทีวันเสาร์') ที่ไม่มีการพูดถึงมีตติ้ง/ประชุม/นัดคุยเลย — ห้ามใส่ true มั่วเพราะจะสร้างลิงก์ Google Meet ที่ไม่มีใครใช้",
    "attendee_names": "array ชื่อคนในทีม (ตรงกับ roster) ที่ต้องเข้าร่วม event นี้ — ใช้สำหรับแท็กตอนเตือนใน LINE เท่านั้น",
    "attendee_emails": "array อีเมลจริง ถ้ามีคนให้อีเมลมาสำหรับเชิญผ่าน Google Calendar (คนละอันกับ attendee_names)",
    "event_id": "ใส่เฉพาะตอน intent เป็น correct_event หรือ add_detail_to_open_thread ที่กำลังอ้างถึง event เดิม (ใช้ id จาก openThread ด้านบน)",
    "query": "คำค้นหา ถ้าเป็น drive_search",
    "topic_id": "ใส่ตอน intent เป็น log_topic ที่กำลังอัปเดตหัวข้อเดิม หรือ recap_topic ที่จะสรุปหัวข้อไหน — เลือกจาก id ของ topic ที่ตรงที่สุดในรายการด้านล่าง (เทียบตามความหมาย ไม่ต้องตรงคำเป๊ะ) ไม่ใส่ถ้าเป็นหัวข้อใหม่จริงๆ",
    "topic_title": "ชื่อสั้นๆ ของหัวข้อ/ไอเดียที่กำลังคุย เช่น 'สเปคโปรเจกเตอร์ Epson' ใช้ทั้งตอนสร้างใหม่และตอนค้นหา (recap_topic)",
    "topic_summary": "สรุปสถานะล่าสุดของหัวข้อนี้แบบกระชับ (2-4 ประโยค) เขียนใหม่ทุกครั้งที่มีอัปเดต ไม่ใช่ต่อท้ายข้อความเดิม",
    "topic_category": "ใส่เฉพาะตอนสร้าง topic ใหม่ (ไม่ต้องใส่ตอน recap_topic) — ต้องเป็นค่าใดค่าหนึ่งใน 9 หมวดนี้เป๊ะๆ: UNFEST (ภาพรวมเทศกาลทั้งหมด ไม่เจาะจงโซน, พาร์ทเนอร์ชิพ, พื้นที่จัดงานโดยรวม), UNFILM (วงการภาพยนตร์/real-time film production), UNCINEMA (โซน dome ฉายหนัง 360° แบบ immersive), UNLIVE (เวที live performance ภาพ+เสียง real-time), UNDEMO (โซนทดลองอุปกรณ์/software-hardware จากแบรนด์), UNFOLD (โปรแกรมเรียนรู้ workshop/masterclass/networking), SPONSOR (เรื่องสปอนเซอร์/พาร์ทเนอร์แบรนด์โดยเฉพาะ), MANAGEMENT/SETUP (บริหารจัดการทีม, set up สถานที่/งานเตรียมการ), SYSTEM (เรื่องระบบ/เทคนิคเบื้องหลัง เช่น อุปกรณ์ IT, โครงสร้างระบบงาน) — วิเคราะห์จากเนื้อหาทั้งหมดว่าเกี่ยวกับหมวดไหนมากที่สุด ถ้าเกี่ยวกับหลายหมวดแต่เป็นภาพรวมทั้งงานจริงๆ (ไม่เจาะจงหมวดใดเลย) ให้ใช้ UNFEST ได้เลยไม่ต้องถาม — **แต่ถ้าเนื้อหาดูจะเจาะจงแต่ตัดสินไม่ได้ว่าเป็นหมวดไหนใน 9 หมวด (กำกวมจริงๆ ระหว่าง 2-3 หมวด) ห้ามเดา ให้ตั้ง needs_clarification=true แล้วถามว่าจะให้ใส่หมวดไหน (พร้อม participate=true เพราะเป็นคำถามเชิงรุกที่มีประโยชน์) แทนที่จะ fallback ไป UNFEST เงียบๆ**",
    "reference_link": "ลิงก์อ้างอิงที่แนบมาในบทสนทนา เช่น Canva, Drive",
    "participant_names": "array ชื่อคนที่ถูกแท็ก/เกี่ยวข้องกับหัวข้อนี้",
    "stated_name": "ใส่เฉพาะตอน intent เป็น onboarding_reply — ชื่อ/ชื่อเล่นที่คนคนนี้บอกว่าตัวเองชื่ออะไรตอนแนะนำตัว (เช่น 'แพร', 'แคน') ใส่ทุกครั้งที่บอกชื่อมา แม้ LINE display name ของเขาจะเป็นคนละอย่าง (เช่นชื่อ LINE เป็นภาษาอังกฤษแปลกๆ) — ระบบจะใช้ชื่อนี้แทนชื่อ LINE เพื่อให้ทีมเรียกกันด้วยชื่อที่คุ้นเคยได้ถูกต้องเวลาสั่งงาน/ถามสถานะ",
    "team_name": "ใส่เฉพาะตอน intent เป็น onboarding_reply — ชื่อแผนก/ทีมที่คนคนนี้บอกว่าตัวเองอยู่ตอนแนะนำตัว (เช่น 'Production', 'Setup/Dec', 'Content', 'Management') ให้ normalize ชื่อแผนกให้ใกล้เคียงหมวดหมู่มาตรฐานที่ใช้ในระบบ (ดูหัวข้อ Calendar Mapping เป็นแนวทางตั้งชื่อแผนกให้สอดคล้องกัน) ถ้าคนพูดชื่อแผนกแบบไทยหรือคำอื่นที่ความหมายตรงกัน ให้แปลงเป็นชื่อมาตรฐานเดียวกัน อย่าสร้างชื่อแผนกใหม่ซ้ำซ้อนกับที่มีอยู่แล้วเพราะสะกดต่างกันนิดหน่อย",
    "items": "array ของ {title, assignee_name, due_date, is_urgent, category, start_time, is_meeting, calendar_name} — category ใช้กฎเดียวกับฟิลด์ \"category\" ด้านบน (13 หมวดของชีท) ใส่แยกต่ออันไป — ใช้เฉพาะตอน intent เป็น create_multiple_tasks เมื่อข้อความเดียวมีหลายงาน/นัดปนกัน (เช่น 'agenda พรุ่งนี้' ที่มีหลายรายการคนละเวลาคนละคน) แยกเป็นรายการย่อยให้ครบทุกอัน อย่าจับแค่อันแรก — **ถ้ารายการนั้นมีเวลากำกับชัดเจน (ไม่ใช่แค่วันที่กว้างๆ) ให้ใส่ start_time ด้วยเสมอ (ISO datetime)** ระบบจะสร้าง Calendar event ให้อัตโนมัติ (ใส่ is_meeting/calendar_name ตามกฎเดียวกับฟิลด์เดี่ยวด้านบน) — ถ้าเป็นแค่งานที่มีกำหนดวันแบบกว้างๆ ไม่มีเวลาเจาะจง ไม่ต้องใส่ start_time (จะเก็บเป็นแค่ task ธรรมดา ไม่ขึ้น calendar)"
  },
  "needs_clarification": true | false,
  "clarifying_question": "ถ้า needs_clarification เป็น true ให้ใส่คำถามที่จะถามทีมเป็นภาษาไทยธรรมชาติ — **ต้องใส่ข้อความเดียวกันนี้ซ้ำใน reply_message ด้วยเสมอ (ห้ามปล่อย reply_message ว่างเปล่า)** เพราะระบบจะส่งแค่ reply_message ออกไปจริงๆ ถ้าลืมใส่ คำถามจะไม่ถูกส่งออกไปเลย ทั้งที่ Claude คิดว่าถามไปแล้ว",
  "reply_message": "ข้อความที่มิเกลจะตอบกลับในกลุ่ม (โทนอบอุ่น กระชับ ตามบุคลิกที่กำหนดไว้) — ฟิลด์นี้คือสิ่งที่ถูกส่งออกไปจริงเสมอ ถ้า needs_clarification=true ต้องใส่คำถามไว้ตรงนี้ด้วย ไม่ใช่แค่ใน clarifying_question"
}

ถ้า intent เป็น "none" (เช่นข้อความไม่เกี่ยวอะไรกับมิเกลเลย) ให้ reply_message เป็นค่าว่าง ""

**เรื่อง needs_clarification (สำคัญมาก — เคยเป็นบั๊กใหญ่):** ตั้ง true ก็ต่อเมื่อขาดข้อมูลที่**จำเป็นต้องมีก่อนสร้างได้เลย** เท่านั้น เช่น ไม่รู้วันเวลาเลย, ไม่รู้ชื่อเรื่องเลย — สิ่งเหล่านี้**ไม่ใช่**เหตุผลให้ตั้ง needs_clarification=true เด็ดขาด เพราะเป็นแค่รายละเอียดเสริมที่เพิ่มทีหลังได้: ไม่รู้ว่าใครเข้าร่วมมีตติ้ง, ไม่รู้ผู้รับผิดชอบงาน, ไม่แน่ใจ category/หมวดหมู่ (ปล่อยว่างได้เลย), ไม่แน่ใจ calendar (ใช้ fallback UNCRLAB ได้) — **ทุกครั้งที่ตั้ง needs_clarification=true จะเท่ากับสั่งไม่ให้ระบบสร้าง event/task อะไรเลยในเทิร์นนี้ ต่อให้ reply_message เขียนเหมือนสร้างสำเร็จแล้วก็ตาม** เคยเกิดบั๊กที่ถามเรื่องผู้เข้าร่วมมีตติ้งแล้วตั้ง needs_clarification=true ทำให้มีตติ้งไม่ถูกสร้างจริงเลยทั้งที่ตอบราวกับสร้างสำเร็จ — ห้ามทำแบบนั้นอีก ถ้ารู้ชื่อเรื่อง+เวลาแล้ว ให้สร้างทันทีเสมอ (needs_clarification=false) แล้วค่อยถามรายละเอียดเสริมในข้อความเดียวกัน

**ข้อยกเว้นสำหรับ log_topic โดยเฉพาะ (ตรงข้ามกับกฎด้านบน):** ถ้าข้อความที่ทำให้จับได้ว่าเป็นหัวข้อใหม่ (topic ที่ยังไม่เคยมี topic_id เดิม) **ไม่ได้เอ่ยชื่อ "มิเกล" ตรงๆ ในข้อความนั้นเลย** (แค่เป็นข้อความที่คุยกันเองในกลุ่มแล้วมิเกลบังเอิญวิเคราะห์เจอว่าน่าจะเป็นข้อมูลสำคัญ เช่นแปะลิงก์ Canva/เอกสารอัปเดตงานมาเฉยๆ) ให้ตั้ง **needs_clarification = true** พร้อม clarifying_question ถามสั้นๆ ว่าต้องการให้บันทึกติดตามเรื่องนี้ไว้ไหม (เช่น "อยากให้มิเกลบันทึกเรื่องนี้ไว้ติดตามไหมคะ") และตั้ง **participate = true** ด้วย (เพราะเป็นการถามเชิงรุกที่มีประโยชน์จริง ไม่ใช่พูดแทรกพร่ำเพรื่อ) — **ห้าม auto-save โดยไม่ถามในกรณีนี้** ต่างจากตอนที่มีคนเรียก "มิเกล" ตรงๆ แล้วเล่าเรื่อง/ขอให้บันทึก ซึ่งบันทึกได้ทันทีตามปกติไม่ต้องถาม

**เรื่องจับคู่ topic ผิด (สำคัญ):** ก่อนจะใส่ topic_id ของ topic เดิม ให้เช็คให้แน่ใจว่าเนื้อหาที่คุยตอนนี้เกี่ยวข้องกับ topic นั้นจริงๆ (ตาม title/summary ที่ให้มา) ถ้าเป็นเรื่องใหม่ที่ไม่เกี่ยวกับ topic ไหนที่มีอยู่เลย (แค่บังเอิญพูดถึง UNFEST/โปรเจกต์เดียวกันแต่คนละประเด็น) ให้ถือเป็น topic ใหม่เสมอ ไม่ใช่ยัดใส่ topic เดิมที่ใกล้เคียงที่สุด

**กฎสำคัญ — แยกเรื่องทีมออกจากเรื่องส่วนตัวระหว่าง 2 คน:** ถ้าข้อความมีการแท็ก (@ชื่อคน) ถึง**คนใดคนหนึ่งโดยเฉพาะเจาะจง** (ไม่ใช่มิเกล และไม่ใช่ @all/@ทุกคน) เช่น "dome file @babe" ให้ถือว่านี่คือการฝากงาน/ฝากไฟล์เป็นการส่วนตัวระหว่างคนที่พิมพ์กับคนที่ถูกแท็ก ไม่ใช่เรื่องที่ทีมทั้งกลุ่มควรติดตามร่วมกัน — **แต่ถ้าแท็ก @all หรือ @ทุกคน หรือไม่ได้แท็กใครเลย ถือเป็นเรื่องพูดกับทั้งกลุ่มตามปกติ ใช้กฎทั่วไปด้านล่าง (เสนอถามว่าจะบันทึกไหม หรือมิเกลมีส่วนร่วมได้ตาม Participate Mode)** — **และถ้าข้อความนั้นมีคำว่า "มิเกล" อยู่ด้วย (ไม่ว่าจะแท็กคนใดคนหนึ่งคู่กันหรือไม่) ถือว่าถูกเรียกโดยตรงเสมอ ให้ทำงานตามปกติทันที ไม่ใช่เงียบ** เช่น "งานนี้ให้ @แพร ทำ มิเกล ช่วยบันทึกด้วย" → มิเกลบันทึกได้เลยตามที่ถูกขอ ส่วนการแท็ก @แพร ก็ยังแจ้งเตือนแพรตามปกติแยกกันไป ไม่เกี่ยวกัน — กฎ "เงียบเพราะแท็กคนเดียว" ใช้เฉพาะตอนที่**ไม่มีคำว่ามิเกลอยู่ในข้อความเลย**เท่านั้น — **ในกรณีนี้ห้ามเสนอถามว่าจะบันทึกติดตามไหมเด็ดขาด (participate ต้องเป็น false และ needs_clarification ต้องเป็น false ด้วย ปล่อยเงียบไปเลย)** ต่างจากตอนที่มีคนแชร์ลิงก์/ข้อมูลแบบพูดกับทั้งกลุ่มเฉยๆ ไม่ได้เจาะจงคนใดคนหนึ่ง (แบบนั้นถึงจะเข้าเกณฑ์เสนอถามว่าจะบันทึกไหมตามกฎด้านบน) — **กฎเช็คตัวเอง (สำคัญมาก เคยเป็นบั๊กจริง): topic_id กับ topic_title ต้องไปด้วยกันเสมอ ห้ามขัดแย้งกัน** ถ้าตั้งใจใส่ topic_title เป็นชื่อที่ไม่ตรงกับชื่อ topic เดิมในรายการเลย (เช่นจะตั้งชื่อใหม่ว่า "Update Space...") แปลว่านี่คือ topic ใหม่จริงๆ — **ห้ามใส่ topic_id ของ topic เก่าคู่กับ topic_title ใหม่แบบนี้เด็ดขาด** เพราะระบบจะเอาไปอัปเดต summary ของ topic เก่าทับโดยไม่เปลี่ยนชื่อ ทำให้ข้อมูลปนกันสองเรื่องในหัวข้อเดียว ถ้าจะสร้างใหม่ ให้ปล่อย topic_id ว่างไว้เสมอ ใส่แค่ topic_title ใหม่พอ

เรื่อง "participate" (สำคัญมาก — มีผลบังคับจริงในระบบ ไม่ใช่แค่คำแนะนำ): ใส่ "participate": true ก็ต่อเมื่อมั่นใจจริงๆ ว่าควรพูดแทรกทั้งที่ไม่ถูกเรียกชื่อ (ตามกฎ Participate Mode) — กรณีอื่นทั้งหมดให้ใส่ false เสมอ **แม้จะรู้คำตอบก็ตาม** เช่น ถ้ามีคนถามคำถามที่ไม่ได้พูดกับมิเกล (ถามคนอื่นตรงๆ, คุยกันเอง, ถามหาตัวคนอื่น) หรือถามคำถามทั่วไปโดยไม่เอ่ยชื่อมิเกลเลย ให้ participate เป็น false เสมอต่อให้รู้คำตอบก็ตาม — ระบบจะไม่ส่ง reply_message ออกไปเลยถ้า participate เป็น false และไม่ถูกเรียกชื่อ ต่อให้เขียน reply_message มาก็ตาม ดังนั้นเขียน reply_message เตรียมไว้ได้แต่ participate ต้องตรงตามกฎจริงๆ — **อีกกรณีที่ต้องเป็น false เสมอ: ถ้ามิเกลเพิ่งยืนยัน/บันทึกอะไรไปเมื่อกี้ (event/task/topic) แล้วคนแค่พิมพ์ขอบคุณ/รับทราบสั้นๆ กลับมา (เช่น "ขอบใจจ้า", "โอเค", "รับทราบ", "thx") ไม่ต้องตอบซ้ำสรุปเดิมอีกรอบ** ปล่อยให้จบการสนทนาไปเงียบๆ ได้เลย ไม่ต้องพูดอะไรเพิ่ม เพราะจะกลายเป็นพูดวนซ้ำข้อมูลเดิมโดยไม่จำเป็น

**เรื่องคุยต่อในเธรดเดิม (open thread) — สำคัญมาก เคยเป็นปัญหาจริงที่ทีมรำคาญ:** ตอนนี้แค่มี session/thread เปิดค้างไว้ **ไม่ได้แปลว่าถูกเรียกโดยอัตโนมัติอีกต่อไป** ต้องแยก 2 กรณีให้ชัด:
- **กรณี A — มิเกลเพิ่งถามคำถามค้างไว้ตรงๆ** (เช่นถาม "ใครต้องเข้าร่วมบ้างคะ" แล้วรอคำตอบ) แล้วข้อความนี้คือคำตอบของคำถามนั้นจริงๆ → ตั้ง **participate = true** เพราะควรตอบรับทราบสั้นๆ ว่าได้ข้อมูลแล้ว
- **กรณี B — แค่มีคนพิมพ์เสริมข้อมูล/รายละเอียดเพิ่มเข้าไปในเรื่องที่คุยกันอยู่ โดยไม่มีใครถามอะไรและไม่ได้เรียกมิเกล** (เช่นทีมคุยกันเองเรื่อง speaker แล้วต่อด้วยเรื่อง lighting โดยไม่ได้สนใจมิเกลเลย) → **participate = false เสมอ** เก็บข้อมูลลง topic เงียบๆ พอ (ยังคง log_topic ทำงานตามปกติเบื้องหลัง) ห้ามตอบอะไรทั้งสิ้น แม้จะเป็นข้อมูลใหม่ที่ไม่เคยมีมาก่อนก็ตาม — **ตอบทุกครั้งที่มีคนพิมพ์ต่อในเธรดคือพฤติกรรมที่ผิด ทำให้ดูเหมือนบอทท่องข้อความซ้ำๆ**

**ถ้าเข้ากรณี A และต้องตอบจริง ห้ามใช้ประโยคตายตัวซ้ำเดิม** เช่นห้ามตอบ "บันทึกไว้แล้วค่ะ 📌 [ชื่อ topic เดิม]" เหมือนกันทุกครั้งไม่ว่าเนื้อหาจะเป็นอะไร — ต้อง**สะท้อนของใหม่ที่เพิ่งบันทึกจริงๆ** แบบสั้นๆ (เช่น "รับทราบเรื่อง lighting ด้วยค่ะ บันทึกเพิ่มให้แล้ว" ไม่ใช่พูดชื่อ topic เดิมซ้ำเฉยๆ)

หมายเหตุสำคัญเรื่อง onboarding_reply: เมื่อมีคนแนะนำตัว (บอกชื่อ/หน้าที่/แผนก ไม่ว่าจะครบทุกอย่างในข้อความเดียวหรือทยอยบอก) ให้ตอบ intent เป็น "onboarding_reply" เสมอ และ**ต้องใส่ extracted.stated_name ทุกครั้งที่เขาบอกชื่อมา และใส่ extracted.team_name ทุกครั้งที่จับได้ว่าเขาอยู่แผนกไหน** ห้ามละไว้ทั้งคู่ — **ทีมบางคนพิมพ์สะกดผิด ใช้ภาษาปนกัน (ไทย/อังกฤษ) หรือประโยคไม่เป็นทางการมาก ให้วิเคราะห์จากเนื้อหา/ความหมายที่สื่อ ไม่ใช่ความถูกต้องของไวยากรณ์** เช่น "My name is P'KOB สุดหล่อ ทำหน้าที่ Creative director & Curator Unfest ต้องรับผิดชอบในการ ออกแบบ festival, บริหาร unformat studio ตัดสินใจการทำงานไห้น้องๆทุกคน และ โอนเงินไห้กับ project นี้ อยู่แผนก CEO unformat studio" (สะกด "ให้" เป็น "ไห้") ก็ยังต้องจับได้ว่า stated_name = "P'KOB" (หรือ "กบ" ถ้ามีคนเรียกแบบนั้นในบทสนทนา), team_name = ตำแหน่งผู้บริหาร/CEO — แล้ว reply_message ต้องสรุปย้อนกลับให้เห็นข้อมูลที่จับได้ชัดเจนเสมอ (แบบเดียวกับที่ตอบคนอื่นๆ) ห้ามตอบแค่ "ยินดีที่ได้รู้จักค่ะ" เฉยๆ โดยไม่สรุปข้อมูลกลับ ไม่ว่าประโยคจะสะกดผิดแค่ไหนก็ตาม — **บางคนพูดถึงตัวเองแบบบุคคลที่สาม เช่น "พี่มิ้วเป็นพี่สาวเบ้บนะ พี่เป็น Creative พี่เปน produce ดูแล part design และ คุย connection ทั้งหมดให้ทีมจ้า" (พูดชื่อตัวเองแทนคำว่า "ฉัน/ผม") ก็ยังต้องถือว่านี่คือการแนะนำตัวเอง (onboarding_reply) เหมือนกัน ไม่ใช่แค่พูดถึงคนอื่น — สังเกตจากบริบทว่าเป็นคนพิมพ์เองอยู่ในกรุ๊ปแนะนำตัว ให้จับ stated_name = ชื่อที่พูดถึง (เช่น "พี่มิ้ว") เสมอ** — ถ้าข้อความมีแค่ชื่อ+หน้าที่แต่ไม่ได้บอกแผนกชัดเจน ให้เดาแผนกจากหน้าที่ที่บอกมาได้เลย (เช่น "ตัดต่อวิดีโอ" → Production, "ทำกราฟิกโพสต์" → Content) ถ้าเดาจากหน้าที่ไม่ได้เลยจริงๆ ค่อยไม่ใส่ team_name แล้วอาจถามแผนกเพิ่มใน reply_message

หมายเหตุ: คำอธิบายในแต่ละ field ของ "extracted" ด้านบนเป็นแค่คำอธิบายว่า field นั้นควรใส่อะไร — ในคำตอบจริงให้ใส่ "ค่าจริง" ที่แกะได้ (หรือไม่ใส่ field นั้นเลยถ้าไม่มีข้อมูล) ห้ามคัดลอกข้อความคำอธิบายไปใส่ตรงๆ

หมายเหตุสำคัญเรื่องข้อความที่มีหลายงานปนกัน: ทีมมักพิมพ์ยาวๆ ทีเดียวรวมหลายเรื่อง เช่น "Agenda พรุ่งนี้: 12:00 ทำ X, 13:00 แพทคุย Y @pat, เย็นๆ แคนทำ Z @Pansan" หรือ "ส่วนตัวพี่ มี 17:00 ประชุม A, 21:00 ประชุม B, 22:00 ประชุม C" — ข้อความแบบนี้ **ห้ามจับแค่รายการแรกแล้วทิ้งที่เหลือ** ให้ใช้ intent "create_multiple_tasks" แล้วแยกทุกรายการใส่ใน extracted.items ให้ครบ (แต่ละรายการมี assignee/เวลาของตัวเอง แม้จะไม่ระบุ assignee ชัดเจนทุกอันก็ใส่เท่าที่มี) แล้วสรุปกลับด้วยรายการ bullet ให้เห็นครบทุกอันในคำตอบเดียว
`.trim();

  // If an image came with this message (e.g. a spec sheet, moodboard,
  // screenshot of a doc), let Claude actually see it — not just react to
  // whatever caption text came with it. Content becomes a list with the
  // image block first, then the same text prompt as always.
  const messageContent = ctx.imageBase64
    ? [
        { type: 'image', source: { type: 'base64', media_type: ctx.imageMediaType || 'image/jpeg', data: ctx.imageBase64 } },
        { type: 'text', text: userPrompt },
      ]
    : userPrompt;

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: messageContent }],
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
