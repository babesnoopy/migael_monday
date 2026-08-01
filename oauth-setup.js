// oauth-setup.js — run this ONCE locally (not on Railway) to get a
// GOOGLE_REFRESH_TOKEN with both Calendar + Drive access, then paste
// that token into Railway's environment variables.
//
// Usage:
//   1. npm install
//   2. node oauth-setup.js
//   3. Open the printed URL, log in with the Google account that owns
//      the calendars/Drive you want Migael to use, approve access.
//   4. The refresh token prints in this terminal — copy it into
//      GOOGLE_REFRESH_TOKEN on Railway.
//
// Note: the old token.json only had an access_token, no refresh_token —
// that happens when consent isn't re-prompted. This script forces
// prompt: 'consent' so a refresh token is always issued.

require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.OAUTH_SETUP_PORT || 9873;

const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth2callback`
);

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.readonly',
  // Needed for sheetWrite.js to write task status/date changes and new
  // rows back to the UNFEST'26_CHECKLIST sheet. Kept in sync with the
  // same scope list in src/calendar.js's getAuthUrl().
  'https://www.googleapis.com/auth/spreadsheets',
];

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('No code in query string.');

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    res.send('✅ Done — check your terminal for the refresh token, then close this tab.');

    if (tokens.refresh_token) {
      console.log('\n================================================');
      console.log('GOOGLE_REFRESH_TOKEN =', tokens.refresh_token);
      console.log('================================================');
      console.log('Paste this into Railway → Variables, then you can stop this script.\n');
    } else {
      console.log('\n⚠️  No refresh_token returned. This usually means the account already');
      console.log('    granted consent before. Revoke access at https://myaccount.google.com/permissions');
      console.log('    then run this script again.\n');
    }
  } catch (err) {
    console.error('Token exchange failed:', err.message);
    res.status(500).send('Token exchange failed — check terminal.');
  }
});

app.listen(PORT, () => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
  console.log('\nOpen this URL and log in with the right Google account:\n');
  console.log(authUrl);
  console.log('\nWaiting for you to approve...\n');
});
