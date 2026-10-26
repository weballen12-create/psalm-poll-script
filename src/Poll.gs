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
