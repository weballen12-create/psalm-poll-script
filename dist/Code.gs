// Psalm Poll Script - generated from src/ by build.js. Edit the files in src/, not this one.

// ===== Main.gs =====
/**
 * Psalm Poll Script
 *
 * Reads song suggestions from Gmail, matches them on Spotify, builds a
 * Spotify playlist and a Google Form poll (one Yes/No question per song),
 * and keeps a live bar chart of the Yes votes in this spreadsheet.
 *
 * Menu flow:  1. Find songs in email  ->  review the Songs tab  ->  3. Build playlist & poll
 */

const SHEET_SETTINGS = 'Settings';
const SHEET_SONGS = 'Songs';
const SHEET_HISTORY = 'Poll history';

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

// [label, default value, help text]. Values are looked up by label, so rows can be reordered.
const SETTINGS = [
  ['Emails after', null, 'Only emails received on or after this date are read.'],
  ['Subject words', 'guy, girl, male, female, duet, trio, secular, christian, song, poll',
    'Only emails whose subject contains one of these words are read (plurals count too, e.g. "songs"). Your own sent emails are skipped. Add a word if a new kind of subject shows up.'],
  ['Poll title', 'Song Poll', 'Title at the top of the Google Form.'],
  ['Playlist name', '', 'Leave blank to use the poll title plus today\'s date.'],
  ['Answer required for every song', 'Yes', 'Yes = voters must pick Yes or No on every song.'],
  ['Apple Music playlist link', '', 'Optional. If you make an Apple Music copy of the playlist, paste its link here before step 3 and it goes in the poll.'],
  ['Amazon Music playlist link', '', 'Optional. Same as above, for Amazon Music.'],
  ['Gemini model', DEFAULT_GEMINI_MODEL, 'Only change this if Google retires the model and step 1 says it doesn\'t exist. Current names are listed at ai.google.dev/gemini-api/docs/models (pick a "Flash-Lite" one).'],
];

// Songs tab columns (1-based).
const COL = {
  INCLUDE: 1, FROM: 2, WROTE: 3, COMMENT: 4, TITLE: 5, ARTIST: 6,
  SPOTIFY: 7, APPLE: 8, AMAZON: 9, STATUS: 10, MATCHED_ID: 11,
};
const SONG_HEADERS = [
  'Include', 'Suggested by', 'What they wrote', 'Comment (shown in poll)', 'Song title', 'Artist',
  'Spotify link', 'Apple Music link', 'Amazon Music link', 'Status', 'matched id',
];
const NUM_COLS = SONG_HEADERS.length;

const STATUS_MATCHED = 'Matched';
const STATUS_NOT_FOUND = 'Not found on Spotify - fix the title/artist or paste a Spotify link, then run step 2';
const STATUS_DUPLICATE_PREFIX = 'Same song as row ';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🎵 Psalm Poll')
    .addItem('1. Find songs in email', 'findSongs')
    .addItem('2. Re-check songs I edited', 'recheckSongs')
    .addItem('3. Build playlist & poll', 'buildPoll')
    .addSeparator()
    .addItem('Setup (Spotify & keys)', 'showSetup')
    .addToUi();
}

// ---------------------------------------------------------------- Step 1

function findSongs() {
  withFriendlyErrors_(() => {
    const ss = SpreadsheetApp.getActive();
    const ui = SpreadsheetApp.getUi();
    ensureSheets_();
    const settings = readSettings_();
    const after = settings['Emails after'];
    const words = subjectWords_(settings['Subject words']);
    if (!(after instanceof Date)) throw new Error('Put a date in the Settings tab next to "Emails after".');
    if (!words.length) throw new Error('Fill in "Subject words" in the Settings tab so the script knows which emails to read.');
    spotifyAccessToken_(); // fail now, not halfway through, if Spotify isn't connected

    const sheet = ss.getSheetByName(SHEET_SONGS);
    if (sheet.getLastRow() > 1) {
      const answer = ui.alert('Replace the current song list?',
        'Step 1 clears the Songs tab and reads your email again.', ui.ButtonSet.YES_NO);
      if (answer !== ui.Button.YES) return;
    }

    toast_('Reading email...');
    const emails = fetchEmails_(subjectQuery_(words), after);
    if (!emails.length) {
      ui.alert('No emails found',
        `No emails since ${formatDate_(after)} have a subject containing: ${words.join(', ')}.`, ui.ButtonSet.OK);
      return;
    }

    toast_(`Found ${emails.length} emails. Picking out songs...`);
    const found = extractSongs_(emails, settings);

    toast_(`Found ${found.length} songs. Matching them on Spotify...`);
    const rows = found.map(s => {
      const row = new Array(NUM_COLS).fill('');
      row[COL.INCLUDE - 1] = !s.error;
      row[COL.FROM - 1] = safeText_(s.from);
      row[COL.WROTE - 1] = safeText_(s.as_written);
      row[COL.COMMENT - 1] = safeText_(s.comment);
      if (s.error) {
        row[COL.STATUS - 1] = s.error;
        return row;
      }
      const track = findTrack_(s.title, s.artist, s.as_written);
      fillMatch_(row, track);
      if (s.guessed && track) row[COL.STATUS - 1] = 'Guessed without AI - check it';
      return row;
    });

    clearSongs_(sheet);
    sheet.getRange(1, 1, 1, NUM_COLS).setValues([SONG_HEADERS]); // keeps headers current after updates
    if (rows.length) {
      sheet.getRange(2, COL.INCLUDE, rows.length, 1).insertCheckboxes();
      sheet.getRange(2, 1, rows.length, NUM_COLS).setValues(rows);
    }
    markDuplicates_(sheet);
    sheet.activate();

    const notFound = rows.filter(r => r[COL.INCLUDE - 1] && !r[COL.MATCHED_ID - 1]).length;
    const failed = rows.filter(r => !r[COL.INCLUDE - 1]).length;
    toast_('Done.', 3);
    ui.alert('Songs found',
      `Read ${emails.length} emails and found ${rows.length - failed} songs.` +
      (notFound ? `\n${notFound} couldn't be found on Spotify.` : '') +
      (failed ? `\n${failed} emails couldn't be read - add their songs by hand.` : '') +
      '\n\nCheck the Songs tab: uncheck anything that isn\'t a real suggestion and fix wrong matches ' +
      '(paste the right Spotify link, or edit the title/artist and clear the Spotify link), then run step 2. ' +
      'When it looks right, run step 3.',
      ui.ButtonSet.OK);
  });
}

// ---------------------------------------------------------------- Step 2

function recheckSongs() {
  withFriendlyErrors_(() => {
    ensureSheets_();
    const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_SONGS);
    const n = sheet.getLastRow() - 1;
    if (n < 1) throw new Error('The Songs tab is empty. Run step 1 first.');
    toast_('Re-checking edited songs...');
    const rows = sheet.getRange(2, 1, n, NUM_COLS).getValues();
    let changed = 0;
    rows.forEach(row => {
      if (row[COL.INCLUDE - 1] === false) return; // unchecked, e.g. an email that couldn't be read
      if (row[COL.INCLUDE - 1] === '') row[COL.INCLUDE - 1] = true; // a row typed in by hand
      const link = String(row[COL.SPOTIFY - 1]).trim();
      const pastedId = spotifyTrackId_(link);
      const matchedId = String(row[COL.MATCHED_ID - 1]);
      if (link && pastedId && pastedId !== matchedId) {
        fillMatch_(row, spotifyTrack_(pastedId));
        changed++;
      } else if (!link && (row[COL.TITLE - 1] || row[COL.WROTE - 1])) {
        fillMatch_(row, findTrack_(String(row[COL.TITLE - 1]), String(row[COL.ARTIST - 1]), String(row[COL.WROTE - 1])));
        changed++;
      } else if (link && !pastedId) {
        row[COL.STATUS - 1] = 'That Spotify link isn\'t a song link - it should look like open.spotify.com/track/...';
        changed++;
      }
    });
    sheet.getRange(2, COL.INCLUDE, n, 1).insertCheckboxes(); // clears the column, so do it before writing
    sheet.getRange(2, 1, n, NUM_COLS).setValues(rows);
    markDuplicates_(sheet);
    toast_(changed ? `Re-checked ${changed} songs.` : 'Nothing was edited, so nothing changed.', 5);
  });
}

// ---------------------------------------------------------------- Step 3

function buildPoll() {
  withFriendlyErrors_(() => {
    const ss = SpreadsheetApp.getActive();
    const ui = SpreadsheetApp.getUi();
    ensureSheets_();
    const settings = readSettings_();
    const sheet = ss.getSheetByName(SHEET_SONGS);
    const n = sheet.getLastRow() - 1;
    if (n < 1) throw new Error('The Songs tab is empty. Run step 1 first.');

    const included = sheet.getRange(2, 1, n, NUM_COLS).getValues().filter(r => r[COL.INCLUDE - 1] === true);
    const unmatched = included.filter(r => !r[COL.MATCHED_ID - 1]).length;
    const songs = mergeSongs_(included.filter(r => r[COL.MATCHED_ID - 1]));
    if (!songs.length) throw new Error('No checked songs have a Spotify match yet.');

    const answer = ui.alert('Build the playlist and poll?',
      `${songs.length} songs will go in the playlist and poll.` +
      (unmatched ? `\n${unmatched} checked songs have no Spotify match and will be left out.` : ''),
      ui.ButtonSet.YES_NO);
    if (answer !== ui.Button.YES) return;

    const stamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
    const pollTitle = String(settings['Poll title'] || 'Song Poll').trim();
    const playlistName = String(settings['Playlist name'] || '').trim() || `${pollTitle} ${stamp}`;

    toast_('Making the Spotify playlist...');
    const playlistUrl = createPlaylist_(playlistName, `Songs for ${pollTitle}. Vote in the poll!`, songs.map(s => s.id));

    toast_('Making the poll...');
    const poll = createPoll_(songs, settings, pollTitle, playlistUrl, stamp);

    ss.getSheetByName(SHEET_HISTORY).appendRow(
      [new Date(), poll.voteUrl, poll.editUrl, playlistUrl, poll.resultsSheet.getName(), songs.length]);
    poll.resultsSheet.activate();
    toast_('Done!', 3);
    showLinks_(poll, playlistUrl, songs.length);
  });
}

function showLinks_(poll, playlistUrl, count) {
  const link = (url, text) => `<a href="${escapeHtml_(url)}" target="_blank">${escapeHtml_(text)}</a>`;
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">
      <p>Made a poll with <b>${count}</b> songs.</p>
      <p><b>Send this to the club:</b><br>${link(poll.voteUrl, poll.voteUrl)}</p>
      <p>${link(playlistUrl, 'Open the Spotify playlist')}<br>
         ${link(poll.editUrl, 'Edit the form')}</p>
      <p>Results update live in the <b>${escapeHtml_(poll.resultsSheet.getName())}</b> tab, which only you can see.
         Every poll is also listed in the <b>${SHEET_HISTORY}</b> tab.</p>
    </div>`;
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(480).setHeight(300), 'Poll ready');
}

// ---------------------------------------------------------------- Songs tab helpers

/** Search Spotify for a song, falling back to looser searches. Returns a track or null. */
function findTrack_(title, artist, asWritten) {
  const tries = [];
  if (title) tries.push(`${title} ${artist || ''}`.trim());
  if (title && artist) tries.push(title);
  if (asWritten) tries.push(String(asWritten).replace(/[()]/g, ' ').replace(/\s+by\s+/i, ' '));
  for (const q of tries) {
    const track = spotifySearch_(q);
    if (track) return track;
  }
  return null;
}

/** Fill a Songs row's match columns from a Spotify track (or mark it not found). */
function fillMatch_(row, track) {
  if (!track) {
    row[COL.SPOTIFY - 1] = '';
    row[COL.APPLE - 1] = '';
    row[COL.AMAZON - 1] = '';
    row[COL.MATCHED_ID - 1] = '';
    row[COL.STATUS - 1] = STATUS_NOT_FOUND;
    return;
  }
  row[COL.TITLE - 1] = safeText_(track.title);
  row[COL.ARTIST - 1] = safeText_(track.artist);
  row[COL.SPOTIFY - 1] = track.url;
  row[COL.APPLE - 1] = appleMusicLink_(track.title, track.firstArtist);
  row[COL.AMAZON - 1] = amazonMusicLink_(track.title, track.firstArtist);
  row[COL.MATCHED_ID - 1] = track.id;
  row[COL.STATUS - 1] = STATUS_MATCHED;
}

/** Flag rows that matched the same Spotify track as an earlier row. */
function markDuplicates_(sheet) {
  const n = sheet.getLastRow() - 1;
  if (n < 1) return;
  const range = sheet.getRange(2, COL.STATUS, n, COL.MATCHED_ID - COL.STATUS + 1);
  const values = range.getValues();
  const firstRow = {};
  values.forEach((v, i) => {
    const id = v[COL.MATCHED_ID - COL.STATUS];
    if (String(v[0]).indexOf(STATUS_DUPLICATE_PREFIX) === 0) v[0] = STATUS_MATCHED;
    if (!id) return;
    if (firstRow[id]) v[0] = `${STATUS_DUPLICATE_PREFIX}${firstRow[id]} - they'll be merged into one question`;
    else firstRow[id] = i + 2;
  });
  range.setValues(values);
}

/**
 * Turn checked, matched Songs rows into poll songs: one per Spotify track, in
 * sheet order, with everyone's comments on that track joined together.
 */
function mergeSongs_(rows) {
  const byId = {};
  const order = [];
  rows.forEach(r => {
    const id = String(r[COL.MATCHED_ID - 1]);
    if (!byId[id]) {
      byId[id] = {
        id,
        title: String(r[COL.TITLE - 1]).trim(),
        artist: String(r[COL.ARTIST - 1]).trim(),
        spotify: String(r[COL.SPOTIFY - 1]).trim() || `https://open.spotify.com/track/${id}`,
        apple: String(r[COL.APPLE - 1]).trim(),
        amazon: String(r[COL.AMAZON - 1]).trim(),
        comments: [],
      };
      order.push(byId[id]);
    }
    const comment = String(r[COL.COMMENT - 1]).trim();
    if (comment && byId[id].comments.indexOf(comment) === -1) byId[id].comments.push(comment);
  });
  const seen = {};
  return order.map(s => {
    s.label = s.artist ? `${s.title} – ${s.artist}` : s.title;
    let question = questionTitle_(s.title, s.artist, s.comments.join(' / '));
    // Form response columns are matched by question text, so it must be unique.
    seen[question] = (seen[question] || 0) + 1;
    if (seen[question] > 1) question += ` (${seen[question]})`;
    s.question = question;
    return s;
  });
}

function questionTitle_(title, artist, comment) {
  let q = artist ? `${title} – ${artist}` : title;
  if (comment) q += ` (${comment})`;
  return q;
}

function clearSongs_(sheet) {
  const last = sheet.getMaxRows();
  if (last > 1) sheet.getRange(2, 1, last - 1, NUM_COLS).clearContent().clearDataValidations();
}

// ---------------------------------------------------------------- Sheets & settings

function ensureSheets_() {
  const ss = SpreadsheetApp.getActive();

  if (!ss.getSheetByName(SHEET_SETTINGS)) {
    const sh = ss.insertSheet(SHEET_SETTINGS, 0);
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const rows = SETTINGS.map(([label, def, help]) => [label, label === 'Emails after' ? weekAgo : def, help]);
    sh.getRange(1, 1, 1, 3).setValues([['Setting', 'Value', 'What it does']]).setFontWeight('bold');
    sh.getRange(2, 1, rows.length, 3).setValues(rows);
    sh.getRange(2, 2).setNumberFormat('mmm d, yyyy');
    sh.getRange(2, 2, rows.length, 1).setBackground('#fff8e1');
    sh.setColumnWidth(1, 230);
    sh.setColumnWidth(2, 260);
    sh.setColumnWidth(3, 520);
    sh.getRange(2, 3, rows.length, 1).setWrap(true).setFontColor('#666666');
    sh.setFrozenRows(1);
    const yesNo = SpreadsheetApp.newDataValidation().requireValueInList(['Yes', 'No'], true).build();
    SETTINGS.forEach(([label], i) => {
      if (label === 'Answer required for every song') {
        sh.getRange(i + 2, 2).setDataValidation(yesNo);
      }
    });
  }

  if (!ss.getSheetByName(SHEET_SONGS)) {
    const sh = ss.insertSheet(SHEET_SONGS, 1);
    sh.getRange(1, 1, 1, NUM_COLS).setValues([SONG_HEADERS]).setFontWeight('bold').setBackground('#e8f0fe');
    sh.setFrozenRows(1);
    [70, 130, 260, 220, 200, 160, 200, 200, 200, 260].forEach((w, i) => sh.setColumnWidth(i + 1, w));
    sh.getRange(1, COL.WROTE, sh.getMaxRows(), 2).setWrap(true);
    sh.hideColumns(COL.MATCHED_ID);
  }

  if (!ss.getSheetByName(SHEET_HISTORY)) {
    const sh = ss.insertSheet(SHEET_HISTORY);
    sh.getRange(1, 1, 1, 6)
      .setValues([['Made on', 'Voting link', 'Edit form', 'Spotify playlist', 'Results tab', 'Songs']])
      .setFontWeight('bold');
    sh.setFrozenRows(1);
  }

  // A brand-new spreadsheet comes with an empty "Sheet1"; tidy it away.
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
}

function readSettings_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SETTINGS);
  const out = {};
  sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 2).getValues()
    .forEach(([label, value]) => { if (label) out[String(label).trim()] = value; });
  return out;
}

/** "guy, girl , song" -> ['guy', 'girl', 'song'] */
function subjectWords_(value) {
  return String(value || '').split(/[,\n]/).map(w => w.trim().toLowerCase()).filter(Boolean);
}

function isYes_(value) {
  return value === true || /^y/i.test(String(value).trim());
}

// ---------------------------------------------------------------- Small utilities

function withFriendlyErrors_(fn) {
  try {
    fn();
  } catch (e) {
    console.error(e && e.stack || e);
    SpreadsheetApp.getUi().alert('Psalm Poll', String(e && e.message || e), SpreadsheetApp.getUi().ButtonSet.OK);
  }
}

function toast_(msg, seconds) {
  SpreadsheetApp.getActive().toast(msg, 'Psalm Poll', seconds || -1);
}

function formatDate_(d) {
  return Utilities.formatDate(d, SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'MMM d, yyyy');
}

/** Stop Sheets from treating text like "+44" or "=song" as a formula. */
function safeText_(s) {
  s = s == null ? '' : String(s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function getProp_(key) {
  return PropertiesService.getUserProperties().getProperty(key) || '';
}

function toQuery_(obj) {
  return Object.keys(obj).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k])).join('&');
}

// ===== Email.gs =====
/**
 * Gmail reading. Uses the Gmail advanced service (enabled in appsscript.json)
 * with only the read-only scope, so the script can never send, change or
 * delete email. (GmailApp would need full mail access.)
 */

const MAX_EMAILS = 150;

/**
 * Gmail search for emails whose subject contains any of the words (or their
 * plural), excluding your own sent mail. Gmail matches whole words, so the
 * plural has to be listed separately.
 */
function subjectQuery_(words) {
  const terms = [];
  words.forEach(w => {
    const quoted = /\s/.test(w) ? `"${w}"` : w;
    terms.push(quoted);
    if (!/\s/.test(w) && !/s$/.test(w)) terms.push(w + 's');
  });
  return `subject:(${terms.join(' OR ')}) -from:me`;
}

/** Emails matching the Gmail search `filter` received after `afterDate`, oldest first. */
function fetchEmails_(filter, afterDate) {
  const q = `${filter} after:${Math.floor(afterDate.getTime() / 1000)}`;
  const ids = [];
  let pageToken = '';
  do {
    const data = Gmail.Users.Messages.list('me', Object.assign({ q, maxResults: 100 }, pageToken ? { pageToken } : {}));
    (data.messages || []).forEach(m => ids.push(m.id));
    pageToken = data.nextPageToken || '';
  } while (pageToken && ids.length <= MAX_EMAILS);

  if (ids.length > MAX_EMAILS) {
    throw new Error(`More than ${MAX_EMAILS} emails matched. Move "Emails after" later, ` +
      'or remove very common words from "Subject words".');
  }

  return ids
    .map(id => parseMessage_(Gmail.Users.Messages.get('me', id, { format: 'full' })))
    .sort((a, b) => a.time - b.time);
}

function parseMessage_(msg) {
  const headers = {};
  (msg.payload.headers || []).forEach(h => { headers[h.name.toLowerCase()] = h.value; });
  return {
    id: msg.id,
    time: Number(msg.internalDate),
    from: senderName_(headers.from || ''),
    subject: headers.subject || '',
    body: cleanBody_(messageText_(msg.payload)),
  };
}

function messageText_(payload) {
  const plain = findPart_(payload, 'text/plain');
  if (plain) return decodeWebSafe_(plain);
  const html = findPart_(payload, 'text/html');
  return html ? htmlToText_(decodeWebSafe_(html)) : '';
}

/** Depth-first search for the first non-attachment part of a MIME type. */
function findPart_(part, mimeType) {
  if (part.mimeType === mimeType && !part.filename && part.body && part.body.data && part.body.data.length) return part.body.data;
  for (const p of part.parts || []) {
    const found = findPart_(p, mimeType);
    if (found) return found;
  }
  return null;
}

/** Message body data: the Gmail service may hand it back as bytes or as web-safe base64 text. */
function decodeWebSafe_(data) {
  const bytes = typeof data === 'string' ? Utilities.base64DecodeWebSafe(data) : data;
  return Utilities.newBlob(bytes).getDataAsString('UTF-8');
}

function htmlToText_(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/**
 * Drop quoted earlier messages and signatures so a reply doesn't re-suggest
 * songs from the email it's replying to.
 */
function cleanBody_(text) {
  let t = String(text).replace(/\r\n/g, '\n');
  const cutPoints = [
    /\n\s*On [^\n]{0,200}(\n[^\n]{0,200})?wrote:\s*\n/, // Gmail/Apple reply header (may wrap onto 2 lines)
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\n_{10,}\s*\n\s*From:/,                           // Outlook
    /\n-- ?\n/,                                         // signature delimiter
    /\nSent from my /,
  ];
  cutPoints.forEach(re => {
    const m = ('\n' + t).search(re);
    if (m > 0) t = t.slice(0, m - 1);
    else if (m === 0) t = '';
  });
  return t.split('\n')
    .filter(line => !/^\s*>/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** "Jane Doe <jane@example.com>" -> "Jane Doe"; bare addresses are kept as-is. */
function senderName_(from) {
  const m = String(from).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return m[1].trim() || m[2].trim();
  return String(from).trim();
}

// ===== Extract.gs =====
/**
 * Pulls song suggestions out of email text. Only emails whose subject passed
 * the "Subject words" filter get here.
 *
 * Which reader is used depends on the keys saved in Setup:
 *   Claude key  -> Claude (paid, one request per email)
 *   Gemini key  -> Gemini free tier (10 emails per request, so a run uses 2-3 requests)
 *   neither     -> a simple line/sentence splitter; you clean up more by hand
 *
 * All return rows of {from, as_written, title, artist, comment}, plus
 * `error` (email couldn't be read) or `guessed` (no-AI result).
 */

const CLAUDE_MODEL = 'claude-opus-5';
const GEMINI_BATCH = 10;

const EXTRACT_RULES = `Music club members email the organizer song suggestions for the club to sing. Subjects are usually like "Guy secular", "Girl Christian", "Male duet" or "Song poll". Only list songs the sender is putting forward for the club; ignore songs that are only quoted from someone else, and ignore emails that aren't suggestions (e.g. announcements or poll results).

People type quickly: titles and artist names are often misspelled, abbreviated, or run together in one sentence, for example "If its mean to be by florida georgia line. Cant tell it all remix with hulvey and kb."

For each suggested song return:
- title: the song title, spelled correctly if you recognize the song. Keep version words like "Remix", "Live" or "Acoustic" if the sender asked for a specific version.
- artist: the artist or artists, spelled correctly if you recognize them. Use an empty string if none is given and you don't know it.
- comment: the sender's own reason or description for that song, in their own words, without surrounding parentheses. Use an empty string if there is none.
- as_written: the exact text from the email that names this song.

Ignore greetings, sign-offs and signatures. If an email doesn't suggest any songs, list nothing for it. Only list songs the email actually names.`;

function extractSongs_(emails, settings) {
  const claudeKey = getProp_('CLAUDE_API_KEY');
  const geminiKey = getProp_('GEMINI_API_KEY');
  if (claudeKey) return extractWithClaude_(emails, claudeKey);
  if (geminiKey) return extractWithGemini_(emails, geminiKey, String(settings['Gemini model'] || '').trim() || DEFAULT_GEMINI_MODEL);
  return extractWithoutAi_(emails);
}

/** Row for an email the AI couldn't read, so its songs can be added by hand. */
function unreadRow_(email, error) {
  return {
    from: email.from,
    as_written: email.body.slice(0, 300),
    comment: '',
    error: `Couldn't read this email (${error}) - add its songs by hand`,
  };
}

// ---------------------------------------------------------------- Gemini (free tier)

const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    songs: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          email: { type: 'INTEGER', description: 'The number of the email this song came from' },
          title: { type: 'STRING' },
          artist: { type: 'STRING' },
          comment: { type: 'STRING' },
          as_written: { type: 'STRING' },
        },
        required: ['email', 'title', 'artist', 'comment', 'as_written'],
        propertyOrdering: ['email', 'as_written', 'title', 'artist', 'comment'],
      },
    },
  },
  required: ['songs'],
};

function extractWithGemini_(emails, apiKey, model) {
  const batches = [];
  for (let i = 0; i < emails.length; i += GEMINI_BATCH) batches.push(emails.slice(i, i + GEMINI_BATCH));

  const songs = [];
  const errors = [];
  batches.forEach(batch => {
    const { url, ...params } = geminiRequest_(apiKey, model, batch);
    const res = UrlFetchApp.fetch(url, params);
    const parsed = parseGeminiResponse_(res.getResponseCode(), res.getContentText(), model);
    if (parsed.error) {
      errors.push(parsed.error);
      batch.forEach(email => songs.push(unreadRow_(email, parsed.error)));
      return;
    }
    parsed.songs.forEach(s => {
      const email = batch[s.email - 1];
      songs.push({
        from: email ? email.from : '',
        as_written: s.as_written,
        title: s.title,
        artist: s.artist,
        comment: s.comment,
      });
    });
  });

  if (errors.length === batches.length) throw new Error('Gemini couldn\'t read the emails: ' + errors[0]);
  return songs;
}

function geminiRequest_(apiKey, model, batch) {
  const text = batch.map((e, i) =>
    `=== Email ${i + 1} ===\nFrom: ${e.from}\nSubject: ${e.subject}\n\n${e.body}`).join('\n\n');
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify({
      systemInstruction: {
        parts: [{ text: EXTRACT_RULES + '\n\nYou will get several emails, each starting with "=== Email N ===". For each song, give the number of the email it came from.' }],
      },
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: GEMINI_SCHEMA,
        maxOutputTokens: 8192,
      },
    }),
  };
}

/** Returns {songs: [...]} or {error: "..."}. */
function parseGeminiResponse_(code, body, model) {
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    return { error: `HTTP ${code}` };
  }
  if (code === 429) return { error: 'Gemini\'s free limit is used up for now - wait a minute (or until tomorrow) and run step 1 again' };
  if (code === 404) return { error: `Gemini has no model called "${model}" - update "Gemini model" in Settings` };
  if (code !== 200) return { error: (data.error && data.error.message) || `HTTP ${code}` };
  if (data.promptFeedback && data.promptFeedback.blockReason) return { error: 'Gemini blocked these emails' };
  const candidate = (data.candidates || [])[0];
  if (!candidate) return { error: 'empty reply' };
  if (candidate.finishReason === 'MAX_TOKENS') return { error: 'the reply was cut off' };
  const text = ((candidate.content && candidate.content.parts) || []).map(p => p.text || '').join('');
  try {
    const songs = JSON.parse(text).songs;
    if (!Array.isArray(songs)) return { error: 'unexpected reply' };
    return { songs };
  } catch (e) {
    return { error: 'unreadable reply' };
  }
}

// ---------------------------------------------------------------- Claude (paid)

const CLAUDE_SCHEMA = {
  type: 'object',
  properties: {
    songs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          artist: { type: 'string' },
          comment: { type: 'string' },
          as_written: { type: 'string' },
        },
        required: ['title', 'artist', 'comment', 'as_written'],
        additionalProperties: false,
      },
    },
  },
  required: ['songs'],
  additionalProperties: false,
};

function extractWithClaude_(emails, apiKey) {
  const results = [];
  for (let i = 0; i < emails.length; i += 5) {
    const batch = emails.slice(i, i + 5);
    const responses = UrlFetchApp.fetchAll(batch.map(e => claudeRequest_(apiKey, e)));
    // Rate-limited (429) or busy (5xx): wait and try those emails once more.
    const retry = responses.map((res, j) => j).filter(j => responses[j].getResponseCode() === 429 || responses[j].getResponseCode() >= 500);
    if (retry.length) {
      Utilities.sleep(10000);
      UrlFetchApp.fetchAll(retry.map(j => claudeRequest_(apiKey, batch[j]))).forEach((res, k) => { responses[retry[k]] = res; });
    }
    responses.forEach((res, j) => {
      results.push({ email: batch[j], parsed: parseClaudeResponse_(res.getResponseCode(), res.getContentText()) });
    });
  }

  // A bad key or empty credit balance fails every email the same way; say so once.
  if (results.length && results.every(r => r.parsed.error)) {
    throw new Error('Claude couldn\'t read the emails: ' + results[0].parsed.error);
  }

  const songs = [];
  results.forEach(({ email, parsed }) => {
    if (parsed.error) songs.push(unreadRow_(email, parsed.error));
    else parsed.songs.forEach(s => songs.push(Object.assign({ from: email.from }, s)));
  });
  return songs;
}

function claudeRequest_(apiKey, email) {
  return {
    url: 'https://api.anthropic.com/v1/messages',
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    payload: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: CLAUDE_SCHEMA } },
      system: EXTRACT_RULES,
      messages: [{ role: 'user', content: `From: ${email.from}\nSubject: ${email.subject}\n\n${email.body}` }],
    }),
  };
}

/** Returns {songs: [...]} or {error: "..."}. */
function parseClaudeResponse_(code, body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    return { error: `HTTP ${code}` };
  }
  if (code !== 200) return { error: (data.error && data.error.message) || `HTTP ${code}` };
  if (data.stop_reason === 'refusal') return { error: 'Claude declined this email' };
  if (data.stop_reason === 'max_tokens') return { error: 'the reply was cut off' };
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  try {
    const songs = JSON.parse(text).songs;
    if (!Array.isArray(songs)) return { error: 'unexpected reply' };
    return { songs };
  } catch (e) {
    return { error: 'unreadable reply' };
  }
}

// ---------------------------------------------------------------- No AI

function extractWithoutAi_(emails) {
  const songs = [];
  emails.forEach(email => {
    guessSongs_(email.body).forEach(s => songs.push(Object.assign({ from: email.from, guessed: true }, s)));
  });
  return songs;
}

const NOT_A_SONG = /^(hi|hey|hello|dear|thanks|thank you|best|cheers|love|regards|sincerely|sent from|here are|my (songs|picks|suggestions))\b/i;

/**
 * No-AI fallback: one song per line or sentence. "(...)" becomes the comment;
 * "Title - Artist" or "Title by Artist" splits title from artist.
 */
function guessSongs_(text) {
  const out = [];
  String(text).split('\n').forEach(line => {
    line.split(/[.!?;]\s+/).forEach(piece => {
      let s = piece.trim().replace(/^[-*•\d.)\s]+/, '').replace(/[.!?;]$/, '').trim();
      if (s.length < 2 || s.length > 150 || NOT_A_SONG.test(s)) return;
      const asWritten = s;
      const comments = [];
      s = s.replace(/\(([^)]*)\)/g, (_, c) => { comments.push(c.trim()); return ' '; }).trim();
      const split = s.match(/^(.+?)\s+(?:-|–|—|by)\s+(.+)$/i);
      out.push({
        as_written: asWritten,
        title: (split ? split[1] : s).trim(),
        artist: split ? split[2].trim() : '',
        comment: comments.filter(Boolean).join('; '),
      });
    });
  });
  return out;
}

// ===== Music.gs =====
/**
 * Spotify (sign-in, search, playlist), plus Apple Music and Amazon Music links.
 *
 * Spotify rules as of the February 2026 Web API changes: playlists are created
 * with POST /me/playlists, tracks added with POST /playlists/{id}/items, search
 * returns at most 10 results, and the app owner needs Spotify Premium.
 */

const SPOTIFY_SCOPES = 'playlist-modify-public playlist-modify-private';

// ---------------------------------------------------------------- Sign-in (OAuth)

/** The address Spotify sends you back to after sign-in. Differs for every copy of the sheet. */
function spotifyRedirectUri_() {
  return `https://script.google.com/macros/d/${ScriptApp.getScriptId()}/usercallback`;
}

function spotifyAuthUrl_() {
  const state = ScriptApp.newStateToken().withMethod('spotifyAuthCallback').withTimeout(3600).createToken();
  return 'https://accounts.spotify.com/authorize?' + toQuery_({
    client_id: getProp_('SPOTIFY_CLIENT_ID'),
    response_type: 'code',
    redirect_uri: spotifyRedirectUri_(),
    scope: SPOTIFY_SCOPES,
    state,
    show_dialog: 'true',
  });
}

/** Spotify redirects here after the user approves (routed by the state token). */
function spotifyAuthCallback(request) {
  const page = msg => HtmlService.createHtmlOutput(
    `<div style="font-family:Arial,sans-serif;font-size:16px;padding:24px">${msg}</div>`);
  if (request.parameter.error) {
    return page('Spotify didn\'t connect: ' + escapeHtml_(request.parameter.error) + '. Close this tab and try Setup again.');
  }
  try {
    saveSpotifyTokens_(spotifyTokenRequest_({
      grant_type: 'authorization_code',
      code: request.parameter.code,
      redirect_uri: spotifyRedirectUri_(),
    }));
  } catch (e) {
    return page('Spotify didn\'t connect: ' + escapeHtml_(e.message));
  }
  return page('✅ Spotify is connected. You can close this tab and go back to the sheet.');
}

function spotifyTokenRequest_(form) {
  const id = getProp_('SPOTIFY_CLIENT_ID');
  const secret = getProp_('SPOTIFY_CLIENT_SECRET');
  const res = UrlFetchApp.fetch('https://accounts.spotify.com/api/token', {
    method: 'post',
    payload: form,
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(`${id}:${secret}`) },
    muteHttpExceptions: true,
  });
  const data = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200) {
    throw new Error('Spotify sign-in failed: ' + (data.error_description || data.error || res.getResponseCode()));
  }
  return data;
}

function saveSpotifyTokens_(t) {
  const props = { SPOTIFY_ACCESS_TOKEN: t.access_token, SPOTIFY_EXPIRES_AT: String(Date.now() + (t.expires_in - 60) * 1000) };
  if (t.refresh_token) props.SPOTIFY_REFRESH_TOKEN = t.refresh_token; // Spotify may rotate it
  PropertiesService.getUserProperties().setProperties(props);
}

function spotifyConnected_() {
  return !!getProp_('SPOTIFY_REFRESH_TOKEN');
}

function spotifyAccessToken_() {
  if (!spotifyConnected_()) throw new Error('Spotify isn\'t connected yet. Open 🎵 Psalm Poll → Setup.');
  if (Date.now() < Number(getProp_('SPOTIFY_EXPIRES_AT'))) return getProp_('SPOTIFY_ACCESS_TOKEN');
  saveSpotifyTokens_(spotifyTokenRequest_({ grant_type: 'refresh_token', refresh_token: getProp_('SPOTIFY_REFRESH_TOKEN') }));
  return getProp_('SPOTIFY_ACCESS_TOKEN');
}

// ---------------------------------------------------------------- Spotify Web API

function spotifyApi_(method, path, body) {
  const opts = {
    method,
    headers: { Authorization: 'Bearer ' + spotifyAccessToken_() },
    muteHttpExceptions: true,
  };
  if (body) {
    opts.contentType = 'application/json';
    opts.payload = JSON.stringify(body);
  }
  let res = UrlFetchApp.fetch('https://api.spotify.com/v1' + path, opts);
  if (res.getResponseCode() === 429) {
    const wait = Number(res.getHeaders()['Retry-After'] || 2);
    Utilities.sleep(Math.min(wait, 30) * 1000);
    res = UrlFetchApp.fetch('https://api.spotify.com/v1' + path, opts);
  }
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code >= 300) {
    let msg = text;
    try { msg = JSON.parse(text).error.message; } catch (e) { /* keep raw text */ }
    throw new Error(`Spotify error (${code}): ${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

/** Best Spotify match for free text, or null. */
function spotifySearch_(query) {
  query = String(query || '').trim();
  if (!query) return null;
  const data = spotifyApi_('get', '/search?' + toQuery_({ q: query, type: 'track', limit: 5 }));
  const item = data.tracks && data.tracks.items && data.tracks.items[0];
  return item ? trackInfo_(item) : null;
}

function spotifyTrack_(id) {
  return trackInfo_(spotifyApi_('get', '/tracks/' + encodeURIComponent(id)));
}

function trackInfo_(t) {
  const artists = (t.artists || []).map(a => a.name);
  return {
    id: t.id,
    title: t.name,
    artist: artists.join(', '),
    firstArtist: artists[0] || '',
    url: `https://open.spotify.com/track/${t.id}`,
  };
}

/** Track ID from an open.spotify.com/track/... link or spotify:track:... URI, else ''. */
function spotifyTrackId_(link) {
  const m = String(link).match(/(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/|spotify:track:)([A-Za-z0-9]{22})/);
  return m ? m[1] : '';
}

/** Creates a public playlist (so the link works for everyone) and returns its link. */
function createPlaylist_(name, description, trackIds) {
  const playlist = spotifyApi_('post', '/me/playlists', { name, description, public: true });
  for (let i = 0; i < trackIds.length; i += 100) {
    spotifyApi_('post', `/playlists/${playlist.id}/items`, {
      uris: trackIds.slice(i, i + 100).map(id => 'spotify:track:' + id),
    });
  }
  return playlist.external_urls.spotify;
}

// ---------------------------------------------------------------- Other platforms

/**
 * Amazon has no public song lookup, so this opens an Amazon Music search for
 * the song; the song is normally the top result.
 */
function amazonMusicLink_(title, artist) {
  return 'https://music.amazon.com/search/' + encodeURIComponent(`${title} ${artist || ''}`.trim());
}

// Apple links come from Apple's free song search, which goes straight to the
// song. It rate-limits, so after one refusal we switch to search links.
let appleSearchBlocked_ = false;

function appleMusicLink_(title, artist) {
  const term = `${title} ${artist || ''}`.trim();
  const searchPage = 'https://music.apple.com/us/search?term=' + encodeURIComponent(term);
  if (appleSearchBlocked_) return searchPage;
  try {
    const res = UrlFetchApp.fetch('https://itunes.apple.com/search?' +
      toQuery_({ term, entity: 'song', limit: 1, country: 'US' }), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      appleSearchBlocked_ = true;
      return searchPage;
    }
    const hit = (JSON.parse(res.getContentText()).results || [])[0];
    return hit && hit.trackViewUrl ? hit.trackViewUrl.replace(/[?&]uo=\d+/, '') : searchPage;
  } catch (e) {
    appleSearchBlocked_ = true;
    return searchPage;
  }
}

// ===== Poll.gs =====
/**
 * Google Form poll + private live results tab with a bar chart.
 *
 * Voters only ever see the form. Responses land in this spreadsheet, which
 * stays private to its owner, and the form's summary charts are turned off.
 */

function createPoll_(songs, settings, pollTitle, playlistUrl, stamp) {
  const ssId = SpreadsheetApp.getActive().getId();
  const form = FormApp.create(pollTitle);
  form.setDescription(pollDescription_(settings, playlistUrl));
  form.setLimitOneResponsePerUser(true); // voters sign in with Google; one vote per account (emails not collected)
  form.setAllowResponseEdits(false);
  form.setPublishingSummary(false);
  form.setShowLinkToRespondAgain(false);
  form.setConfirmationMessage('Thanks for voting!');

  const required = isYes_(settings['Answer required for every song']);
  songs.forEach(s => {
    form.addMultipleChoiceItem()
      .setTitle(s.question)
      .setHelpText(songLinksText_(s))
      .setChoiceValues(['Yes', 'No'])
      .setRequired(required);
  });

  // Find the new responses tab by comparing which tabs are linked to a form before and after.
  const linkedBefore = linkedSheetIds_(SpreadsheetApp.openById(ssId));
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ssId);
  SpreadsheetApp.flush();

  // Forms made by scripts start unpublished (since June 30, 2026) and only open
  // to people they're shared with, so publish and open it to anyone with the link.
  form.setPublished(true);
  shareFormWithAnyone_(form);

  const ss = SpreadsheetApp.openById(ssId);
  const respSheet = ss.getSheets().find(sh => sh.getFormUrl() && linkedBefore.indexOf(sh.getSheetId()) === -1);
  if (!respSheet) throw new Error('The poll was made, but its responses tab couldn\'t be found. Edit form: ' + form.getEditUrl());
  respSheet.setName(uniqueSheetName_(ss, `Responses ${stamp}`));

  const resultsSheet = createResultsSheet_(ss, respSheet, songs, uniqueSheetName_(ss, `Results ${stamp}`));

  let voteUrl = form.getPublishedUrl();
  try { voteUrl = form.shortenFormUrl(voteUrl); } catch (e) { /* long link still works */ }
  return { voteUrl, editUrl: form.getEditUrl(), resultsSheet };
}

/** The three listen links under each question (Forms makes the addresses clickable). */
function songLinksText_(s) {
  const amazon = s.amazon || amazonMusicLink_(s.title, s.artist);
  return [`Spotify: ${s.spotify}`, `Apple Music: ${s.apple}`, `Amazon Music: ${amazon}`]
    .filter(line => !/: $/.test(line))
    .join('\n');
}

function pollDescription_(settings, playlistUrl) {
  const lines = [
    'Vote Yes or No on each song. Use the links under each song to listen first.',
    '',
    `Spotify playlist: ${playlistUrl}`,
  ];
  const apple = String(settings['Apple Music playlist link'] || '').trim();
  const amazon = String(settings['Amazon Music playlist link'] || '').trim();
  if (apple) lines.push(`Apple Music playlist: ${apple}`);
  if (amazon) lines.push(`Amazon Music playlist: ${amazon}`);
  return lines.join('\n');
}

/** Drive permission that makes a published form answerable by anyone with the link. */
function shareFormWithAnyone_(form) {
  try {
    // Drive advanced service (v3, enabled in appsscript.json).
    Drive.Permissions.create({ type: 'anyone', role: 'reader', view: 'published' }, form.getId());
  } catch (e) {
    throw new Error('The poll was made but couldn\'t be opened to anyone with the link. Open ' + form.getEditUrl() +
      ', click Publish, and set Responders to "Anyone with the link". Details: ' + e.message);
  }
}

function linkedSheetIds_(ss) {
  return ss.getSheets().filter(sh => sh.getFormUrl()).map(sh => sh.getSheetId());
}

/**
 * Results tab: Yes/No counts per song (formulas that read the responses tab,
 * so they update on every submission), a sorted copy, and a bar chart of it.
 */
function createResultsSheet_(ss, respSheet, songs, name) {
  const sh = ss.insertSheet(name, 0);
  const n = songs.length;
  const ref = `'${respSheet.getName().replace(/'/g, "''")}'`;
  // Timestamp + one column per song (+ spare), so the formulas' range covers every question.
  const needCols = n + 3;
  if (respSheet.getMaxColumns() < needCols) {
    respSheet.insertColumnsAfter(respSheet.getMaxColumns(), needCols - respSheet.getMaxColumns());
  }
  const last = columnLetter_(respSheet.getMaxColumns());

  sh.getRange(1, 1, 1, 5).setValues([['Song', 'Yes', 'No', '', 'Question text']]);
  sh.getRange(2, 1, n, 5).setValues(songs.map((s, i) => {
    const r = i + 2;
    // Response columns are named after the question; escape MATCH wildcards (~ * ?) in the text.
    const col = `INDEX(${ref}!$A:$${last},0,MATCH(REGEXREPLACE($E${r},"([~*?])","~$1"),${ref}!$A$1:$${last}$1,0))`;
    return [safeText_(s.label), `=IFERROR(COUNTIF(${col},"Yes"),0)`, `=IFERROR(COUNTIF(${col},"No"),0)`, '', safeText_(s.question)];
  }));

  sh.getRange('G1:H1').setValues([['Song', 'Yes votes']]);
  sh.getRange('G2').setFormula(`=SORT(A2:B${n + 1},2,FALSE,1,TRUE)`);
  sh.getRange('J1').setValue('Votes so far');
  sh.getRange('J2').setFormula(`=MAX(0,COUNTA(${ref}!A:A)-1)`);

  sh.getRange('A1:J1').setFontWeight('bold');
  sh.setColumnWidth(1, 300);
  sh.setColumnWidth(7, 300);
  sh.setFrozenRows(1);
  sh.hideColumns(5);

  const chart = sh.newChart()
    .asBarChart()
    .addRange(sh.getRange(1, 7, n + 1, 2))
    .setNumHeaders(1)
    .setTitle('Most wanted songs (Yes votes)')
    .setLegendPosition(Charts.Position.NONE)
    .setOption('width', 720)
    .setOption('height', Math.max(320, 80 + n * 28))
    .setPosition(4, 10, 0, 0)
    .build();
  sh.insertChart(chart);
  return sh;
}

function uniqueSheetName_(ss, base) {
  let name = base;
  for (let i = 2; ss.getSheetByName(name); i++) name = `${base} (${i})`;
  return name;
}

/** 1 -> A, 27 -> AA */
function columnLetter_(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

// ===== Setup.gs =====
/**
 * One-time setup dialog. Keys are stored in this user's private script
 * properties - never in the sheet - so making a copy of the sheet for a
 * friend doesn't hand them your keys.
 */

function showSetup() {
  withFriendlyErrors_(() => {
    ensureSheets_();
    // SETUP_HTML is src/Setup.html, built into Code.gs by build.js so there's one less file to paste.
    const t = HtmlService.createTemplate(SETUP_HTML);
    t.redirectUri = spotifyRedirectUri_();
    t.status = setupStatus_();
    SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(560).setHeight(620), 'Psalm Poll setup');
  });
}

/** Called from the dialog. Blank fields keep what's already saved. */
function saveSetup(form) {
  const props = PropertiesService.getUserProperties();
  const updates = {};
  if (form.clientId.trim()) updates.SPOTIFY_CLIENT_ID = form.clientId.trim();
  if (form.clientSecret.trim()) updates.SPOTIFY_CLIENT_SECRET = form.clientSecret.trim();
  if (form.geminiKey.trim()) updates.GEMINI_API_KEY = form.geminiKey.trim();
  if (form.claudeKey.trim()) updates.CLAUDE_API_KEY = form.claudeKey.trim();
  if (form.removeClaude) props.deleteProperty('CLAUDE_API_KEY');
  if (updates.SPOTIFY_CLIENT_ID || updates.SPOTIFY_CLIENT_SECRET) {
    // New Spotify app details mean the old sign-in no longer applies.
    ['SPOTIFY_ACCESS_TOKEN', 'SPOTIFY_REFRESH_TOKEN', 'SPOTIFY_EXPIRES_AT'].forEach(k => props.deleteProperty(k));
  }
  props.setProperties(updates);
  const status = setupStatus_();
  status.authUrl = status.hasClientId && status.hasSecret ? spotifyAuthUrl_() : '';
  return status;
}

function setupStatus_() {
  return {
    hasClientId: !!getProp_('SPOTIFY_CLIENT_ID'),
    hasSecret: !!getProp_('SPOTIFY_CLIENT_SECRET'),
    hasGemini: !!getProp_('GEMINI_API_KEY'),
    hasClaude: !!getProp_('CLAUDE_API_KEY'),
    spotifyConnected: spotifyConnected_(),
  };
}

// ===== Setup.html =====
const SETUP_HTML = "<!DOCTYPE html>\n<html>\n<head>\n  <base target=\"_top\">\n  <style>\n    body { font-family: Arial, sans-serif; font-size: 13px; line-height: 1.5; color: #202124; margin: 0; }\n    h3 { font-size: 14px; margin: 16px 0 4px; }\n    ol { padding-left: 18px; margin: 4px 0; }\n    label { display: block; margin-top: 8px; font-weight: bold; }\n    input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: 6px; font-size: 13px; }\n    .uri { display: flex; gap: 6px; }\n    .uri input { flex: 1; font-family: monospace; font-size: 12px; }\n    .ok { color: #188038; font-weight: normal; }\n    .hint { color: #5f6368; font-weight: normal; }\n    button { margin-top: 12px; padding: 8px 16px; font-size: 13px; cursor: pointer; }\n    #connect { display: none; margin-top: 12px; padding: 12px; background: #e6f4ea; border-radius: 6px; }\n    #connect a { font-weight: bold; font-size: 14px; }\n    #msg { margin-top: 8px; color: #d93025; }\n  </style>\n</head>\n<body>\n  <h3>1. Make a Spotify app (one time)</h3>\n  <ol>\n    <li>Go to <a href=\"https://developer.spotify.com/dashboard\" target=\"_blank\">developer.spotify.com/dashboard</a>, log in, and click <b>Create app</b>.</li>\n    <li>Any name and description. Under <b>Redirect URIs</b>, paste this and click Add:\n      <div class=\"uri\"><input id=\"uri\" type=\"text\" readonly value=\"<?= redirectUri ?>\"><button type=\"button\" style=\"margin:0\" onclick=\"copyUri()\">Copy</button></div>\n    </li>\n    <li>Tick <b>Web API</b>, agree to the terms, and save.</li>\n    <li>Open the app's <b>Settings</b> and copy the Client ID and Client secret into the boxes below.</li>\n  </ol>\n\n  <label>Spotify Client ID <span class=\"hint\" id=\"s-id\"></span></label>\n  <input id=\"clientId\" type=\"text\" autocomplete=\"off\">\n  <label>Spotify Client secret <span class=\"hint\" id=\"s-secret\"></span></label>\n  <input id=\"clientSecret\" type=\"password\" autocomplete=\"off\">\n\n  <h3>2. Free Gemini API key (recommended)</h3>\n  <div class=\"hint\">Lets the script understand messy emails, for free. Go to\n    <a href=\"https://aistudio.google.com/apikey\" target=\"_blank\">aistudio.google.com/apikey</a>, sign in with Google,\n    click <b>Create API key</b>, and paste it here. No credit card needed.\n    Without a key the script guesses one song per line or sentence and you fix more by hand.</div>\n  <label>Gemini API key <span class=\"hint\" id=\"s-gemini\"></span></label>\n  <input id=\"geminiKey\" type=\"password\" autocomplete=\"off\">\n\n  <details style=\"margin-top:10px\">\n    <summary class=\"hint\" style=\"cursor:pointer\">Use Claude instead (paid, a few cents per run)</summary>\n    <div class=\"hint\">If a Claude key is saved it's used instead of Gemini. Get one at\n      <a href=\"https://console.anthropic.com/settings/keys\" target=\"_blank\">console.anthropic.com</a>.</div>\n    <label>Claude API key <span class=\"hint\" id=\"s-claude\"></span></label>\n    <input id=\"claudeKey\" type=\"password\" autocomplete=\"off\">\n    <label class=\"hint\" id=\"rm-claude\" style=\"display:none;font-weight:normal\"><input type=\"checkbox\" id=\"removeClaude\"> Remove the saved Claude key (go back to Gemini)</label>\n  </details>\n\n  <button id=\"save\" onclick=\"save()\">Save</button>\n  <div id=\"msg\"></div>\n\n  <div id=\"connect\">\n    <h3 style=\"margin-top:0\">3. Connect your Spotify account</h3>\n    <a id=\"authLink\" href=\"#\" target=\"_blank\">Connect Spotify →</a>\n    <div class=\"hint\">Opens a new tab. Approve it, close that tab, and you're done.</div>\n  </div>\n\n  <script>\n    const initial = <?!= JSON.stringify(status) ?>;\n\n    function show(status) {\n      const saved = '<span class=\"ok\">✓ saved - leave blank to keep</span>';\n      document.getElementById('s-id').innerHTML = status.hasClientId ? saved : '';\n      document.getElementById('s-secret').innerHTML = status.hasSecret ? saved : '';\n      document.getElementById('s-gemini').innerHTML = status.hasGemini ? saved : '';\n      document.getElementById('s-claude').innerHTML = status.hasClaude ? saved : '';\n      document.getElementById('rm-claude').style.display = status.hasClaude ? 'block' : 'none';\n      document.getElementById('removeClaude').checked = false;\n      if (status.authUrl) {\n        document.getElementById('authLink').href = status.authUrl;\n        document.getElementById('authLink').textContent =\n          status.spotifyConnected ? 'Spotify is connected ✓ (click to reconnect)' : 'Connect Spotify →';\n        document.getElementById('connect').style.display = 'block';\n      }\n    }\n\n    function save() {\n      const btn = document.getElementById('save');\n      btn.disabled = true;\n      document.getElementById('msg').textContent = '';\n      google.script.run\n        .withSuccessHandler(status => {\n          btn.disabled = false;\n          ['clientId', 'clientSecret', 'geminiKey', 'claudeKey'].forEach(id => document.getElementById(id).value = '');\n          show(status);\n          if (!status.authUrl) document.getElementById('msg').textContent = 'Add both the Spotify Client ID and secret.';\n        })\n        .withFailureHandler(err => {\n          btn.disabled = false;\n          document.getElementById('msg').textContent = err.message;\n        })\n        .saveSetup({\n          clientId: document.getElementById('clientId').value,\n          clientSecret: document.getElementById('clientSecret').value,\n          geminiKey: document.getElementById('geminiKey').value,\n          claudeKey: document.getElementById('claudeKey').value,\n          removeClaude: document.getElementById('removeClaude').checked,\n        });\n    }\n\n    function copyUri() {\n      const el = document.getElementById('uri');\n      el.select();\n      document.execCommand('copy');\n    }\n\n    show(initial);\n    if (initial.hasClientId && initial.hasSecret) {\n      // Already set up: get a fresh sign-in link without changing anything.\n      google.script.run.withSuccessHandler(show)\n        .saveSetup({ clientId: '', clientSecret: '', geminiKey: '', claudeKey: '', removeClaude: false });\n    }\n  </script>\n</body>\n</html>\n";
