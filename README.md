# Psalm Poll Script

An automation that turns emailed song suggestions into a Spotify playlist and a
Google Forms poll, with a results chart that updates live as people vote.
Built for a music club's song selection, it saves the club's leadership an
estimated **15+ hours per semester**.

## What it does

1. **Reads the suggestions from Gmail.** Only emails whose subject matches
   (e.g. "Guy secular", "Song poll") are read, with read-only access.
2. **Picks out the songs with an LLM.** The Gemini API turns messy, typo-filled
   emails into structured JSON: title, artist, and the sender's comment.
3. **Matches each song on Spotify** to get its official title and artist, then
   builds Spotify, Apple Music and Amazon Music links.
4. **Lets the organizer review** the list in a Google Sheet before anything is published.
5. **Publishes** a Spotify playlist and a Google Form with one Yes/No question
   per song (one vote per Google account).
6. **Charts the results** in a private bar chart, most-wanted song first.

## Built with

- **Claude Code**, AI-assisted development
- **JavaScript** on Google Apps Script
- **Gemini API**: LLM extraction with structured JSON output
- **Spotify Web API**: OAuth 2.0 sign-in with token refresh, search, playlists
- **Google Workspace**: Gmail API, Forms, Sheets, Drive
- **Node.js**: build script and unit tests (`npm test`)

## Privacy

- Gmail access is read-only, and only subject-matched emails are sent to the AI.
- API keys are stored per user in Apps Script properties, never in the sheet or this repo.
- Results are visible only to the poll owner. Voters' email addresses aren't collected.

## Setup

See **[docs/SETUP.md](docs/SETUP.md)** for the step-by-step guide.
