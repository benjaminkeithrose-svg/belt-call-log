# Belt Call Log — Android app project instructions

Paste into the project's custom instructions, or keep in the project library as the build spec. This project covers the standalone PWA only. The chat-based widget workflow is a separate project and the two should not be merged.

## 1. What this project is

A progressive web app for logging belt quoting site calls on an Android phone. Installed to the home screen from Chrome, runs offline, holds all data locally on the device. Branded to the Intralox Global Brand Guidelines.

**Scope boundary.** There is a parallel project running the same workflow as inline widgets inside a Claude conversation. That version has an AI in the loop: it can take a belt dictated in one breath and structure it into fields, and it compiles output with Python. This project has neither. It is a pure form app. When a request would only make sense in the chat version, say so rather than building it here.

The user is an engineer, not a developer. He can read code and follow the logic, but he does not run a build toolchain, apply patches, or use git from a terminal. He uploads files to GitHub through the web interface by dragging them in.

**Therefore:** always deliver complete, ready-to-upload files. Never a diff, never "add this function to app.js", never a snippet to paste at line 340. If one line changes in app.js, the whole of app.js is re-delivered and presented as a file. Say plainly which files changed so he knows what to re-upload.

## 2. Architecture

Eight files, no build step, no framework, no npm.

| File | Purpose |
| --- | --- |
| `index.html` | All screens as `<section class="scr">` blocks, plus all CSS |
| `app.js` | Everything else: storage, imports, navigation, entries, compile, share |
| `sw.js` | Service worker, cache-first, makes it work offline |
| `manifest.webmanifest` | Installability, name, icons, standalone display |
| `logo.png` | Intralox standard logo, header masthead |
| `icon192.png`, `icon512.png` | Home screen icons, purpose `any` |
| `iconmaskable512.png` | Padded variant, purpose `maskable`, survives launcher cropping |

**Icon filenames are unhyphenated.** The manifest previously asked for `icon-192.png` while the repo held `icon192.png`, and the icons 404'd silently for weeks. The manifest has been corrected to match the repo rather than the reverse. Check the manifest and the repo agree whenever either changes.

**Icons must be real PNGs at exactly the declared size.** Every image in the repo was once a JPEG carrying a `.png` extension, at 196×196 and 532×532 rather than 192 and 512. GitHub Pages serves by extension, so the bytes said JPEG while the header said `image/png`. Chrome rejects a manifest icon on either a type mismatch or a size mismatch, and the symptom is an empty icon and an install that does not complete — with nothing useful in the console. All four images have been re-encoded as genuine PNGs at the declared dimensions. If an icon is ever regenerated, verify the magic bytes and the pixel dimensions, not just the filename.

The maskable icon carries the artwork at 80% scale on a white ground, because launchers crop maskable icons to a circle and the previous file had no safe zone.

One external dependency: SheetJS (`xlsx@0.18.5`) from jsDelivr, for parsing both imports. Cached by the service worker on first load so it works offline afterwards. It is the only thing fetched from the network at runtime.

Navigation is screen-swapping, not routing. `go(name)` hides every `.scr` and shows `s-<name>`. The back button in the header is context-aware. There is no URL history; the Android back gesture will exit the app rather than move back a screen. This is a known rough edge, not a bug to be surprised by.

State lives in IndexedDB (`beltcall` database):

- `kv` store, key `data` — the parsed contact database
- `kv` store, key `beltref` — the parsed belt reference catalogue
- `kv` store, key `usage` — how often each picker value has been chosen
- `calls` store, keyed by `id` — every call, open or closed

`saveCall()` runs after every entry, photo and deletion. Nothing is held only in memory, so the app can be closed or killed mid-call without loss.

The storage layer is promise-gated. `openDB()` returns a cached promise, handles `onblocked`, and clears itself on failure so the next attempt retries rather than poisoning the session. Every store operation awaits `ready()` before touching `db`. Boot catches storage failure and prints the reason on the home screen. Persistent storage is requested at boot via `navigator.storage.persist()` so Chrome does not treat the databases as evictable cache.

Do not reintroduce a bare `db.transaction(...)` that assumes the global is populated. An earlier build did, and the symptom surfaced minutes later as an unrelated-looking import failure.

## 3. Branding

Follows the digital specifications in the Intralox Global Brand Guidelines. The guidelines PDF and the PANTONE 1795 logo are in the project library.

Light layout ratio — white dominant, dark grey and cyan secondary, red about 5%.

| Role | Hex | Guideline name |
| --- | --- | --- |
| Brand red | `#ED1C24` | `$intralox-red` — logo, header rule, footer rule only |
| Dark grey | `#4D4D4F` | Intralox Dark Gray, secondary text |
| Footer grey | `#363738` | `$ox-footer-color`, the bottom bar |
| Cyan | `#479EBC` | accents, card left borders, used-value chips |
| Cyan tints | `#ACD3E1`, `#E3F0F5` | rules, table headers, active segments and chips |
| Primary action | `#00287B` | `$ox-blue`, buttons |
| Link / focus | `#0377BA`, `#0084BB` | inline actions, input focus |
| Error | `#B2232F` | destructive actions, field alerts |
| Warning | `#FF9A3C` | width and frame check warnings |
| OK | `#237F35` | width check pass |
| Inputs | `#F7F8F8` bg, `#E3E3E3` border, `#9E9E9E` placeholder | input colours |
| Text | `#222222` | `$ox-text-color` |

Brand colours carry no action meaning in the guidelines, so red is never a button. Actions are `#00287B`; destructive actions are the error colour.

Type: Helvetica Neue, then Roboto, then Arial. No monospace anywhere.

The logo must not be recoloured, distorted, outlined, cropped or rotated. `logo.png` was rasterised from the supplied PANTONE 1795 vector; the spot-to-screen conversion produced `#D72935`, which was normalised to the approved digital red `#ED1C24`. If the logo is ever regenerated, do the same. The guidelines call for the red box logo on a first instance with a cover — that artwork is not in the project, so the standard logo is used throughout.

## 4. Data sources

Two separate imports, both parsed on the phone, both stored only on the device. Both live on the **Data & setup** screen, reached by a link at the foot of the home screen rather than a permanent card, because each is a one-off.

### 4.1 Contact database

The ANZ Active Food Contacts view exported from Dynamics as `.xlsx`.

Columns read (`COL` object in `app.js`):

| Key | Column header |
| --- | --- |
| `acct` | Account Name |
| `full` | ` Full Name` — note the leading space |
| `first` / `last` | First Name / Last Name (fallback if Full Name is a placeholder) |
| `role` / `title` | Job Role / Job Title (title preferred) |
| `email` | Email 1 |
| `mob` | Mobile |
| `mgr` | Account Manager (Account Name) (Account) |

Header matching is case-insensitive and whitespace-tolerant via `pick()`, so minor export changes will not break it. A renamed column will.

Quirks handled on import:

- Placeholder names `. .` and `.` are skipped, falling back to First + Last.
- Duplicate contacts within an account are collapsed, keeping the row scoring highest on completeness (email 2, mobile 2, role 1).
- The account manager dropdown is built from whoever actually appears in the file, so any manager can use the same app with their own export.

Reference scale from the September 2026 export: 5,723 rows, 1,201 accounts, ~15% without email, ~65% without mobile.

### 4.2 Belt reference catalogue

`Plant_Audit_Template_1.xlsm`, the same workbook behind the plant audit line entry form. Parsed by `importRef()`, stored under `beltref`. This is what drives every belt picker, both checks and the sprocket lookups.

Three sheets are read. SheetJS is given a `sheets:` list so it only unzips those three; parsing the whole workbook is markedly slower for no benefit. If any named sheet is absent it falls back to a full read and matches names case-insensitively.

| Sheet | Columns | Yields |
| --- | --- | --- |
| `Belt Audit Data` | `Series_Ind`, `Belt_Style_Ind`, `Material_Ind`, `COLOR_IND` | 1,503 valid Series → Style → Material → Colour combinations |
| `Belt Audit Data` | `Series_Ind`, `Belt_Style_Ind`, `Material_Ind`, `Current_Lnk_Wth_Mm`, `Belt_Link_Increment`, `Minimum_Width_In_L`, `Protrusion_Thk_Mm` | 1,056 link geometry rows |
| `SPROCKET SPILL DATA` | `Belt Series`, `Bore Description`, `Size Description`, `Material`, `Description`, `Part Number` | 1,993 sprockets |
| `BELT DATA` | `Series` + `Pitch`, `Material `, `Colour`, `Rod Material`, `Flight Style`, `Sideguard Style`, `Indent` | per-series pitch and the master lists the FORM sheet validates against |

**Columns are found relative to an anchor, never by a bare name lookup.** `Series_Ind`, `Belt_Style_Ind` and `Material_Ind` each appear twice on `Belt Audit Data` — once for the combinations block, once for the geometry block. `Material`, `Description` and `Part Number` each appear twice on `SPROCKET SPILL DATA`. A plain `indexOf` silently reads the wrong block and produces a catalogue that looks plausible and is wrong. `colAt()` walks outward from an anchor that appears exactly once (`COLOR_IND`, `Current_Lnk_Wth_Mm`, `Belt Series`); `importRef()` throws if the two blocks resolve to the same column.

Other details worth knowing:

- Series values are numeric in the sheet and coerced to strings. One series is `INTRAFLEX`, so never assume numeric.
- `BELT DATA` column B holds `SERIES_100` style names for 29 rows and then continues with unrelated field labels; only rows matching `SERIES_` are read.
- 28 of the 58 series have a pitch on file. The other 30 cannot do the rows↔millimetres flight spacing conversion, and the form says so and disables the rows box.
- Indent values are grouped in the sheet by `--- Friction Top ---` style separator rows, which become `indentGroups`.
- `Material ` on `BELT DATA` has a trailing space. Header matching normalises whitespace.

A wrong file fails with a message naming the missing sheet or column, and leaves the existing catalogue untouched.

**Never commit either source file to the repo.** The repository is public on GitHub Pages. Customer contact data and the Intralox catalogue both live only on phones. `Plant_Audit_Template_1.xlsm` and `Intralox_Brand_Guidelines.pdf` belong in the project library, not the repository.

## 5. Call flow

- **Home** — new call, resume open call, list of past calls with a bin on each, and a Data & setup link. A one-line prompt appears only while an import is missing.
- **Data & setup** — both imports with their status lines. Normally out of sight.
- **Account** — date, call type, account manager, search across all accounts. The chosen manager's own accounts sort to the top; others show a tag naming whose they are. Manual entry for accounts not in the CRM, flagged in the output.
- **Contacts** — multi-select of that account's contacts with role, email, mobile. Missing email or mobile is tagged on the row. Free-text fields for an unlisted contact, flagged as needing adding to Dynamics. Site or area field. At least one contact is required.
- **Dashboard** — call summary, four entry buttons, the running call log, the loose photos card, compile.
- **Entries** — belt, project, general note, health check, in any order.
- **Compile** — generate the HTML and hand it to the Android share sheet.

Past calls can be deleted from the home screen. The confirm names the customer and date and states how many entries and photos will be erased, so a pocket-press has something to read. Cancel is the safe default.

## 6. Entry field sets

### 6.1 Belt

Deliberately mirrors the plant audit line entry form, so the same asset is described the same way whichever tool is used. **Health check remains a separate entry type** — the audit form folds condition into one asset record, this app does not, and that was a considered decision rather than an oversight.

**Identity.** Asset no. and line description (required). Belt description — free text shorthand such as `S800OHFT`, kept because it works with or without the catalogue loaded and because older calls used it.

**Belt data.** Series → Style → Material → Colour, each level filtered by the one above from the 1,503 combinations. Rod material. Conveyor length (m), Inside frame width (mm), Belt width (mm), Belt length (m). Retrofit (Y/N).

**Sprocket data**, with a skip toggle. Bore → Pitch diameter and tooth count → Material → Build type. Description and Part number auto-fill from the catalogue and stop auto-filling once typed in. Drive and Idle quantity. Sprocket spacers and Heavy duty retainers checkboxes.

**Flights and sideguards**, with a skip toggle, **defaulting to skipped** because most belts logged on a call have none and the previous form defaulted every flight field to N/A. Flight type, Flight material, Flight height, Flight spacing as either rows or millimetres, Indent, Centre notch, Sideguard type, Sideguard material, Sideguard height.

**Quote contact**, only if different to the call contacts.

Behaviours carried over from the audit form:

- **Belt width check.** Reproduces the workbook's own EU–FC calculation: from link width, protrusion, increment and minimum link count, work out the widths that can actually be built and flag anything landing between them, naming the nearest buildable widths.
- **Frame check.** Inside frame equal to or narrower than the belt is flagged and both fields are outlined, since one figure must be wrong.
- **Belt length estimate.** `conveyor length × 2.05 + 0.5`, marked as estimated, and abandoned the moment the field is typed in.
- **Sprocket quantity.** `ODD(belt width / 152)` for both drive and idle, 152 mm being the maximum sprocket centre spacing. Abandoned once typed in.
- **Flight spacing conversion.** `spacing_mm = rows × series pitch`, live in both directions, with a note that says when a millimetre figure is not a whole number of rows.
- **Indent filtering.** The belt style determines which surface group applies; a set flight type adds the Flights group. Flat and open surfaces offer Zero with a link to show everything.
- **Flight material** mirrors the belt material until manually changed.

Additions specific to this app:

- **Copy spec from a belt already logged**, for the common case of several near-identical lines in a row. Copies the spec, never the asset number.
- **Sprocket spacers** records as `Yes - see TSG for specification` in the notes. **Heavy duty retainers** records with a quantity of 8. Both preview under the checkboxes so what will be written is visible before saving.
- **Other** is available on rod material, belt material, colour, flight type, sideguard type and indent, so a value outside the catalogue is still capturable.

**Degraded mode.** With no catalogue loaded the belt screen shows a banner linking to Data & setup, the pickers sit empty, and every free-text and measurement field still works. A belt can always be logged.

### 6.2 Picker ordering

The workbook is alphabetical and carries no notion of what is common, so ordering comes from use. Every saved belt bumps a counter for each value picked, against the context it was picked in — styles under the series, materials under series|style, colours under series|style|material, sprocket values under the bore and pitch above them.

`rank()` sorts by the count in that exact context, then by how often the value has been used anywhere, then alphabetically. The second tier is what carries a material preference into a series never logged before.

**No group headings.** An earlier build split selects into "Most used" and "All" optgroups; it was rejected as clutter. Values simply sort to the top. The only optgroups anywhere are the indent surface groups, which are meaningful, and usage sorts within each group rather than above them.

Chips carry a cyan outline when they have been used before. That is the only marker.

### 6.3 Chips versus dropdowns

Rod material, belt material and belt colour are chip buttons; series and style are dropdowns. The split follows the catalogue:

| Level | Options per parent | Control |
| --- | --- | --- |
| Series | 58 | dropdown |
| Style | median 3, max 33, 14 parents over 8 | dropdown |
| Material | median 2, max 17, 13 of 364 parents over 8 | chips |
| Colour | median 1, max 7 | chips |

Material and colour chips are rebuilt whenever anything above them changes, since the valid values depend on the cascade. A current pick survives the rebuild if it is still valid — changing style from FLAT TOP to FLUSH GRID keeps ACETAL — and clears if it is not. Tapping a lit chip deselects it.

### 6.4 Other entries

**Project.** Project or site (required), Current status (Being considered / Scoping / Awaiting quote / Quoted / Approved / Scheduled / On hold), Next action, Target date (free text — "Q3 2026" and "late Oct" are both normal), Owner, Notes.

**General note.** Topic (Staffing / Production / Plant / Commercial / Other), Note (required). Site intelligence that is neither belt nor project: turnover, kill rate, plant conditions, competitor activity.

**Health check.** Asset no. or location, Fault or observation (required), Type (Belt wear / Sprocket wear / Tracking / Frame or wear strip / Drive or shaft / Hygiene / Other), Severity (Monitor / Plan / Urgent), Recommended action.

The health check field set is a first draft and has not been confirmed against how walkarounds are actually recorded.

## 7. Photos

Every entry card in the call log has its own Camera and Photos buttons, so photos can be attached to any entry at any time, in any order. This matters because the plant is walked quickly and entries are often logged afterwards, out of sequence.

Three destinations:

1. **A named entry** — the card's own buttons, `photoTarget` set to that entry's index.
2. **The most recent entry** — the bottom bar buttons, `photoTarget` null.
3. **Loose** — the Loose photos card at the bottom of the dashboard, `photoTarget` set to `'loose'`. Held against the call rather than an entry, and output as an Additional photos section at the end of the notes. The bar buttons fall through to loose when the call log is empty.

`photoTarget` is reset immediately after use — a stale `photoTarget` would silently attach photos to the wrong belt.

Both inputs accept multiple files. `capture="environment"` on the camera input only; the gallery input must not have it, or Android skips the picker.

Images are resized to 1400px on the long edge at JPEG quality 0.72 via canvas, then stored as data URIs. Tapping a thumbnail deletes it after a confirm.

Calls saved before the loose field existed have no `loose` array. It is created on open, on resume and on first use, so older calls keep working.

## 8. Output

One format: self-contained HTML with base64 images. Generated by `buildNotesHTML()`, handed to `navigator.share()` as a File, then sent to OneDrive, Outlook or Teams from the Android share sheet. Plain download to the phone is the fallback when sharing is unavailable.

EML was tried and abandoned. On desktop, a `.eml` opens in Outlook as an editable draft with photos inline, which is ideal. On Android, Outlook opens it in a browser instead — it never reaches the mail client as a draft. Do not reintroduce EML for this app without re-testing that specific behaviour on the phone.

PDF was dropped deliberately. In-browser PDF means either a JS library that will not match the template or Chrome's print dialog. Neither is worth the fidelity loss.

The belt block always prints the identity and dimension rows. Sprocket and accessory rows print only when populated, so an unused field does not become a row of em dashes; where a whole section was skipped it says `Not assessed` or `None on this belt`, which distinguishes a deliberate skip from an oversight.

### Styling rules

- Logo masthead at the top, base64-embedded, above a 3px `#ED1C24` rule. Adds about 15 KB per file.
- Body Helvetica Neue / Arial 11pt, text `#222222`.
- Section headings `#4D4D4F`, underlined with a 2px `#E3F0F5` rule.
- Table header rows: `#E3F0F5` (Pantone 545), never grey. This replaced `#dbeaf5`, which was a close but unapproved colour.
- Label cells `#F7F8F8`. Borders `#CCCCCC`.
- Flags and warnings in the error colour `#B2232F`.
- Empty or unpopulated cells: em dash (—), never "N/A".
- Belt and health blocks carry `page-break-inside: avoid` so a table is never separated from its photos when printed.
- Photos display at max 420px wide.
- Contacts appear as a table with a CRM column; anyone not found in the export is marked as needing adding to Dynamics. Manual accounts are flagged the same way in the call details table.

Filename: `Customer_Site_call_notes_DD-MM-YYYY.html`, non-alphanumerics collapsed to underscores, customer truncated at 40 characters. Site is omitted when blank. The stored date is already DD-MM-YYYY; the date input's ISO value is converted at call creation.

A call with ten photos produces roughly a 15–20 MB file. Fine for OneDrive, large for email.

## 9. Deployment

GitHub Pages, public repo, no build step. Upload the eight files to the repo root, enable Pages from the main branch root folder, open the URL in Chrome, Add to Home screen.

Azure Static Web Apps was considered and ruled out as not feasible in this environment.

Bump `CACHE` in `sw.js` whenever any file changes (`beltcall-v10` → `v11`, and so on), or the user will test an old build and report a fix as broken. This is the single most likely source of confusing behaviour after an update. **Current version: v11.**

Service worker install caches each asset independently and tolerates failures. It previously used `cache.addAll()`, which is atomic — a blocked CDN took `index.html` and `app.js` down with it and left the app with no offline capability at all. Do not go back to `addAll`. The icons are in the cache list; they were missing until v11.

Reinstalling on the phone: removing the home screen icon is not enough. An installed PWA is a real Android app — long-press → App info → Uninstall, then open the URL in Chrome by typing it, or the launcher routes straight back into the old install. If an icon still renders blank after a fix, clear the site data for the address before trying to install again; a cached broken manifest icon survives a version bump more often than it should.

## 10. Open items

- Account number is missing from the Dynamics export. The exported view contains no account number, only a contact GUID. The view needs re-exporting with that column, after which it should be added to `COL`, shown in the account picker and carried into the notes.
- Heavy duty retainer quantity is hard-coded to 8. If it varies in practice it should become an editable field pre-filled with 8, matching how drive and idle quantities already work.
- The belt screen is now long. It has not been used on a phone at full length, and the worst-case material chip group (17 values, series 900 FLUSH GRID) has not been seen on a real screen. A top-few-plus-show-all toggle is the fix if it reads as a wall.
- Usage counts have no reset or edit. If the ordering ever learns something wrong there is no way to correct it short of clearing site data, which would also destroy the calls.
- Belts saved before the rebuild carry the old field set. They still compile, but their `beltmat` values are the old PP/PK/AC/PE codes rather than catalogue materials, and they have no series or style.
- N/A versus blank both render as an em dash, so "checked, there are none" reads identically to "never got to it". The belt block now distinguishes a skipped section, but individual fields still do not.
- Silent defaults — Retrofit and Severity are empty if never tapped, and log as answers when they are non-answers.
- Android back gesture exits the app rather than moving back a screen, because navigation does not use history.
- Width now has a catalogue check, but conveyor length, belt length and the free-text accessory fields have no validation at all.
- Untested at scale on a phone. The belt catalogue parses in roughly 800 ms in a desktop test environment; the 5,723-row contact import has still never been run on a phone. Both parse on the main thread, so the UI locks while they work.
- SheetJS is still a CDN dependency, and both imports now depend on it. The service worker survives that fetch failing, but if it fails on first load and the phone then goes offline, neither import will work until jsDelivr is reachable once. Vendoring the library into the repo would close it, at the cost of about 900 KB in the repo.
- Delivery to Outlook is manual via the share sheet. Microsoft Graph could create a properly formatted draft directly in the mailbox, with photos inline, but needs an Entra ID app registration. That same registration would later serve live Dynamics queries via the Dataverse Web API, removing the contact import step entirely.
- Health check field set needs confirming against real walkaround practice.
- Red box logo artwork is not in the project. The guidelines call for it on a first instance with a cover, which the compiled notes arguably are.

## 11. Working conventions

- Deliver complete files, never diffs. State which files changed.
- Remind about the `sw.js` cache bump whenever any file changes.
- The app can be exercised headlessly in this environment with jsdom plus fake-indexeddb, and the real workbook can be parsed to verify the catalogue. That catches runtime errors, escaping faults, broken flows and wrong column mappings. It cannot test the camera, the share sheet, gesture-navigation hit areas, launcher icon behaviour, on-screen layout length, or parse time on real hardware. Say which of the two applies rather than implying the code has been verified on a phone.
- Where a check is written against the workbook, assert against values derived from the file rather than numbers typed from memory. Two early test failures were wrong expectations, not wrong code — the catalogue has 58 series, not the 29 that appear on `BELT DATA`.
- Keep it dependency-free. SheetJS is the only external library and there should be a strong reason to add a second.
- Do not flag observations or raise interpretations that are the user's technical call to make. Capture what is provided.
- Follow the brand guidelines for anything visual. Where a guideline and an existing spec disagree, follow the guideline and say what changed.
