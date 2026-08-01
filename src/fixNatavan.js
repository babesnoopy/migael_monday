// One-time fix: NATAVAN's third-person self-introduction ("พี่มิ้วเป็น...")
// didn't get captured automatically, so Babe gave the correct info
// directly to be entered manually instead of having her re-type it in LINE.
const db = require('./db');
const gs = require('./groupState');

function run() {
  const user = db.get(`SELECT id, display_name FROM users WHERE display_name = 'NATAVAN'`);
  if (!user) {
    console.log('[fixNatavan] No user named NATAVAN found — already fixed or never existed.');
    return;
  }
  db.run(`UPDATE users SET display_name = 'พี่มิ้ว' WHERE id = ?`, [user.id]);
  gs.setUserTeam(user.id, 'Creative/Producer', null);
  console.log(`[fixNatavan] Updated ${user.id} from "NATAVAN" to "พี่มิ้ว" (Creative/Producer).`);
}

module.exports = { run };
