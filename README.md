# Belt Call Log — PWA

Offline call logging app for belt quoting site visits. Runs in the phone browser, installs to the home screen, works with no signal.

## What's in here

| File | Purpose |
|---|---|
| `index.html` | All screens and styling |
| `app.js` | Logic: storage, xlsx import, call flow, compile, share |
| `sw.js` | Service worker — offline caching |
| `manifest.webmanifest` | Makes it installable |
| `logo.png` | Intralox logo in the app header |
| `icon-192.png`, `icon-512.png` | Home screen icons |
| `icon-maskable-512.png` | Padded icon for launchers that crop to a circle |

Filenames are case-sensitive on GitHub Pages and the manifest refers to them exactly. If you rename an icon, change the manifest to match, or it silently falls back to a screenshot of the page.

**No customer data is in this repo, and none should ever be committed.** Contacts are imported on the phone and stored in that phone's IndexedDB.

## Deploying to GitHub Pages

1. Create a repository on github.com — name it something like `belt-call-log`.
2. Upload all eight files to the root of the repo (Add file → Upload files → drag them in → Commit).
3. Settings → Pages → under "Build and deployment", set Source to **Deploy from a branch**, Branch to **main** and folder to **/ (root)**. Save.
4. Wait about a minute. The URL appears at the top of that same Pages screen, in the form `https://<username>.github.io/belt-call-log/`.

Pages redeploys automatically on every commit afterwards — there are no settings to touch again.

## Updating

Upload the changed files the same way. **The `CACHE` name in `sw.js` must be bumped every time** (`beltcall-v8` → `v9`), or the phone serves the old cached build and the update looks like it did nothing.

If an update still doesn't appear: close the app fully from the recents screen and reopen it. If it still doesn't, Chrome → Settings → Site settings → Storage → find the site → Clear & reset, which also wipes the contact database and saved calls.

## Installing on Android

1. Open the URL in Chrome.
2. Menu (⋮) → **Add to Home screen** → Install.
3. It now launches full screen with its own icon, like any app.

Reinstalling is not just removing the icon — an installed PWA is a real Android app. Long-press the icon → App info → Uninstall, then open the URL in Chrome by typing it in. Tapping an old link can route you straight back into the install.

## First run

1. In Dynamics, export the **ANZ Active Food Contacts** view as .xlsx.
2. Get the file onto the phone (email it to yourself, or save to OneDrive and download).
3. Open the app → Data → choose the file → **Import Dynamics export**.
4. It parses the sheet, deduplicates contacts and stores everything locally. The account manager list is built from whoever appears in the file, so any manager can use the same app with their own export.

Re-import any time the CRM changes. The new import replaces the old data.

The first load needs a working connection, because the spreadsheet parser is fetched from a CDN and cached. On a network that blocks CDNs, import will not work until the app has been opened once somewhere that doesn't.

## Running a call

- **New call** → pick date, call type, account manager → search the account. Search covers every account in the file; your own accounts sort to the top and other managers' accounts show a tag.
- **Contacts** → tick as many as needed. Anyone not on file goes in the free-text fields and is flagged in the notes as needing adding to Dynamics.
- **Call menu** → Belt, Project, General note, Health check, in any order.
- **Photos.** Every entry in the call log has its own Camera and Photos buttons, so you can walk the plant shooting freely and attach everything afterwards, in any order. The bottom bar buttons attach to the most recent entry as a shortcut. The **Loose photos** card at the bottom of the dashboard takes anything that doesn't belong to a single entry — those come out at the end of the notes under Additional photos. Both inputs accept multiple selections at once. Tap any thumbnail to delete that photo. Images resize to 1400px on the phone before storage.
- **Compile call notes** → Generate and share → pick OneDrive, Outlook or Teams from the Android share sheet.

The call is saved after every entry. Close the app, take a phone call, lose signal — it's all still there under **Resume call**.

Past calls can be deleted from the home screen with the bin button. It asks first, and tells you what will be erased.

## Known gaps

- **Account number** is not in the Dynamics export. When the view is re-exported with that column, it needs adding to the import mapping and the notes.
- **N/A vs blank** both render as an em dash. Rod material has an explicit N/A option as a partial fix; other fields don't distinguish.
- **Silent defaults** — belt and rod material default to Unknown, so an untouched dropdown logs as an answer.
- **Android back gesture** exits the app rather than stepping back a screen.
- **Untested at full scale.** A 5,723-row import has never been run on a phone. Parsing blocks the interface while it works, so give it a minute before assuming it has died.
- **EML output** was dropped: Android Outlook opens .eml in a browser rather than as a draft. HTML plus share sheet replaces it.
- **Photo size** — a call with ten photos produces roughly a 15–20 MB HTML file. Fine for OneDrive, large for email.
- **No AI** in this version. Dictating a belt in one breath and having it structured is a Claude-side feature only.

## If something breaks

Chrome on Android can be debugged from a desktop: plug the phone in, open `chrome://inspect` on the desktop, and the console is right there. The Application tab also shows the manifest and the service worker, which is where install and caching problems surface.

Storage failures are reported on the home screen under **Contact database** rather than left silent, so check there first.

To wipe local data: Chrome → Settings → Site settings → Storage → find the site → Clear. That removes the contact database and every saved call, so compile anything you need first.
