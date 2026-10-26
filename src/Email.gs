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
