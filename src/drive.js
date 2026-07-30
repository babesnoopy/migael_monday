// drive.js — Google Drive search, so the team can ask Migael to find
// files/folders by name (e.g. "หาโฟลเดอร์รูปรีแคป unfest24") and get a link back.
// Reuses the same OAuth token as Calendar (added drive.readonly scope there).

const { google } = require('googleapis');
const { getAuth } = require('./calendar');

/**
 * Search Drive by name (partial match), optionally restricted to folders.
 * @param {string} query - text to search for in file/folder names
 * @param {boolean} foldersOnly
 */
async function search(query, foldersOnly = false) {
  try {
    const drive = google.drive({ version: 'v3', auth: getAuth() });

    let q = `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`;
    if (foldersOnly) q += ` and mimeType = 'application/vnd.google-apps.folder'`;

    const res = await drive.files.list({
      q,
      fields: 'files(id, name, mimeType, webViewLink, parents)',
      pageSize: 10,
      orderBy: 'modifiedTime desc',
    });

    return (res.data.files || []).map((f) => ({
      name: f.name,
      link: f.webViewLink,
      isFolder: f.mimeType === 'application/vnd.google-apps.folder',
    }));
  } catch (err) {
    console.error('[Drive] search:', err.message);
    return [];
  }
}

module.exports = { search };
