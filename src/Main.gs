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
