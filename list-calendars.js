// list-calendars.js — run this after oauth-setup.js to see the real
// calendarId for each calendar name, then insert them into the `calendars`
// table (see the SQL it prints below — copy/paste into a DB console,
// or wire into db.js once GOOGLE_REFRESH_TOKEN is set).

require('dotenv').config();
const calendarApi = require('./src/calendar');

(async () => {
  const calendars = await calendarApi.listCalendars();
  console.log('\nCalendars found in this Google account:\n');
  calendars.forEach((c) => console.log(`- ${c.name}  →  ${c.id}`));

  console.log('\n--- Copy the relevant rows below, fill in project_id, and run against your DB ---\n');
  calendars.forEach((c) => {
    console.log(
      `INSERT INTO calendars (id, name, project_id, requires_confirm) VALUES ('${c.id}', '${c.name.replace(/'/g, "''")}', NULL, 0);`
    );
  });
  console.log('\nFor projects with multiple calendars (like UNFEST26), Migael will read the message content and auto-pick the right one based on the calendar_purpose descriptions in migael-monday-system-prompt.md — she only asks when it\'s genuinely ambiguous.\n');
})();
