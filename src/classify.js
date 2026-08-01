// classify.js — keyword-based category guesser, used as a *display*
// fallback for tasks that don't have a real team_id yet (imported
// checklist backlog, or anything created before its group had a
// roster). Categories match the sheet's own "หมวดหมู่" dropdown exactly
// (see UNFEST'26_CHECKLIST) so Migael's summaries and the sheet always
// use the same vocabulary — never invents its own category names.
// Order matters: checked top to bottom, first match wins. Action-verb
// categories (SETUP/DECORATION/PRODUCTION/etc.) are checked BEFORE
// ACTIVITY on purpose — a title like "ถ่าย recap workshop1" mentions
// "workshop" but is really a Production task (shooting footage), not
// the workshop session itself. ACTIVITY should only win when nothing
// more specific matched, same priority logic used for calendar routing.
const RULES = [
  { team: 'SETUP', keywords: ['setup ', 'set up', 'ติดตั้ง', 'เตรียมสถานที่', 'เตรียมงาน'] },
  { team: 'DECORATION', keywords: ['ตกแต่ง', 'แต่ง', 'decoration', 'เดคอร์', 'เดคคอเรชั่น'] },
  { team: 'SYSTEM / EQUIPMENT', keywords: ['อุปกรณ์', 'ระบบ', 'equipment', 'ไฟ', 'เสียง', 'speaker', 'เช่า'] },
  { team: 'PRODUCTION', keywords: ['ถ่าย', 'ตัดคลิป', 'ตัดต่อ', 'vdo', 'video', ' ob ', 'recap', 'รีแคป', 'กล้อง', 'runthrough'] },
  { team: 'CT OFFLINE', keywords: ['พิมพ์', 'ป้าย', 'ออฟไลน์', 'offline', 'สิ่งพิมพ์'] },
  { team: 'CT ONLINE', keywords: ['โพส', 'โพสต์', 'คอนเทนต์', 'คอนเท้น', 'กราฟฟิก', 'กราฟิก', 'ออนไลน์', 'promote', 'โปรโมท'] },
  { team: 'COLLABORATION', keywords: ['collab', 'ความร่วมมือ', 'ร่วมมือ'] },
  { team: 'SPONSOR', keywords: ['สปอนเซอร์', 'sponsor'] },
  { team: 'เอกสาร', keywords: ['เอกสาร', 'สัญญา', 'บิล', 'report', 'brief', 'บรีฟ', 'paper'] },
  { team: 'SLIDE / DECK', keywords: ['สไลด', 'slide', 'deck', 'พรีเซนต์'] },
  { team: 'ติดต่อ / ติดตาม', keywords: ['ติดต่อ', 'ติดตาม', 'ตามงาน', 'follow up', 'call('] },
  { team: 'MEETING', keywords: ['meeting', 'ประชุม', 'นัดคุย', ' call '] },
  { team: 'ACTIVITY', keywords: ['กิจกรรม', 'activity', 'workshop'] },
];

function guessDepartment(title) {
  if (!title) return null;
  const t = ` ${title.toLowerCase()} `;
  for (const rule of RULES) {
    if (rule.keywords.some((kw) => t.includes(kw.toLowerCase()))) return rule.team;
  }
  return null; // genuinely unclear — caller decides the fallback label
}

module.exports = { guessDepartment };
