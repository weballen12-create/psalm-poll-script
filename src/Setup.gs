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
