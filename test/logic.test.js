// Tests the parts of the script that don't need Google, Spotify or Claude.
// Loads the bundled dist/Code.gs into a sandbox (which also catches syntax errors).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const gs = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'dist', 'Code.gs'), 'utf8'), gs);
const run = expr => vm.runInContext(expr, gs);
const plain = v => JSON.parse(JSON.stringify(v)); // sandbox objects -> local objects for deepEqual

const EMAIL_1 = 'Hardest Part - Olivia dean (pls it would be so cool)\nBeliever - Imagine dragons\nMissing you - Stephen Sanchez and Ash';
const EMAIL_2 = 'If its mean to be by florida georgia line. Cant tell it all remix with hulvey and kb. Whisper and the wind b CL by bodie.';

test('no-AI fallback: one song per line, parentheses become the comment', () => {
  assert.deepEqual(plain(gs.guessSongs_(EMAIL_1)), [
    { as_written: 'Hardest Part - Olivia dean (pls it would be so cool)', title: 'Hardest Part', artist: 'Olivia dean', comment: 'pls it would be so cool' },
    { as_written: 'Believer - Imagine dragons', title: 'Believer', artist: 'Imagine dragons', comment: '' },
    { as_written: 'Missing you - Stephen Sanchez and Ash', title: 'Missing you', artist: 'Stephen Sanchez and Ash', comment: '' },
  ]);
});

test('no-AI fallback: run-on email splits into sentences and "by" artists', () => {
  const songs = plain(gs.guessSongs_(EMAIL_2));
  assert.equal(songs.length, 3);
  assert.deepEqual(songs.map(s => [s.title, s.artist]), [
    ['If its mean to be', 'florida georgia line'],
    ['Cant tell it all remix with hulvey and kb', ''],
    ['Whisper and the wind b CL', 'bodie'],
  ]);
});

test('no-AI fallback skips greetings and sign-offs', () => {
  const songs = plain(gs.guessSongs_('Hi everyone!\nBeliever - Imagine Dragons\nThanks,\nSam'));
  assert.deepEqual(songs.map(s => s.title), ['Believer', 'Sam']);
});

test('subject words become a Gmail search with plurals, skipping your own mail', () => {
  const words = plain(gs.subjectWords_('guy, Girl ,duets,, male duet'));
  assert.deepEqual(words, ['guy', 'girl', 'duets', 'male duet']);
  assert.equal(gs.subjectQuery_(words), 'subject:(guy OR guys OR girl OR girls OR duets OR "male duet") -from:me');
  assert.ok(run('SETTINGS').find(s => s[0] === 'Subject words')[1].includes('secular'));
});

test('geminiRequest_ numbers the emails and asks for JSON', () => {
  const req = plain(gs.geminiRequest_('g', 'gemini-3.5-flash-lite', [
    { from: 'Ann', subject: 'Girl Christian', body: EMAIL_1 },
    { from: 'Ben', subject: 'Guy secular', body: EMAIL_2 },
  ]));
  const body = JSON.parse(req.payload);
  assert.equal(req.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.equal(req.headers['x-goog-api-key'], 'g');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  const text = body.contents[0].parts[0].text;
  assert.ok(text.includes('=== Email 1 ===\nFrom: Ann\nSubject: Girl Christian'));
  assert.ok(text.includes('=== Email 2 ===') && text.includes('florida georgia line'));
});

test('parseGeminiResponse_ reads songs and explains failures', () => {
  const ok = JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"songs":[{"email":2,"title":"If I\'m Meant to Be","artist":"Florida Georgia Line","comment":"","as_written":"If its mean to be by florida georgia line"}]}' }] } }] });
  assert.equal(plain(gs.parseGeminiResponse_(200, ok, 'm')).songs[0].email, 2);
  assert.match(gs.parseGeminiResponse_(429, '{"error":{"message":"quota"}}', 'm').error, /free limit/);
  assert.match(gs.parseGeminiResponse_(404, '{"error":{"message":"not found"}}', 'old-model').error, /old-model/);
  assert.equal(gs.parseGeminiResponse_(200, '{"promptFeedback":{"blockReason":"SAFETY"}}', 'm').error, 'Gemini blocked these emails');
  assert.equal(gs.parseGeminiResponse_(200, '{"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[{"text":"{"}]}}]}', 'm').error, 'the reply was cut off');
});

test('extractSongs_ uses Gemini when that is the only key, and maps songs back to senders', () => {
  const props = { GEMINI_API_KEY: 'g' };
  gs.PropertiesService = { getUserProperties: () => ({ getProperty: k => props[k] || null }) };
  const reply = { songs: [
    { email: 2, title: 'Believer', artist: 'Imagine Dragons', comment: '', as_written: 'Believer - Imagine dragons' },
    { email: 1, title: 'Hardest Part', artist: 'Olivia Dean', comment: 'pls it would be so cool', as_written: 'Hardest Part - Olivia dean (pls it would be so cool)' },
  ] };
  gs.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }) }) };
  const songs = plain(gs.extractSongs_([{ from: 'Ann', subject: 's', body: '' }, { from: 'Ben', subject: 's', body: '' }], {}));
  assert.deepEqual(songs.map(s => [s.from, s.title]), [['Ben', 'Believer'], ['Ann', 'Hardest Part']]);
});

test('cleanBody_ drops quoted replies and signatures', () => {
  const body = 'Believer - Imagine Dragons\n\nOn Tue, Sep 2, 2026 at 3:00 PM Club Leader <\nleader@example.com> wrote:\n> Send me songs!\n> Old Song - Old Artist';
  assert.equal(gs.cleanBody_(body), 'Believer - Imagine Dragons');
  assert.equal(gs.cleanBody_('Song A\n-- \nSam Smith\n555-1234'), 'Song A');
  assert.equal(gs.cleanBody_('Song A\n\nSent from my iPhone'), 'Song A');
  assert.equal(gs.cleanBody_('Song A\n> quoted\nSong B'), 'Song A\nSong B');
});

test('htmlToText_ keeps line breaks', () => {
  assert.equal(gs.htmlToText_('<div>Believer</div><div>Missing you &amp; more<br>Hi</div>'), 'Believer\nMissing you & more\nHi\n');
});

test('senderName_', () => {
  assert.equal(gs.senderName_('"Jane Doe" <jane@example.com>'), 'Jane Doe');
  assert.equal(gs.senderName_('Jane Doe <jane@example.com>'), 'Jane Doe');
  assert.equal(gs.senderName_('<jane@example.com>'), 'jane@example.com');
  assert.equal(gs.senderName_('jane@example.com'), 'jane@example.com');
});

test('parseClaudeResponse_ reads structured output and reports failures', () => {
  const ok = JSON.stringify({
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"songs":[{"title":"Believer","artist":"Imagine Dragons","comment":"","as_written":"Believer - Imagine dragons"}]}' }],
  });
  assert.deepEqual(plain(gs.parseClaudeResponse_(200, ok)).songs[0].title, 'Believer');
  assert.deepEqual(plain(gs.parseClaudeResponse_(401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}')), { error: 'invalid x-api-key' });
  assert.deepEqual(plain(gs.parseClaudeResponse_(200, '{"stop_reason":"refusal","content":[]}')), { error: 'Claude declined this email' });
  assert.deepEqual(plain(gs.parseClaudeResponse_(200, '{"stop_reason":"end_turn","content":[{"type":"text","text":"nope"}]}')), { error: 'unreadable reply' });
  assert.deepEqual(plain(gs.parseClaudeResponse_(502, '<html>bad gateway</html>')), { error: 'HTTP 502' });
});

test('claudeRequest_ asks for structured JSON', () => {
  const req = plain(gs.claudeRequest_('k', { subject: 'Songs', body: EMAIL_1 }));
  const body = JSON.parse(req.payload);
  assert.equal(req.headers['x-api-key'], 'k');
  assert.equal(body.model, 'claude-opus-5');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.ok(body.messages[0].content.includes('Hardest Part'));
});

test('spotifyTrackId_ accepts links and URIs', () => {
  assert.equal(gs.spotifyTrackId_('https://open.spotify.com/track/0pqnGHJpmpxLKifKRmU6WP?si=abc'), '0pqnGHJpmpxLKifKRmU6WP');
  assert.equal(gs.spotifyTrackId_('https://open.spotify.com/intl-de/track/0pqnGHJpmpxLKifKRmU6WP'), '0pqnGHJpmpxLKifKRmU6WP');
  assert.equal(gs.spotifyTrackId_('spotify:track:0pqnGHJpmpxLKifKRmU6WP'), '0pqnGHJpmpxLKifKRmU6WP');
  assert.equal(gs.spotifyTrackId_('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), '');
});

test('mergeSongs_ merges duplicates and keeps both comments in the question', () => {
  const row = (id, title, artist, comment) => {
    const r = new Array(run('NUM_COLS')).fill('');
    r[run('COL.MATCHED_ID') - 1] = id;
    r[run('COL.TITLE') - 1] = title;
    r[run('COL.ARTIST') - 1] = artist;
    r[run('COL.COMMENT') - 1] = comment;
    return r;
  };
  gs.rows = [
    row('a', 'Hardest Part', 'Olivia Dean', 'pls it would be so cool'),
    row('b', 'Believer', 'Imagine Dragons', ''),
    row('a', 'Hardest Part', 'Olivia Dean', 'love this one'),
  ];
  const songs = plain(run('mergeSongs_(rows)'));
  assert.equal(songs.length, 2);
  assert.equal(songs[0].question, 'Hardest Part – Olivia Dean (pls it would be so cool / love this one)');
  assert.equal(songs[0].label, 'Hardest Part – Olivia Dean');
  assert.equal(songs[0].spotify, 'https://open.spotify.com/track/a');
  assert.equal(songs[1].question, 'Believer – Imagine Dragons');
});

test('each poll question gets Spotify, Apple Music and Amazon Music links', () => {
  const text = gs.songLinksText_({
    title: 'Believer', artist: 'Imagine Dragons',
    spotify: 'https://open.spotify.com/track/0pqnGHJpmpxLKifKRmU6WP',
    apple: 'https://music.apple.com/us/album/believer/1411625594?i=1411628233',
    amazon: '',
  });
  assert.equal(text,
    'Spotify: https://open.spotify.com/track/0pqnGHJpmpxLKifKRmU6WP\n' +
    'Apple Music: https://music.apple.com/us/album/believer/1411625594?i=1411628233\n' +
    'Amazon Music: https://music.amazon.com/search/Believer%20Imagine%20Dragons');
  assert.ok(!gs.songLinksText_({ title: 'X', artist: '', spotify: 's', apple: '', amazon: 'a' }).includes('Apple'));
});

test('Setup page is built into Code.gs', () => {
  const html = run('SETUP_HTML');
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<?= redirectUri ?>') && html.includes('saveSetup'));
});

test('safeText_ and columnLetter_', () => {
  assert.equal(gs.safeText_('+44'), "'+44");
  assert.equal(gs.safeText_('Believer'), 'Believer');
  assert.equal(gs.safeText_(null), '');
  assert.equal(gs.columnLetter_(1), 'A');
  assert.equal(gs.columnLetter_(26), 'Z');
  assert.equal(gs.columnLetter_(27), 'AA');
  assert.equal(gs.columnLetter_(702), 'ZZ');
});
