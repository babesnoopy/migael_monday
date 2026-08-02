// alertBabe.js — real system-health alerting (this is the "E" item
// from the original spec that only ever got folded into daily-report
// wording, never actually built: something that pings Babe personally
// the moment something breaks, instead of the team discovering it by
// Migael going quiet).
//
// Design: rate-limited per distinct error "kind" (a short tag, not the
// full message) so a crash-looping cron job sends ONE alert, not one
// every 5 minutes forever. In-memory only — resets on redeploy, which
// is fine, since a fresh deploy is itself a natural "new incident"
// boundary.
const line = require('@line/bot-sdk');
const client = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

const COOLDOWN_MS = 30 * 60 * 1000; // 30 min between repeat alerts of the same kind
const lastAlertAt = new Map();

async function alertBabe(kind, error) {
  console.error(`[Alert:${kind}]`, error?.message || error);

  const babeId = process.env.BABE_USER_ID;
  if (!babeId) return; // nothing to alert to — don't throw, alerting must never itself crash the caller

  const now = Date.now();
  const last = lastAlertAt.get(kind) || 0;
  if (now - last < COOLDOWN_MS) return; // already alerted recently for this kind
  lastAlertAt.set(kind, now);

  try {
    await client.pushMessage(babeId, {
      type: 'text',
      text: `⚠️ Migael แจ้งเตือนระบบ\n\n${kind}\n${error?.message || String(error)}\n\n(จะไม่แจ้งซ้ำเรื่องเดิมภายใน 30 นาที)`,
    });
  } catch (err) {
    // If even the alert itself fails to send (LINE down, bad token),
    // there's nothing further to do — just log it, don't loop.
    console.error('[Alert] failed to deliver alert to Babe:', err.message);
  }
}

module.exports = { alertBabe };
