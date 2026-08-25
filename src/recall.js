// Recall.ai Meeting Bot API — sends "มิเกล" into a Google Meet call to
// record it, so the team doesn't have to manually record on a phone and
// feed it into Gemini afterward. Workspace region: Asia Pacific (Tokyo),
// per Babe's Recall.ai account setup (2026-08-25).
//
// Deliberately does NOT use Recall's built-in transcription — Google
// Meet's own saved-transcript feature only supports 8 languages (no
// Thai), and most of this team's meetings are in Thai. Instead: Recall
// just records; we download the media after the bot is done and run it
// through OpenAI Whisper ourselves (see whisper.js, next phase) which
// handles Thai well.

const RECALL_API_BASE = 'https://ap-northeast-1.recall.ai/api/v1';

function getApiKey() {
  const key = process.env.RECALL_API_KEY;
  if (!key) console.error('[Recall] RECALL_API_KEY not set — bot scheduling will silently no-op');
  return key;
}

/**
 * Schedule a bot to join a meeting at (or near) the meeting's start time.
 * Per Recall's docs: join_at should be at least 10 minutes in the future
 * to guarantee an on-time join; if the meeting is sooner than that, this
 * still works but behaves like an ad-hoc (near-immediate) join instead.
 */
async function scheduleBotForMeeting({ meetingUrl, joinAt, botName = 'Migael' }) {
  const apiKey = getApiKey();
  if (!apiKey || !meetingUrl) return null;

  try {
    const res = await fetch(`${RECALL_API_BASE}/bot/`, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        meeting_url: meetingUrl,
        bot_name: botName,
        join_at: new Date(joinAt).toISOString(),
        // Explicit, not left to default — Recall's own docs recommend
        // this so the mp4 recording is guaranteed to exist by the time
        // bot.done fires. No transcript provider here (see file header).
        recording_config: { video_mixed_mp4: {} },
      }),
    });
    if (!res.ok) {
      console.error('[Recall] scheduleBotForMeeting failed:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return { id: data.id, status: data.status_changes?.[0]?.code || 'scheduled' };
  } catch (err) {
    console.error('[Recall] scheduleBotForMeeting:', err.message);
    return null;
  }
}

/**
 * Cancel a scheduled bot — used when a meeting gets cancelled/rescheduled
 * so we don't leave a bot sitting waiting to join a meeting that changed.
 */
async function deleteScheduledBot(botId) {
  const apiKey = getApiKey();
  if (!apiKey || !botId) return false;

  try {
    const res = await fetch(`${RECALL_API_BASE}/bot/${botId}/`, {
      method: 'DELETE',
      headers: { Authorization: apiKey },
    });
    return res.ok || res.status === 404; // already gone counts as success
  } catch (err) {
    console.error('[Recall] deleteScheduledBot:', err.message);
    return false;
  }
}

/**
 * Fetch full bot details (used once bot.done arrives, to get the
 * recording's media URLs for the next-phase transcription step).
 */
async function getBot(botId) {
  const apiKey = getApiKey();
  if (!apiKey || !botId) return null;

  try {
    const res = await fetch(`${RECALL_API_BASE}/bot/${botId}/`, {
      headers: { Authorization: apiKey },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error('[Recall] getBot:', err.message);
    return null;
  }
}

module.exports = { scheduleBotForMeeting, deleteScheduledBot, getBot, getRecordingDownloadUrl };

/**
 * Once a bot is 'done', pulls the pre-signed (short-lived — expires in
 * hours, per Recall's docs) mp4 download URL out of its recordings.
 * Returns null if there's genuinely no recording (e.g. bot never
 * actually joined/recorded — fatal status, empty meeting, etc.).
 */
function getRecordingDownloadUrl(bot) {
  return bot?.recordings?.[0]?.media_shortcuts?.video_mixed?.data?.download_url || null;
}
