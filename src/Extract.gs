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
