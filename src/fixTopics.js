// One-time fix: 4 topics the team already sent/confirmed earlier tonight
// got entered manually here instead of asking the team to re-type
// everything, since re-running them through the chat pipeline again
// would be redundant (and risks the same topic-merging bug recurring).
const db = require('./db');
const gs = require('./groupState');
const { randomUUID } = require('crypto');

const MARKER_TITLES = [
  'Deal Montonn Jira - UNLIVE',
  'Idea Adamson',
  "Update Space จัดงาน UNFEST'26",
];

function findUserIdByName(name) {
  const row = db.get(`SELECT id FROM users WHERE display_name = ?`, [name]);
  return row ? row.id : null;
}

function linkParticipant(topicId, userId) {
  if (!userId) return;
  db.run(`INSERT OR IGNORE INTO topic_participants (topic_id, user_id) VALUES (?, ?)`, [topicId, userId]);
}

function run() {
  const alreadyDone = db.get(`SELECT id FROM topics WHERE title = ?`, [MARKER_TITLES[0]]);
  const groupId = gs.getPrimaryGroupId();
  const mewId = findUserIdByName('พี่มิ้ว');
  const pearId = findUserIdByName('แพร');

  // 1. Fix the existing "Collab" topic — its summary got polluted with
  // unrelated "Update Space" content from the topic-matching bug. Rewrite
  // it to just the correct Collab info (including the image details).
  const collab = db.get(`SELECT id FROM topics WHERE title = 'Collab UNFEST x PPP x L&D Fashion'`);
  if (collab) {
    const cleanSummary = `Collab ระหว่าง PPP (ภาพพิม), L&D Fashion brand และ UNFEST — อยู่ในขั้นตอน Process การ Develop

รายละเอียดจากสเปคที่แนบ:
- Fabric 150 Meter: Windbreaker, Bag
- Location & activity: Mapping, Outdoor
- Technique: Changing by Temperature, Changing by Raining, two-way using (based on fabric temperature)
- Process: PPP test technique on fabric first, L&D think about pattern, UNFEST provide technique/spot/experience
- Timing: Workshop/Experience on UNFEST'26 ที่ UNFILM STAGE, booth อยู่ตรงทางเข้า (unfest เป็น souvenir booth ด้วย), 11-13 SEP`;
    // Also clear reference_link — it was carrying over the Canva link
    // that actually belongs to the separate "Update Space" topic, a
    // leftover from the original merge bug.
    db.run(`UPDATE topics SET summary = ?, reference_link = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [cleanSummary, collab.id]);
    linkParticipant(collab.id, mewId);
    console.log('[fixTopics] Cleaned up "Collab UNFEST x PPP x L&D Fashion" summary.');
  }

  if (alreadyDone) {
    console.log('[fixTopics] Already ran once — skipping the 3 new inserts.');
  } else {

  const newTopics = [
    {
      title: 'Deal Montonn Jira - UNLIVE',
      summary: `Update Deal Montonn Jira - UNLIVE: ทั้งภาพและเสียงของ UNLIVE — ช่วง Lighting Ambience Installation แต่จะมาหา Community ในช่วง Workshop Sound เพื่อมา Collab งานด้วยกัน ทำใน UNLIVE

พี่เจดูแล 2 ส่วน:
- Ambience Installation 1 Show
- Show live performance 1 Show

*ยังไม่คอนเฟิร์มคิว ว่าจะเล่น slot ไหน หรือวันไหน ติดตามต่อ*`,
      participantId: mewId,
    },
    {
      title: 'Idea Adamson',
      summary: `Note Idea Adamson (จาก Meeting J Monton) — อยากให้มี Artist โชว์:
- Show Audio Technical
- ASDR Sound
- Folae Artist`,
      participantId: mewId,
    },
    {
      title: "Update Space จัดงาน UNFEST'26",
      summary: `Update Space จัดงาน UNFEST'26 — รายละเอียดพื้นที่จัดงานและ layout ตามลิงก์ Canva ที่แนบ`,
      referenceLink: 'https://canva.link/hfln2k0pi9yrfk8',
      participantId: pearId,
    },
  ];

  for (const t of newTopics) {
    const id = randomUUID();
    db.run(
      `INSERT INTO topics (id, group_id, title, summary, reference_link, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, groupId, t.title, t.summary, t.referenceLink || null, t.participantId || null]
    );
    linkParticipant(id, t.participantId);
  }
  console.log(`[fixTopics] Inserted ${newTopics.length} topics manually.`);
  }

  // The "SergeyProkofyev Fulldome source" link asked to be saved via
  // personal chat, but log_topic wasn't wired to actually persist from
  // there yet at the time — added manually here instead of asking for it
  // to be re-sent.
  const sergeyMarker = db.get(`SELECT id FROM topics WHERE title LIKE '%SergeyProkofyev%' OR title LIKE '%Sergey Prokofyev%'`);
  if (!sergeyMarker) {
    const id = require('crypto').randomUUID();
    db.run(
      `INSERT INTO topics (id, group_id, title, summary, reference_link)
       VALUES (?, ?, ?, ?, ?)`,
      [id, groupId, 'Source หนัง Fulldome ของ Sergey Prokofyev', 'ลิงก์ source หนัง Fulldome ของ Sergey Prokofyev (WeTransfer)', 'https://we.tl/t-PXas4NuFxpdqNcrq']
    );
    console.log('[fixTopics] Added the SergeyProkofyev Fulldome source topic manually.');
  }

  // Backfill category on the 4 existing topics, now that the category
  // system (UNFEST/UNFILM/UNCINEMA/UNLIVE/UNDEMO/UNFOLD) exists — these
  // were all created before that column did.
  const categoryBackfill = [
    ['Collab UNFEST x PPP x L&D Fashion', 'UNFEST'],
    ['Deal Montonn Jira - UNLIVE', 'UNLIVE'],
    ["Update Space จัดงาน UNFEST'26", 'UNFEST'],
    ['Source หนัง Fulldome ของ Sergey Prokofyev', 'UNCINEMA'],
  ];
  for (const [title, category] of categoryBackfill) {
    db.run(`UPDATE topics SET category = ? WHERE title = ? AND category IS NULL`, [category, title]);
  }

  // Correction: "Rider งาน Therapy Sensory Round 1" (the PIPE x Baankjork
  // x Medulla Spinalis show) is actually part of UNCINEMA, not UNLIVE —
  // Babe corrected this directly.
  db.run(`UPDATE topics SET category = 'UNCINEMA' WHERE title = 'Rider งาน Therapy Sensory Round 1'`);

  // "Idea Adamson" turned out to actually be a sub-part of "Deal Montonn
  // Jira - UNLIVE", not its own separate topic — merge it in and remove
  // the standalone one, so there are 3 real topics instead of 4.
  const adamson = db.get(`SELECT * FROM topics WHERE title = 'Idea Adamson'`);
  const deal = db.get(`SELECT * FROM topics WHERE title = 'Deal Montonn Jira - UNLIVE'`);
  if (adamson && deal) {
    const merged = `${deal.summary}\n\n${adamson.title}:\n${adamson.summary.replace(/^Note Idea Adamson \(จาก Meeting J Monton\) — /, '')}`;
    db.run(`UPDATE topics SET summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [merged, deal.id]);
    db.run(`DELETE FROM topic_participants WHERE topic_id = ?`, [adamson.id]);
    db.run(`DELETE FROM topics WHERE id = ?`, [adamson.id]);
    console.log('[fixTopics] Merged "Idea Adamson" into "Deal Montonn Jira - UNLIVE" and removed the standalone topic.');
  }
}

module.exports = { run };
