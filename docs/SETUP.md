# 🎵 Psalm Poll Script

**What it does:** reads the song suggestions people email you, makes a Spotify
playlist of them, and makes a Google Form where everyone votes Yes or No on each
song. A bar chart shows you which songs are winning, and it updates every time
someone votes.

It lives inside a Google Sheet. It's free, and there's nothing to install.

**Contents**
- [Before you start](#before-you-start)
- [Part 1: Set it up (once, about 20 minutes)](#part-1-set-it-up-once-about-20-minutes)
- [Part 2: Make a poll (every time, about 2 minutes)](#part-2-make-a-poll-every-time-about-2-minutes)
- [Sharing it with a friend](#sharing-it-with-a-friend)
- [Good to know](#good-to-know)
- [Something went wrong?](#something-went-wrong)

---

## Before you start

You need:

- ✅ **The Gmail account that receives the song emails.** Set everything up in this account.
- ✅ **Spotify Premium.** Spotify requires it for apps like this one.
- ✅ **A computer** (not a phone) for setup.

> ### ⚠️ Important: the club account must be your *default* Google account
>
> If you're signed in to more than one Google account in your browser, Google
> treats the **first one you signed in with** as your *default*. The script
> always runs as the default account. If that's not the club account, setup fails
> with errors like **"Sorry, unable to open the file at this time."**
>
> **How to fix it (you can stay signed in to your other accounts):**
> 1. Click your profile picture in Gmail → **Sign out of all accounts**.
> 2. Sign in to the **club Gmail account first**.
> 3. Add your other accounts back (profile picture → **Add another account**).
>
> **Or** make a separate Chrome profile just for the club account (click your
> profile icon at the top right of Chrome → **Add**). Its window only has the club
> account, and your normal window keeps everything else.

---

## Part 1: Set it up (once, about 20 minutes)

### Step 1: Make the Google Sheet

1. Go to **[sheets.new](https://sheets.new)**. A blank Google Sheet opens.
2. Click **Untitled spreadsheet** at the top left and rename it **Psalm Poll Script**.

### Step 2: Paste in the script

You'll copy 2 files from the `dist` folder into Google's script editor.

1. In the sheet, click **Extensions → Apps Script**. A code editor opens in a new tab.
2. Click the ⚙️ **gear icon** (Project Settings) on the left.
   Tick ☑️ **Show "appsscript.json" manifest file in editor**.
3. Click the **< >** icon (Editor) on the left to go back to the code.
4. Paste the files. For each one, right-click it in the `dist` folder → **Open with → Notepad**,
   press **Ctrl+A** then **Ctrl+C** to copy it all, and paste it into the matching file in the editor:

   | File from `dist` | Where to paste it | It should start with |
   |---|---|---|
   | `Code.gs` | Click **Code.gs** in the editor, press **Ctrl+A**, and paste over it. | `// Psalm Poll Script` |
   | `appsscript.json` | Click **appsscript.json**, press **Ctrl+A**, and paste over it. | `{` then `"timeZone"` |

   ⚠️ Make sure each file goes into the file with the **same name**. Mixing them up
   causes errors like *"Unexpected token ':'"*.

5. Press **Ctrl+S** to save.
6. Go back to the sheet's tab and **reload the page**. After a few seconds, a
   **🎵 Psalm Poll** menu appears at the top.

### Step 3: Give it permission

1. Click **🎵 Psalm Poll → Setup (Spotify & keys)**.
2. Google asks for permission. Click **Continue** and pick the club account.
3. You'll see **"Google hasn't verified this app."** That's normal, because you wrote
   this script yourself and haven't sent it to Google for review.
   Click **Advanced → Go to Psalm Poll Script (unsafe) → Allow**.
4. If the Setup window didn't open, click **🎵 Psalm Poll → Setup** again.

<details>
<summary>What is it asking permission for?</summary>

| It asks to… | Because… |
|---|---|
| Read your email | To find the song emails. It's **read-only**: it can't send, change, or delete anything. |
| Use Google Sheets | To write the songs and results into this sheet. |
| Use Google Forms | To create the poll. |
| Use Drive files it created | To let anyone with the link open the poll. |
| Connect to outside services | To talk to Spotify, Gemini, and Apple Music search. |

</details>

### Step 4: Fill in the Setup window

The Setup window has three parts. Do them in order.

**A. Make a Spotify app**
1. Go to **[developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)** and log in with your Spotify account.
2. Click **Create app**. Any name and description are fine.
3. Under **Redirect URIs**, paste the address shown in the Setup window (use its **Copy** button) and click **Add**.
4. Tick **Web API**, agree to the terms, and click **Save**.
5. Open your new app's **Settings**. Copy the **Client ID** and **Client secret** into the Setup window.

**B. Get a free Gemini key.** Gemini is Google's AI; it reads the emails and picks out the songs.
1. Go to **[aistudio.google.com/apikey](https://aistudio.google.com/apikey)** and sign in.
2. Click **Create API key**, copy it, and paste it into the Setup window. No credit card is needed.

**C. Click Save, then click Connect Spotify →.** Approve it in the tab that opens, then close that tab.

### Step 5: Check the Settings tab

Open the **Settings** tab in your sheet. The yellow cells are yours to change:

- **Emails after:** the script reads emails from this date up to today.
- **Subject words:** only emails whose subject contains one of these words are read.
  The default is *guy, girl, male, female, duet, trio, secular, christian, song, poll*.
  Plurals count too, so "songs" matches "song". If people start using a new kind
  of subject, add the word.
- **Poll title**, **Playlist name**, and the rest are optional.

🎉 **Setup is done.** Before your first real poll, see [Sharing it with a friend](#sharing-it-with-a-friend):
if you want to share it later, now is the time to make a clean copy.

---

## Part 2: Make a poll (every time, about 2 minutes)

**1. Set the date.** In the **Settings** tab, change **Emails after** to the date
you want to start from.

**2. Find the songs.** Click **🎵 Psalm Poll → 1. Find songs in email.**
The **Songs** tab fills up with every suggestion, who sent it, what they wrote,
and the song it matched on Spotify.

**3. Check the list.** It takes a minute:
- **Not a real suggestion?** Uncheck its box.
- **Wrong song matched?** Either paste the correct Spotify song link into
  **Spotify link**, or fix the **Song title**/**Artist** and delete the Spotify link.
  Then click **🎵 Psalm Poll → 2. Re-check songs I edited**.
- **A song is missing?** Type its title and artist in an empty row, then run step 2.
- **Comment (shown in poll)** appears in brackets after the song name. Edit it if you like.
- If two people suggested the same song, it becomes one question with both comments.

**4. Build it.** Click **🎵 Psalm Poll → 3. Build playlist & poll.**
A window shows the **voting link**. Send that to the club.

**5. Watch the results.** A new **Results** tab has a bar chart of the Yes votes,
sorted from most to least popular. It updates every time someone votes.
Only you can see it.

---

## Sharing it with a friend

Your keys and Spotify connection are saved to *your* Google account, not in the
sheet, so copying the sheet never shares them.

1. **Make a clean copy before your first poll:** **File → Make a copy**, and name it
   something like *Psalm Poll Script (template)*. Share that copy.
   (A copy of a sheet you've already used includes your songs and results.)
2. Your friend opens the template, clicks **File → Make a copy**, and follows
   **Part 1, Steps 3–5** with their own accounts. They need:
   - The club account as their default Google account ([see above](#before-you-start))
   - Spotify Premium, and their **own** Spotify app
   - Their **own** free Gemini key

---

## Good to know

**🗳️ One vote per person.** Voters sign in with Google, and each account can vote
once. Their email address isn't collected, so votes stay anonymous to you. People
without a Google account need to make a free one. To test voting more than once
yourself, use a second Google account.

**🔒 Results are private.** Voters only see the form, never the results. The
results live in your sheet, which only you can open unless you share it.

**🎧 Listen links.** Each song in the poll has three links: **Spotify** and **Apple Music**
go straight to the song. **Amazon Music** opens a search with the song at the top,
because Amazon has no public way to look up a song's exact page.

**🍎 Apple Music and Amazon Music playlists** can't be made automatically.
If you want them, convert the Spotify playlist with a free site like
[TuneMyMusic](https://www.tunemymusic.com) *before* step 4, and paste the links into
the **Settings** tab. They'll show at the top of the poll.

**🤖 About Gemini's free tier.** Only the emails that match your subject words are
sent to Gemini; the rest of your inbox is never sent anywhere. On the free tier,
Google may use what's sent to improve its products. A poll uses only 2–3 of the
free daily requests.

**📬 Limits.** The script reads up to 150 matching emails per poll. Your own sent
emails are always skipped.

---

## Something went wrong?

**"Sorry, unable to open the file at this time," or the Setup window or menu gives errors**
→ The club account isn't your default Google account. See [the fix above](#before-you-start).

**No 🎵 Psalm Poll menu**
→ Reload the sheet and wait a few seconds.

**"Spotify isn't connected"**
→ Open **🎵 Psalm Poll → Setup** and click **Connect Spotify**.

**Spotify says "INVALID_CLIENT: Invalid redirect URI"**
→ The Redirect URI in your Spotify app must exactly match the one in the Setup
window. Copy it again with the **Copy** button.

**"Spotify error (403)"**
→ In the Spotify dashboard, open your app → **User Management** and add your own
Spotify email. Also check the account that made the app has Premium.

**"Gemini's free limit is used up"**
→ Wait a minute and try step 1 again. If it still fails, try tomorrow; the limit resets daily.

**"Gemini has no model called …"**
→ Google replaced the model. Find a current **Flash-Lite** model name at
[ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models)
and put it in **Settings → Gemini model**.

**A song email was missed**
→ Its subject didn't contain any of your **Subject words**. Add the word to Settings,
or type the song into the Songs tab and run step 2.

**Using Claude instead of Gemini?**
→ It's under "Use Claude instead" in the Setup window (paid, a few cents per poll).
If the script reports a credit error, add credit at console.anthropic.com → Billing.

---

<details>
<summary>For developers</summary>

The source code is in `src/`. `npm test` bundles it into `dist/` (`node build.js`)
and runs the logic tests in `test/` with Node's built-in test runner. After
changing anything in `src/`, run `npm test`, then paste `dist/Code.gs` into the
Apps Script editor again.

</details>
