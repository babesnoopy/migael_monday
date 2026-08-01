// calendar.js — Google Calendar integration (OAuth logic reused from the
// working migael4 build; extended to create Google Meet links and to
// support multiple calendars, since UNFEST26 alone spans 3 calendars).

const { google } = require('googleapis');

function getAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

function getAuthUrl() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  return auth.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
    prompt: 'consent',
  });
}

async function saveToken(code) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  const { tokens } = await auth.getToken(code);
  if (tokens.refresh_token) {
    console.log('\n🔑 GOOGLE_REFRESH_TOKEN:', tokens.refresh_token);
    console.log('👆 Copy this into Railway env vars (do NOT commit it anywhere)\n');
  }
  return tokens;
}

/**
 * List the calendars available to this account, so Migael can map
 * "UNFEST'26: MEETING" etc. to real calendarIds once, on setup.
 */
async function listCalendars() {
  const cal = google.calendar({ version: 'v3', auth: getAuth() });
  const res = await cal.calendarList.list();
  return (res.data.items || []).map((c) => ({ id: c.id, name: c.summary }));
}

async function getEventsForRange(calendarId, timeMin, timeMax) {
  try {
    const cal = google.calendar({ version: 'v3', auth: getAuth() });
    const res = await cal.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
    return res.data.items || [];
  } catch (err) {
    console.error('[Calendar] getEventsForRange:', err.message);
    return [];
  }
}

function getTodayEvents(calendarId = 'primary') {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(); end.setHours(23, 59, 59, 999);
  return getEventsForRange(calendarId, start, end);
}

function getUpcomingEvents(calendarId = 'primary', days = 3) {
  const now = new Date();
  const end = new Date(now); end.setDate(end.getDate() + days);
  return getEventsForRange(calendarId, now, end);
}

/**
 * Create an event, optionally auto-generating a Google Meet link.
 * @param {object} opts
 *   calendarId, title, startTime, endTime, description, attendeeEmails,
 *   createMeetLink (default true)
 */
async function createEvent({
  calendarId = 'primary',
  title,
  startTime,
  endTime,
  description = '',
  attendeeEmails = [],
  createMeetLink = true,
  allDay = false, // true for a plain task with only a due DATE, no specific time
}) {
  try {
    const cal = google.calendar({ version: 'v3', auth: getAuth() });

    const resource = { summary: title, description, attendees: attendeeEmails.map((email) => ({ email })) };

    if (allDay) {
      // All-day events use date-only fields, and Google's API treats the
      // end date as exclusive — a same-day event needs end = start + 1.
      const dateOnly = new Date(startTime).toISOString().slice(0, 10);
      const nextDay = new Date(startTime);
      nextDay.setDate(nextDay.getDate() + 1);
      resource.start = { date: dateOnly };
      resource.end = { date: nextDay.toISOString().slice(0, 10) };
    } else {
      resource.start = { dateTime: new Date(startTime).toISOString(), timeZone: 'Asia/Bangkok' };
      resource.end = { dateTime: new Date(endTime || startTime).toISOString(), timeZone: 'Asia/Bangkok' };
    }

    if (createMeetLink && !allDay) {
      resource.conferenceData = {
        createRequest: {
          requestId: `migael-${Date.now()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      };
    }

    const res = await cal.events.insert({
      calendarId,
      resource,
      conferenceDataVersion: createMeetLink && !allDay ? 1 : 0,
      sendUpdates: attendeeEmails.length ? 'all' : 'none',
    });

    return {
      id: res.data.id,
      htmlLink: res.data.htmlLink,
      meetLink: res.data.hangoutLink || res.data.conferenceData?.entryPoints?.[0]?.uri || null,
    };
  } catch (err) {
    console.error('[Calendar] createEvent:', err.message);
    return null;
  }
}

/**
 * Correct/update an event that was already created (e.g. team says the
 * time was wrong). Patches only the fields provided.
 */
async function updateEvent(calendarId, googleEventId, updates = {}) {
  try {
    const cal = google.calendar({ version: 'v3', auth: getAuth() });
    const resource = {};

    if (updates.title) resource.summary = updates.title;
    if (updates.startTime) {
      resource.start = { dateTime: new Date(updates.startTime).toISOString(), timeZone: 'Asia/Bangkok' };
    }
    if (updates.endTime) {
      resource.end = { dateTime: new Date(updates.endTime).toISOString(), timeZone: 'Asia/Bangkok' };
    }
    if (updates.attendeeEmails) {
      resource.attendees = updates.attendeeEmails.map((email) => ({ email }));
    }

    const res = await cal.events.patch({
      calendarId,
      eventId: googleEventId,
      resource,
      sendUpdates: updates.attendeeEmails?.length ? 'all' : 'none',
    });

    return {
      id: res.data.id,
      htmlLink: res.data.htmlLink,
      meetLink: res.data.hangoutLink || res.data.conferenceData?.entryPoints?.[0]?.uri || null,
      startTime: res.data.start?.dateTime,
    };
  } catch (err) {
    console.error('[Calendar] updateEvent:', err.message);
    return null;
  }
}

module.exports = {
  getAuth,
  getAuthUrl,
  saveToken,
  listCalendars,
  getTodayEvents,
  getUpcomingEvents,
  createEvent,
  updateEvent,
};
