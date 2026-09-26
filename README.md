# Keel

A calm, local-first daily planner for Windows (also builds on macOS and Linux).

Plan each morning, timebox your tasks next to your calendar, focus with a timer, and close the
day with a short review. Everything lives in a database on your computer. There is no account,
no Keel server, no telemetry, and no cloud AI. Keel is fully usable offline. Integrations with
calendars and task tools are optional, off by default, and clearly marked as networked.

**Contents**

1. [Install on Windows](#1-install-on-windows)
2. [Build and run from source](#2-build-and-run-from-source)
3. [Using Keel](#3-using-keel)
4. [Your data and privacy](#4-your-data-and-privacy)
5. [Backup, restore, export, delete](#5-backup-restore-export-delete)
6. [Integrations (optional, networked)](#6-integrations-optional-networked)
7. [Time zones and DST](#7-time-zones-and-dst)
8. [Architecture](#8-architecture)
9. [Development and tests](#9-development-and-tests)
10. [Feature status](#10-feature-status)
11. [Known gaps](#11-known-gaps)

---

## 1. Install on Windows

**Supported:** Windows 10 and Windows 11, x64.

Download the installer from the repository's **Releases** page (the repository is private, so
sign in to GitHub first). Each release has:

| File                              | Installs to       | Admin rights |
| --------------------------------- | ----------------- | ------------ |
| `Keel_0.3.2_x64-setup.exe` (NSIS) | Your user profile | Not needed   |
| `Keel_0.3.2_x64_en-US.msi`        | Program Files     | Needed       |
| `SHA256SUMS.txt`                  | —                 | —            |

To check a download in PowerShell, compare `Get-FileHash .\Keel_0.3.2_x64-setup.exe` with the
line in `SHA256SUMS.txt`. What changed in each version is in [CHANGELOG.md](CHANGELOG.md) and
in the release notes.

**Updating** (from 0.3.0 on): **Settings → About → Update Keel…** (or **Update Keel…** in the
command palette, `Ctrl+K`). The wizard offers two ways:

- **Check for a newer version.** The repository is private, so this needs a read-only GitHub
  token once. The wizard walks you through creating one: a fine-grained token, only for this
  repository, with **Contents: Read-only**. Keel then shows the new version's notes, downloads
  its installer, checks it against the release's `SHA256SUMS.txt`, backs up your data, starts
  the installer, and closes.
- **Use an installer I downloaded.** Download `Keel_X.Y.Z_x64-setup.exe` from Releases
  yourself, and pick it. Keel shows its SHA-256 to compare with `SHA256SUMS.txt`, backs up
  your data, starts it, and closes.

Either way your data stays where it is. You can also simply install a newer version over the
old one; close Keel first.

Between releases, installers can be built by hand: **Actions → CI → Run workflow**, tick
“Also build the installers”, then download the artifact **`keel-windows-installers`**.

- The installers are **not code-signed**, so Windows SmartScreen will warn you. Choose
  **More info → Run anyway**.
- Keel uses the Microsoft Edge **WebView2** runtime. It ships with Windows 11 and current
  Windows 10. If it is missing, the installer downloads it.
- To uninstall, use **Settings → Apps**. Uninstalling does not delete your data (see
  [section 4](#4-your-data-and-privacy)).

## 2. Build and run from source

### Prerequisites

|                 | Windows 10/11 (primary)                                                                                   | macOS                                                                        | Linux (Ubuntu 24.04)                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| C/C++ toolchain | Visual Studio 2022 **Build Tools**, workload “Desktop development with C++”                               | Xcode Command Line Tools                                                     | `build-essential`                                                                                     |
| Rust            | [rustup](https://rustup.rs), default `x86_64-pc-windows-msvc` toolchain                                   | rustup                                                                       | rustup                                                                                                |
| Node.js         | 22 LTS                                                                                                    | 22 LTS                                                                       | 22 LTS                                                                                                |
| Web view        | WebView2 (preinstalled)                                                                                   | built in                                                                     | `libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev` |
| Status          | built, unit-tested and Rust-tested in CI; E2E: core flow and focus bar (WebView2); installer used by hand | built and unit/Rust-tested in CI up to 0.3.2; not in CI since; UI not tested | built, unit-tested and E2E-tested (X11) in CI up to 0.3.2; not in CI since                            |

### Commands

```powershell
git clone https://github.com/yalijore/project-.git keel
cd keel
npm ci

npm run dev        # the desktop app, with hot reload (one command)
npm run build      # release build + installers
```

`npm run build` writes the installers to `src-tauri\target\release\bundle\nsis\` and
`src-tauri\target\release\bundle\msi\`. The app itself is `src-tauri\target\release\keel.exe`.

`npm run dev:web` starts a browser-only preview on an in-memory database. It is meant for UI
work only: backups, files, notifications, and integrations need the desktop app.

## 3. Using Keel

- **Today board.** Days side by side, with a calendar panel. Drag tasks between days, into the
  backlog, or onto the calendar to timebox them.
- **Quick capture** (`Q`) understands natural input:
  - `Draft homepage copy tomorrow 45m #website @writing !high due oct 3` sets the day,
    estimate, project, tag, priority, and deadline.
  - `Standup notes every weekday at 9:30am 15m` creates a repeating task with a time block.
- **Rituals**
  - **Plan the day** (`Shift+P`): review what's left, estimate, auto-timebox around meetings,
    check your workload, and set an intention.
  - **Shut down** (`Shift+S`): see what got done, roll the rest forward, and write a short
    reflection.
  - **Weekly review** (`Shift+W`).
- **Focus** (`Shift+F`) gives one task the whole screen:
  - **Actual** time against **Planned** time. Actual is everything tracked on the task, so
    pausing and resuming continues the count. Click Planned to change the estimate.
  - One start/pause button, **Complete**, a progress line, and time left (or over).
  - The task's subtasks (tick them off or add new ones) and notes.
  - **Up next** shows the next task planned for today; after completing, start it in one click.
  - The timer keeps running across restarts. After sleep, Keel asks whether the gap counts as
    work time.
- **Focus bar** — a small window that stays above your other apps while you work in them.
  - Complete · task title · `actual / planned` (for example `12:04 / 30:00`) · start/pause ·
    hide. It shows the same time as Focus mode and the sidebar. Hiding it never stops the
    timer.
  - Opens by itself when a timer starts or when Focus mode opens (two separate switches under
    **Settings → Focus bar**), or from the command palette.
  - Drag it anywhere. Keel remembers the spot across restarts and pulls it back on screen when
    monitors change. **Reset focus bar position** is in the palette and in Settings.
  - Clicking the task title brings Keel to the front without changing the view. After you
    complete the task, the bar moves to the next task planned for today, if there is one.
  - System-wide shortcuts: `Ctrl+Alt+Shift+F` shows or hides the bar and `Ctrl+Alt+Shift+Space`
    starts or pauses the timer. You can rebind or turn off each one. Settings flags a
    combination that Keel, the system, or another app already uses.
  - It appears without taking the keyboard from the app you are in. It is fully usable with
    the keyboard (`Tab`, `Enter`, `Esc` hides) and follows your theme and color theme.
  - There is one timer. The bar only displays it and sends commands to the main window, so a
    click from the bar and one from the planner can never produce two sessions.
- **Review** compares planned and actual time per day or week, as charts and tables.
- **Workload** under each day: estimated work left against the day's capacity. Today it warns
  only about work that has no time block ahead and doesn't fit in the working hours still
  free ("2h won't fit today"); a task timeboxed later, even after hours, counts as scheduled.
- **Color themes** under **Settings → General**: Keel (teal), Ocean, Iris, Rose, and Graphite,
  each in light and dark. Every theme is contrast-checked (WCAG) by a unit test.
- **Keyboard first**
  - `Ctrl+K` opens the command palette. `?` lists every shortcut.
  - Shortcuts can be rebound under Settings → Shortcuts.
  - On a focused card:
    - `↑/↓` move between cards and `Alt+↑/↓` reorder.
    - `Space` completes; `F` starts focus; `E` sets the estimate; `S` timeboxes.
    - `T`, `M`, and `B` move the card to today, the next day, or the backlog.
    - `0`–`3` set the priority; `Delete` removes the card.
- **Undo** (`Ctrl+Z`) covers every change to tasks, plans, time blocks, and events, including
  bulk edits. Settings changes are applied directly.

## 4. Your data and privacy

### Where your data lives

| OS      | Folder                                                                                       |
| ------- | -------------------------------------------------------------------------------------------- |
| Windows | `%APPDATA%\app.keel.planner\` (for example `C:\Users\you\AppData\Roaming\app.keel.planner\`) |
| macOS   | `~/Library/Application Support/app.keel.planner/`                                            |
| Linux   | `~/.local/share/app.keel.planner/`                                                           |

That folder contains:

- `keel.sqlite3`: all of your data, in one SQLite database. It runs in WAL mode with
  `synchronous=FULL`, and every change is a single transaction.
- `backups/`: automatic and manual backups.

Settings → Data & privacy shows the exact path.

### Privacy model

- **Local by default.** Tasks, plans, time blocks, timers, reflections, and statistics are
  stored and computed on your computer. Keel makes no network requests unless you connect an
  integration or ask it to look for an update.
- **No account, telemetry, analytics, crash reporting, or cloud AI.** Search, statistics, and
  auto-scheduling all run locally.
- **Integrations are opt-in and networked.** Each one shows what it downloads, what it sends,
  which hosts it contacts, and what it can change, before you connect it. See
  [section 6](#6-integrations-optional-networked).
- **Updates only when you ask.** Keel never checks by itself. In **Update Keel…** (Settings →
  About, or the command palette), **Check for a newer version** asks `api.github.com` for the
  latest release of Keel's repository, sending the read-only token you added and nothing
  about you or your data. The installer download follows GitHub's redirect to its download
  host without the token. **Use an installer I downloaded** makes no request at all.
- **Credentials are never stored in the database.** Integration tokens, API keys, and private
  calendar-feed addresses live in the OS credential store:
  - Windows: **Windows Credential Manager**.
  - macOS: Keychain.
  - Linux: Secret Service.

  The web view never sees them. The same goes for the update wizard's GitHub token.

### Encryption at rest

Keel does not encrypt its database itself. Use full-disk encryption instead:

- **Windows:** **BitLocker**, or **Device encryption** on Home editions (Settings → Privacy &
  security → Device encryption).
- **macOS:** FileVault.
- **Linux:** LUKS.

The alternative was SQLCipher. Its vendored OpenSSL build needs Perl and NASM on Windows,
which makes builds fragile, and we won't ship home-made cryptography instead.

## 5. Backup, restore, export, delete

Everything below is under **Settings → Data & privacy**.

| Action                                 | What happens                                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic backup                       | At most once per ~20 hours, when Keel starts or a new day begins. The 14 most recent automatic backups are kept. Each is a consistent snapshot (`VACUUM INTO`). |
| Create backup                          | Same snapshot, labelled _manual_. Manual backups are never pruned.                                                                                              |
| Restore                                | Pick any backup. Keel first saves a _pre-restore_ safety backup, checks that the backup's schema version is supported, swaps it in, and reloads.                |
| Save backup file… / Restore from file… | Copy a backup anywhere, such as another computer, or restore one from anywhere.                                                                                 |
| Export JSON                            | Every table, human-readable.                                                                                                                                    |
| Export CSV                             | Tasks with dates, estimates, actual time, and project.                                                                                                          |
| Export ICS                             | Calendars. Optionally includes your time blocks, so another calendar app can show your plan.                                                                    |
| Delete all data                        | Type `DELETE` to confirm. This removes the database, all backups, and every integration credential from the OS store, then returns Keel to first-run.           |

Keel also backs up automatically before a schema migration (_pre-migration_).

## 6. Integrations (optional, networked)

Everything else in Keel works without these. When you connect an integration:

- This computer talks **directly** to the provider. No Keel server is involved.
- Rust makes the authorized requests. It attaches credentials only for that provider's
  **allow-listed hosts** over HTTPS.
- OAuth sign-in happens in your **system browser**. The redirect goes to a one-time loopback
  listener (`127.0.0.1` / `localhost`) and is protected by PKCE and a random `state`. Only the
  scopes listed below can be requested.
- Remote events are stored separately from Keel's own time blocks. Sync is idempotent: each
  account, entity, and external ID maps to exactly one local item.
- **Keel never edits or deletes a remote item it did not create.** It writes to a provider
  only in two opt-in cases:
  - mirroring your time blocks into one calendar you choose;
  - marking imported tasks complete.
- **Sync schedule:** every 15 minutes by default, configurable per account (5, 15, 30, or
  60 minutes, or manual only).
  - **Offline:** sync is skipped and retried later.
  - **HTTP 429:** Keel waits for `Retry-After` (at most 60 s).
  - **Server errors and dropped connections:** retried after 1, 2, and 4 s.
  - **Rejected credentials:** the account is paused until you reconnect.
- **Disconnect:**
  - deletes the credentials from the OS store and the local copies;
  - can also delete imported tasks, and the time-block events Keel created;
  - revokes the token at Google (Microsoft has no revocation API for desktop apps; the app
    links to the account page instead).

> **Verification status:** every adapter below passes contract tests against recorded API
> responses (`src/integrations/__fixtures__`). None has been run against a live account, so
> each is marked **requires credentials for live verification**. The calendar-feed path is
> also covered end to end on the real app, against a local mock server.

### Providers

**Calendars**

| Provider                 | Auth                              | Keel downloads                                              | Keel may write (opt-in)                      | Scopes                                                                                                |
| ------------------------ | --------------------------------- | ----------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Google Calendar          | OAuth (your own client)           | Calendar list, and events from 60 days ago to 1 year ahead  | Events for your time blocks, in one calendar | `calendar.readonly`, plus `calendar.events` only if you allow writing                                 |
| Outlook / Microsoft 365  | OAuth (your own app registration) | Calendar list, account email, and events in the same window | Events tagged “Keel” for your time blocks    | `User.Read`, `Calendars.Read`, `offline_access`, plus `Calendars.ReadWrite` only if you allow writing |
| Calendar feed (iCal URL) | The URL itself (kept as a secret) | Every event in the feed                                     | Nothing                                      | —                                                                                                     |

Recurring meetings arrive as series. Google sends each series with its rule, extra dates
(`RDATE`), and exceptions. Outlook's feed lists every occurrence separately, so Keel reads the
series itself instead. Keel then stores one recurring event in the series' own time zone, keeps
moved or edited occurrences as exceptions, and hides occurrences Outlook no longer lists. It
checks this for the sync window (60 days back, one year ahead). If a series uses a pattern or
time zone Keel cannot express, its occurrences are stored one by one.

**Tasks**

| Provider   | Auth                                                   | Keel downloads                          | Keel may write (opt-in)                                                                                                | Scopes                                                |
| ---------- | ------------------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Todoist    | Personal API token                                     | Open tasks                              | Close and reopen                                                                                                       | Full-access token; Keel calls only the task endpoints |
| Asana      | Personal access token                                  | Incomplete tasks assigned to you        | Complete and incomplete                                                                                                | Your user's access                                    |
| Trello     | API key + token                                        | Open cards you're a member of           | Complete, your choice per account: tick the due date, move the card to a list you name (such as “Done”), or archive it | read (+write)                                         |
| Jira Cloud | Email + API token, to your `*.atlassian.net` site only | Unresolved issues assigned to you       | Complete by applying a workflow transition into a Done-category status                                                 | Your user's access                                    |
| Notion     | Internal integration secret                            | Pages in one database you share with it | Complete: tick the Done checkbox, or set the Status (or a status-like Select) to a done option                         | Only pages you connect                                |

Completion write-back details:

- **Jira** has no “done” flag, only workflow transitions. Keel picks a transition your
  workflow offers into the Done category. If every such transition requires fields (a
  resolution screen, for example), Keel does not guess values: the task stays completed in
  Keel, and the account shows a warning.
- **Trello** in “list” mode moves the card to the list with that name on the card's own board.
  Cards already in that list are treated as done and not imported.
- **Notion** uses, in this order: a checkbox named like “Done”, a Status property, a Select
  property named like “Status”, or any checkbox. For Status, Keel picks the first option in
  the “Complete” group. For Select, it picks an option named Done, Complete, Completed, Finished, Closed, or Archived.

For imported tasks:

- Remote changes update a task unless you edited it in Keel since the last sync. In that case
  your edit wins and Keel shows a warning.
- Tasks completed or deleted remotely are completed in Keel.
- Tasks you delete in Keel are not re-imported.

### Setup

Open **Integrations** in the sidebar and choose **Connect…**. The dialog shows the full data
flow and these steps.

- **Google Calendar.** Google does not allow a shared OAuth client for an open-source desktop
  app, so you create your own (free, about 5 minutes).
  1. At console.cloud.google.com, create a project and enable the **Google Calendar API**.
  2. Under **OAuth consent screen**, choose _External_ and add yourself as a test user.
  3. Under **Credentials → OAuth client ID**, choose **Desktop app**.
  4. Paste the client ID and client secret into Keel.

  While the consent screen is in _Testing_, Google expires refresh tokens after 7 days.
  Publish the app, or reconnect weekly.

- **Outlook / Microsoft 365**
  1. At entra.microsoft.com, go to **App registrations → New registration**. Personal
     accounts need _any organizational directory and personal Microsoft accounts_.
  2. Under **Authentication**, add the platform _Mobile and desktop applications_ with
     redirect URI `http://localhost`.
  3. Add the delegated Graph permissions listed above.
  4. Paste the **Application (client) ID** into Keel. Tenant is optional (`common` by
     default).

  Work accounts may need an administrator's consent.

- **Calendar feed.** Paste an `https://` or `webcal://` address. Private addresses, such as
  Google's “secret address in iCal format”, work like passwords, so Keel keeps them in the
  credential store.
- **Todoist:** Settings → Integrations → Developer → API token.
- **Asana:** app.asana.com/0/my-apps → personal access token.
- **Trello:** trello.com/power-ups/admin → your Power-Up's API key → the _Token_ link.
- **Jira:** id.atlassian.com/manage-profile/security/api-tokens. Enter your site, email, and
  token.
- **Notion**
  1. Create an internal integration at notion.so/profile/integrations.
  2. Connect it to your task database (••• → Connections).
  3. Paste the database ID.

### Email → task (local, not networked)

**Integrations → Import email…** (also in the command palette) turns a saved email into an
Inbox task. The subject becomes the title; the sender, date, and message text become notes.

- Keel reads the file locally and never connects to a mailbox.
- **`.eml`** (standard MIME, as saved by most mail apps): encoded headers, quoted-printable
  and base64 bodies, and legacy character sets.
- **`.msg`** (classic Outlook's “Save as”): subject, sender (the SMTP address, not the Exchange
  directory name), sent time, Message-ID, and the plain-text body, or the HTML body as text.
  Text in older 8-bit code pages is decoded. Attachments are ignored.

## 7. Time zones and DST

Keel keeps three kinds of time separate:

- **Deadlines** and **planned days** are floating calendar dates. They never shift when you
  travel.
- **Time blocks** are stored as UTC instants, together with the zone they were created in.
- **Calendar events:**
  - Timed events are UTC instants plus their zone. Recurring events expand in their own zone,
    so a 09:00 weekly meeting stays at 09:00 across DST.
  - All-day events are floating dates.
  - Extra dates (`RDATE`) and excluded dates (`EXDATE`) are honoured, from `.ics` files and
    from Google.
  - Windows zone names, such as `W. Europe Standard Time`, are mapped to IANA zones. They
    appear in `.ics` files from Outlook and in Outlook series.

**When your time zone changes** (Keel follows the system zone unless you pin one in
Settings), upcoming time blocks keep their **absolute time** by default. A banner lists the
affected blocks and offers **Keep local clock times**, which moves each block to the same
wall-clock time in the new zone. That choice can be undone.

## 8. Architecture

```
React + TypeScript (web view)
  features/*        screens: board, calendar, rituals, focus, review, settings, integrations
  data/actions      one transaction per user action · undo group · targeted store refresh
  data/repo         all SQL (same code runs on sql.js in tests and the browser preview)
  domain/*          pure logic: dates/DST, scheduling, recurrence, capacity, stats, ICS
  integrations/*    provider adapters, sync engine, registry (data-flow disclosures)
        │  Tauri IPC
Rust (src-tauri)
  db.rs             one SQLite connection (rusqlite, bundled SQLite), backups, restore, wipe
  secrets.rs        OS credential store (keyring crate)
  integrations.rs   authorized fetch with per-provider host allow-list, token refresh
  oauth.rs          loopback OAuth 2 + PKCE + state
  files.rs          file I/O only at paths chosen in a native dialog
  focusbar.rs       the focus bar window: create/destroy, placement, on-screen clamping
```

- **SQL lives in TypeScript; Rust executes it.** The TS driver serializes every call, and a
  transaction holds the queue. The same migrations run in unit tests on sql.js.
- **Undo** uses a trigger-based SQLite log. It restores only changed columns, strictly
  last-in-first-out. Background changes (rollover, sync) clear older undo steps rather than
  risk a wrong restore.
- **Recurring tasks** materialize lazily. Past occurrences and today's become rows; future ones
  show as virtual cards. `UNIQUE(recurrence_id, recurrence_date)` makes this idempotent.
- **Timer sessions** are rows whose end is empty while running, and only one can run at a
  time. A heartbeat detects sleep and wake.
- **The focus bar holds no state.** The main window is the only writer. It sends the bar
  snapshots, and the bar sends back commands. Each command has an id, runs at most once, and is
  ignored if it refers to a task the bar no longer shows. Elapsed time is always computed from
  the running session's start instant in SQLite. The bar's capability grants it no database or
  file commands.
- **The web view is locked down.** A strict CSP allows no remote origins. It cannot pass file
  paths to Rust, read credentials, or send credentials to a host outside a provider's
  allow-list.

## 9. Development and tests

| Command                          | What it does                                                          |
| -------------------------------- | --------------------------------------------------------------------- |
| `npm run dev`                    | Desktop app with hot reload                                           |
| `npm run check`                  | Typecheck, ESLint, Prettier check, all unit tests, Rust tests         |
| `npm run lint:rust`              | `cargo clippy -D warnings` + `cargo fmt --check`                      |
| `npm test`                       | Vitest: domain, repository, migrations, undo, integrations            |
| `npm run test:rust`              | Rust unit tests + OS credential-store round trip                      |
| `npm run e2e`                    | Builds the app and drives the real binary (Linux, Windows)            |
| `npm run e2e -- --offline`       | Same, inside a network namespace with only loopback (Linux)           |
| `npm run e2e -- --only=focusbar` | Core flow plus one suite (`focusbar`, `integrations`, `interactions`) |

### Releasing

1. Set the new version in `package.json`, `src-tauri/tauri.conf.json`, and
   `src-tauri/Cargo.toml` (then `cargo metadata` refreshes `Cargo.lock`), and add its section to
   `CHANGELOG.md`.
2. Commit and push (to `main` or a `claude/` branch). No tag is needed.
3. The **Release** workflow (`.github/workflows/release.yml`) sees a version without a release,
   runs the tests, builds both installers, and publishes a GitHub Release `vX.Y.Z` (creating
   the tag) with the installers, `SHA256SUMS.txt`, and that version's changelog section as
   notes. Pushes of a version that already has a release do nothing. Pushing a `vX.Y.Z` tag
   also works; it must match the version.

### Test coverage

- **Unit tests (Vitest, 187):**
  - scheduling, auto-timeboxing, and conflicts;
  - recurrence (floating and zoned, across DST);
  - rollover, time accounting, and capacity;
  - migrations, the undo log, and ICS import/export (including VTIMEZONE generation);
  - the time-zone-change policy;
  - quick-capture parsing and statistics;
  - the focus bar's controller: exactly-once commands in order, stale clicks ignored,
    auto-show toggles, advancing to the next task, one window for simultaneous show
    requests; global-shortcut parsing and conflict rules;
  - `.eml` and `.msg` parsing (the `.msg` tests use files from a test-only writer, checked
    against an independent reader);
  - workload: tasks timeboxed later count as scheduled; only unscheduled work competes for
    the free working time;
  - color themes: WCAG contrast of every theme in light and dark, read from `styles.css`.
- **Integration contract tests** run each adapter against recorded fixtures: pagination,
  mapping, sync tokens and delta links, 410 resync, deletions, and write-back (Jira
  transitions, Trello modes, Notion Status/Select). Outlook series: pattern-to-RRULE mapping,
  a Pacific-time weekly series across the DST change with moved and deleted occurrences, a
  later deletion through the sync engine, legacy cursors, and the fallback. Sync-engine
  tests run against a real SQLite database: idempotency, conflicts, deselection, and removal.
  Manager tests cover rollback, error states, scheduling, disconnect, and Delete all data.
- **Rust tests** cover the database, backups, restore safety, host allow-lists, secret
  validation, PKCE (RFC 7636 vectors), and the OAuth callback. The OS credential-store round
  trip runs in its own binary: always on Windows (Credential Manager), and on Linux with
  `KEEL_TEST_OS_STORE=1`.
- **End-to-end (32 steps on Linux: the real desktop binary through tauri-driver and
  WebKitWebDriver, under Xvfb with the openbox window manager and a compositor):**
  - the core flow: onboarding → capture → plan → timebox → focus → complete → shutdown →
    review;
  - undo, backups and exports, and restart persistence (including a running timer), plus
    sleep and wake;
  - keyboard use, drag and drop, and drag-to-timebox;
  - recurring tasks, bulk edit, and ICS import;
  - calendar-feed integration against a mock host, and email import;
  - restore and Delete all data, and choosing a color theme (applied at once, saved);
  - **the focus bar acceptance test**, against a real second app (`xcalc`) with real mouse
    clicks and key presses (`xdotool`). The bar opens without taking focus and stays above
    the other app. Pause and resume from the bar. Hide it: the timer keeps running. The
    system-wide shortcuts reopen it and start and pause the timer. It remembers a dragged
    position across a restart, is pulled back on screen when moved off it, and returns to
    its default spot on **Reset focus bar position**. Its title brings Keel forward without
    changing the view. Completing from the bar gives the correct status and actual time in
    the planner, with no duplicate session.

  The whole Linux suite also runs **offline**.

To run the E2E suite locally on Linux, install `webkit2gtk-driver`, `xvfb`, `openbox`,
`xcompmgr`, `xdotool`, `x11-utils` and `x11-apps`, then run
`cargo install tauri-driver --locked`.

On Windows, put an `msedgedriver.exe` that matches the installed WebView2 on `PATH` (or set
`MSEDGEDRIVER`), for example with
`cargo install --git https://github.com/chippers/msedgedriver-tool`. The suite builds a
Windows test binary whose WebView2 opens its DevTools port (9229), starts Keel itself, and
attaches msedgedriver to it. The port comes from a build-time config override that `run.mjs`
generates; the app's code and release builds never open it. It compiles a small Win32 helper (`e2e/win32/winctl.cs`) with the .NET
Framework's `csc.exe`, and uses Notepad as the second app.

**Status** (CI run for commit `72e0531`): on WebView2, all 12 core-flow steps and all 5
focus-bar steps pass:

- the bar opens on top without taking focus;
- it stays above another app, and pauses and resumes from the bar;
- hiding keeps the timer, and the global shortcuts reopen it (in 0.45 s) and start/pause it;
- it remembers its position across a restart, is pulled back on screen, and resets;
- its title brings Keel forward, and completing from the bar updates the planner exactly once.

The Windows job does not run the integration and interaction suites; those run on Linux only.
See [section 11](#11-known-gaps).

### CI

CI is Windows only (`.github/workflows/ci.yml`):

- **On every push** (except changes to Markdown only): typecheck, lint, format check, unit
  tests, clippy and rustfmt, and Rust tests with MSVC (including Credential Manager). The
  installers are built by the Release workflow, or here when started by hand (“Also build the
  installers”).
- **When started by hand** (Actions → CI → Run workflow → “Also run the Windows UI tests”): the
  Windows E2E suite, the core flow and the focus bar on WebView2. It takes over the mouse and
  keyboard, so it does not run on its own.

The Linux jobs (lint and tests, and the full E2E suite online and offline) and the macOS build
ran on every push up to 0.3.2 and passed there; they were removed to save GitHub Actions
minutes. Locally, `npm run e2e` still runs the full suite on Linux.

CI runs on GitHub's Windows machines. The jobs can also run on a self-hosted Windows runner:
register one (Settings → Actions → Runners) and set the repository variable `WINDOWS_RUNNER`
to `["self-hosted","windows"]`; delete the variable to go back.

## 10. Feature status

Legend:

- ✅ **implemented**: tested as noted.
- 🔑 **requires credentials for live verification**: implemented and contract-tested, never
  run against the live service.
- ⚠️ **verified by hand only**: works in manual use; no automated test on that platform yet.
- ❌ **not implemented**

| Area          | Feature                                                                                                               | Status                | Verified by                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Planning      | Daily planning ritual (review, estimate, auto-timebox, workload, intention)                                           | ✅                    | E2E                                                                                                                                       |
|               | Shutdown ritual, reflection, weekly review                                                                            | ✅                    | E2E (shutdown), unit                                                                                                                      |
|               | Carry-forward / rollover (auto or manual)                                                                             | ✅                    | unit                                                                                                                                      |
|               | Capacity and overcommit warnings, working hours and days, meeting buffers                                             | ✅                    | unit                                                                                                                                      |
| Tasks         | Inbox, backlog, projects, areas, tags                                                                                 | ✅                    | unit, E2E                                                                                                                                 |
|               | Subtasks, notes, links, priority, estimates                                                                           | ✅                    | unit, E2E                                                                                                                                 |
|               | Deadline vs planned day vs time block, kept separate                                                                  | ✅                    | unit                                                                                                                                      |
|               | Recurring tasks (virtual future occurrences, series edit)                                                             | ✅                    | unit, E2E                                                                                                                                 |
|               | Quick capture with natural-language parsing                                                                           | ✅                    | unit, E2E                                                                                                                                 |
|               | Search, completion history, bulk edit                                                                                 | ✅                    | E2E (bulk), unit                                                                                                                          |
|               | Drag and drop (days, backlog, calendar) plus keyboard equivalents                                                     | ✅                    | E2E                                                                                                                                       |
|               | Undo for every change                                                                                                 | ✅                    | unit, E2E                                                                                                                                 |
| Calendar      | Local calendars, events, all-day and recurring events, conflicts, week view                                           | ✅                    | unit, E2E                                                                                                                                 |
|               | Time zones, DST, secondary zone, time-zone-change policy                                                              | ✅                    | unit                                                                                                                                      |
|               | ICS import (idempotent, Windows zone names) and export                                                                | ✅                    | unit, E2E                                                                                                                                 |
|               | Calendar-feed subscriptions                                                                                           | ✅                    | unit, E2E (mock host)                                                                                                                     |
| Focus         | Timer persisted across restarts, with sleep/wake detection                                                            | ✅                    | unit, E2E                                                                                                                                 |
|               | Notifications (block start, estimate reached, shutdown reminder)                                                      | ✅ implemented        | not automatically verified: OS delivery is untested, including Windows toasts                                                             |
|               | Floating focus bar: always on top, start/pause/complete/hide, drag, remembered and clamped position, reset, next task | ✅                    | unit; E2E on Linux X11 and Windows                                                                                                        |
|               | System-wide shortcuts (show/hide bar, start/pause) with conflict detection, rebinding, off switch                     | ✅                    | unit; E2E on Linux X11 and Windows (shortcuts pressed while another app is active)                                                        |
| Review        | Day and week review, planned vs actual, charts with table views                                                       | ✅                    | unit, E2E                                                                                                                                 |
| Customization | Light/dark, color themes, density, week start, 12/24 h, time zone, working days, notifications, shortcut rebinding    | ✅                    | unit (incl. theme contrast), E2E (color theme), manual                                                                                    |
|               | Onboarding without an account, command palette                                                                        | ✅                    | E2E                                                                                                                                       |
| Data          | Backup and restore, JSON/CSV/ICS export, Delete all data                                                              | ✅                    | Rust tests, E2E                                                                                                                           |
|               | Encryption at rest                                                                                                    | ❌ in-app             | Documented: use BitLocker, FileVault or LUKS                                                                                              |
| Integrations  | Google Calendar (read, optional block mirroring)                                                                      | 🔑                    | contract tests                                                                                                                            |
|               | Outlook / Microsoft 365 calendar, recurring meetings kept as series                                                   | 🔑                    | contract tests                                                                                                                            |
|               | Google and `.ics` extra dates (`RDATE`)                                                                               | ✅ `.ics` · 🔑 Google | unit (`.ics`), contract tests (Google)                                                                                                    |
|               | Todoist, Asana, Trello, Jira, Notion (import + completion write-back)                                                 | 🔑                    | contract tests                                                                                                                            |
|               | Email → task from saved `.eml` and classic Outlook `.msg` files (local)                                               | ✅                    | unit, E2E                                                                                                                                 |
|               | Email → task through a forwarding address or mailbox (IMAP)                                                           | ❌                    | —                                                                                                                                         |
|               | Two-way sync of task edits (titles and notes pushed back)                                                             | ❌                    | Only completion is written back                                                                                                           |
| Platform      | Windows installers (NSIS, MSI)                                                                                        | ✅                    | CI build                                                                                                                                  |
|               | Releases on GitHub (installers + SHA256SUMS.txt, published when the version changes)                                  | ✅                    | CI release workflow                                                                                                                       |
|               | Update wizard: look up the latest release, download, check its SHA-256, back up                                       | ✅ · 🔑 live GitHub   | unit, Rust tests, E2E against a mock GitHub (token only sent to the API, not the download host)                                           |
|               | Update wizard: start the installer and close Keel (Windows)                                                           | ✅ implemented        | not yet verified: runs only on Windows, and the Windows E2E job does not run the update steps                                             |
|               | Windows Credential Manager storage                                                                                    | ✅                    | CI Rust test on Windows                                                                                                                   |
|               | Windows UI (WebView2)                                                                                                 | ✅                    | E2E on WebView2: the core flow (12 steps) and the focus bar (5 steps); the other suites run on Linux only. Installer from CI used by hand |
|               | macOS build                                                                                                           | ✅ builds             | CI: unit and Rust tests, `.app` bundle; the UI is not driven by tests                                                                     |

## 11. Known gaps

- **No live integration test.** Adapters follow the providers' documented APIs and pass
  contract tests. Real accounts may still differ: permissions, tenant policies, or API
  changes.
- **Windows UI tests cover the core flow and the focus bar only.** The Windows E2E job
  (msedgedriver attached to WebView2) passes both. The integration and interaction suites
  (drag and drop, bulk edit, color themes, imports, the update wizard) run on Linux
  (WebKitGTK) only. On Windows, CI also runs the unit tests, the Rust tests
  (including Credential Manager) and the installer build, and the CI installer has been
  installed and used by hand.
- **Focus bar platform limits:**
  - **Linux on Wayland:** Wayland does not let apps keep a window above others or register
    system-wide shortcuts. The bar can be covered, and the shortcuts do not fire. Settings
    says so when it detects Wayland. Use an X11 session for both. Not tested under Wayland.
  - **X11 without a compositor:** after being moved, the bar can paint black until it is
    shown again. This was seen under Xvfb without a compositing manager. Standard desktops
    (GNOME, KDE, Xfce) run one, and the tests run with one.
  - **macOS:** it builds, but the bar, its always-on-top behaviour, and the shortcuts have
    not been tested there (tauri-driver cannot drive macOS apps).
  - The bar stays above ordinary windows only. Full-screen games and system surfaces (for
    example the Start menu, UAC prompts, and the lock screen) can cover it. It never
    positions itself over the taskbar or dock.
  - It is created each time it opens (on Windows, this is what keeps it from taking focus).
    In the tests it reappears about 0.2–0.3 s after the shortcut on Linux and about 0.4–0.6 s
    on Windows. One earlier Linux CI run took more than 5 s.
- **Unsigned installers.** Expect a SmartScreen warning. There is no automatic update: the
  update wizard runs only when you open it.
- **Update wizard, not yet run for real:** the lookup against the real GitHub API (with a real
  token) and the final step on Windows (starting the installer, closing Keel) have not been
  exercised yet. If starting the installer fails, the wizard says so; the checked installer
  is in `%APPDATA%\app.keel.planner\updates\` and can be run by hand.
- **Notifications** are implemented but have not been verified end to end on any OS. On
  Windows, toast notifications typically need the installed app, not `npm run dev`.
- **No in-app encryption at rest.** Rely on BitLocker, Device encryption, FileVault, or LUKS.
- **Single device.** There is no sync between computers (by design). To move data, use
  Save backup file… and Restore from file….
- **Accessibility:**
  - Implemented: labelled controls, keyboard operation (including the focus bar), and
    reduced-motion support.
  - Not done: an audit with Narrator or NVDA.
- **Localization:** English only.
- **Integration limits:**
  - **Outlook series:** cancelled occurrences are known only inside the sync window (60 days
    back, one year ahead). A series whose pattern or time zone Keel cannot express, such as
    Outlook's “Customized Time Zone”, is stored occurrence by occurrence.
  - **Jira:** completing needs a transition into the Done category that asks for no required
    fields. Otherwise Keel reports it and leaves the issue open.
  - Only completion is written back. Title and note edits stay in Keel.
  - **`.msg` import** ignores attachments and embedded messages.

## License

MIT
