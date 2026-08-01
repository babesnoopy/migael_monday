const fs = require('fs');
const p = 'src/scheduler.js';
let c = fs.readFileSync(p, 'utf8');

const old = `async function checkOverdueTasks() {
  const groupId = gs.getPrimaryGroupId();
  if (!groupId) return;

  const overdue = db.all(
    \`SELECT t.*, u.id as assignee_id2, u.display_name as assignee_name FROM tasks t
     LEFT JOIN users u ON t.assignee_id = u.id
     WHERE t.status != 'done' AND datetime(t.due_date) < datetime('now')\`
  );
  for (const t of overdue) {
    // Reminder frequency depends on priority, not how long it's been
    // overdue — urgent tasks get nudged more often than normal ones.
    const intervalHours = t.is_urgent ? 24 : 48; // urgent: every 1 day, normal: every 2 days
    const lastReminder = db.get(
      \`SELECT * FROM reminders WHERE ref_type='task' AND ref_id=? AND reminder_type='overdue'
       ORDER BY sent_at DESC LIMIT 1\`,
      [t.id]
    );
    const hoursSinceLast = lastReminder
      ? (Date.now() - new Date(lastReminder.sent_at).getTime()) / 3600000
      : Infinity;

    if (hoursSinceLast < intervalHours) continue;

    const baseText = \`🔴 แจ้งเตือนค่ะ งาน "\${t.title}" เลยกำหนดเสร็จแล้ว ขออัปเดตสถานะด้วยค่ะ\`;
    const assignee = t.assignee_id2 ? [{ id: t.assignee_id2, display_name: t.assignee_name }] : [];
    await pushWithMentions(groupId, baseText, assignee);

    db.run(
      \`INSERT INTO reminders (id, ref_type, ref_id, reminder_type, scheduled_at, sent_at, group_id)
       VALUES (?, 'task', ?, 'overdue', datetime('now'), datetime('now'), ?)\`,
      [require('crypto').randomUUID(), t.id, groupId]
    );
  }
}`;

if (!c.includes(old)) { console.log('NOT FOUND'); process.exit(1); }

const newText = `async function checkOverdueTasks() {
  const groupId = gs.getPrimaryGroupId();
  if (!groupId) return;

  const overdue = db.all(
    \`SELECT t.*, u.id as assignee_id2, u.display_name as assignee_name FROM tasks t
     LEFT JOIN users u ON t.assignee_id = u.id
     WHERE t.status != 'done' AND datetime(t.due_date) < datetime('now')\`
  );

  // Collect everything due for a reminder right now, then send ONE
  // combined message instead of one push per task — with a dozen-plus
  // overdue rows (e.g. right after importing an old backlog) this used
  // to flood the chat with a wall of separate red-alert messages.
  const dueForReminder = [];
  for (const t of overdue) {
    const intervalHours = t.is_urgent ? 24 : 48; // urgent: every 1 day, normal: every 2 days
    const lastReminder = db.get(
      \`SELECT * FROM reminders WHERE ref_type='task' AND ref_id=? AND reminder_type='overdue'
       ORDER BY sent_at DESC LIMIT 1\`,
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
  mb.add(\`🔴 แจ้งเตือนค่ะ งานที่เลยกำหนดเสร็จแล้ว (\${dueForReminder.length} รายการ) ขออัปเดตสถานะด้วยค่ะ\\n\`);
  for (const t of dueForReminder) {
    mb.add(\`- \${t.title}\`);
    if (t.assignee_id2) mb.add(' ').addMention({ id: t.assignee_id2, display_name: t.assignee_name });
    mb.add('\\n');
  }
  await pushMessage(groupId, mb.build());

  for (const t of dueForReminder) {
    db.run(
      \`INSERT INTO reminders (id, ref_type, ref_id, reminder_type, scheduled_at, sent_at, group_id)
       VALUES (?, 'task', ?, 'overdue', datetime('now'), datetime('now'), ?)\`,
      [require('crypto').randomUUID(), t.id, groupId]
    );
  }
}`;

c = c.replace(old, newText);
fs.writeFileSync(p, c);
console.log('OK');
