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
