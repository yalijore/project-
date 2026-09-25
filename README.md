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

Every push builds Windows installers in GitHub Actions (job **“Windows build, tests and
installers”**, artifact **`keel-windows-installers`**):

| File                              | Installs to       | Admin rights |
| --------------------------------- | ----------------- | ------------ |
| `Keel_0.1.0_x64-setup.exe` (NSIS) | Your user profile | Not needed   |
| `Keel_0.1.0_x64_en-US.msi`        | Program Files     | Needed       |

- The installers are **not code-signed**, so Windows SmartScreen will warn you. Choose
  **More info → Run anyway**.
- Keel uses the Microsoft Edge **WebView2** runtime. It ships with Windows 11 and current
  Windows 10. If it is missing, the installer downloads it.
- To uninstall, use **Settings → Apps**. Uninstalling does not delete your data (see
  [section 4](#4-your-data-and-privacy)).

## 2. Build and run from source

### Prerequisites

|                 | Windows 10/11 (primary)                                                     | macOS                    | Linux (Ubuntu 24.04)                                                                                  |
| --------------- | --------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| C/C++ toolchain | Visual Studio 2022 **Build Tools**, workload “Desktop development with C++” | Xcode Command Line Tools | `build-essential`                                                                                     |
| Rust            | [rustup](https://rustup.rs), default `x86_64-pc-windows-msvc` toolchain     | rustup                   | rustup                                                                                                |
| Node.js         | 22 LTS                                                                      | 22 LTS                   | 22 LTS                                                                                                |
| Web view        | WebView2 (preinstalled)                                                     | built in                 | `libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev` |
| Status          | built and unit-tested in CI                                                 | **not verified**         | built, unit-tested and E2E-tested                                                                     |

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
- **Focus** (`Shift+F`) is a full-screen timer for the task you're on. It keeps running across
  restarts. After sleep, it asks whether the gap counts as work time.
- **Review** compares planned and actual time per day or week, as charts and tables.
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
  integration.
- **No account, telemetry, analytics, crash reporting, or cloud AI.** Search, statistics, and
  auto-scheduling all run locally.
- **Integrations are opt-in and networked.** Each one shows what it downloads, what it sends,
  which hosts it contacts, and what it can change, before you connect it. See
  [section 6](#6-integrations-optional-networked).
- **Credentials are never stored in the database.** Integration tokens, API keys, and private
  calendar-feed addresses live in the OS credential store:
  - Windows: **Windows Credential Manager**.
  - macOS: Keychain.
  - Linux: Secret Service.

  The web view never sees them.

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

**Tasks**

| Provider   | Auth                                                   | Keel downloads                          | Keel may write (opt-in)        | Scopes                                                |
| ---------- | ------------------------------------------------------ | --------------------------------------- | ------------------------------ | ----------------------------------------------------- |
| Todoist    | Personal API token                                     | Open tasks                              | Close and reopen               | Full-access token; Keel calls only the task endpoints |
| Asana      | Personal access token                                  | Incomplete tasks assigned to you        | Complete and incomplete        | Your user's access                                    |
| Trello     | API key + token                                        | Open cards you're a member of           | The due date's “complete” flag | read (+write)                                         |
| Jira Cloud | Email + API token, to your `*.atlassian.net` site only | Unresolved issues assigned to you       | Nothing (read-only)            | Your user's access                                    |
| Notion     | Internal integration secret                            | Pages in one database you share with it | Tick a “done” checkbox         | Only pages you connect                                |

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

**Integrations → Import .eml…** (also in the command palette) turns a saved email into an Inbox
task. The subject becomes the title; the sender, date, and message text become notes.

- Keel reads the file locally and never connects to a mailbox.
- Supported: MIME, encoded headers, quoted-printable and base64 bodies, and legacy
  character sets.
- Classic Outlook's binary `.msg` format is not supported.

## 7. Time zones and DST

Keel keeps three kinds of time separate:

- **Deadlines** and **planned days** are floating calendar dates. They never shift when you
  travel.
- **Time blocks** are stored as UTC instants, together with the zone they were created in.
- **Calendar events:**
  - Timed events are UTC instants plus their zone. Recurring events expand in their own zone,
    so a 09:00 weekly meeting stays at 09:00 across DST.
  - All-day events are floating dates.
  - Windows zone names in `.ics` files, such as `W. Europe Standard Time`, are mapped to IANA
    zones.

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
- **The web view is locked down.** A strict CSP allows no remote origins. It cannot pass file
  paths to Rust, read credentials, or send credentials to a host outside a provider's
  allow-list.

## 9. Development and tests

| Command                    | What it does                                                  |
| -------------------------- | ------------------------------------------------------------- |
| `npm run dev`              | Desktop app with hot reload                                   |
| `npm run check`            | Typecheck, ESLint, Prettier check, all unit tests, Rust tests |
| `npm run lint:rust`        | `cargo clippy -D warnings` + `cargo fmt --check`              |
| `npm test`                 | Vitest: domain, repository, migrations, undo, integrations    |
| `npm run test:rust`        | Rust unit tests + OS credential-store round trip              |
| `npm run e2e`              | Builds the app and drives the real binary (Linux)             |
| `npm run e2e -- --offline` | Same, inside a network namespace with only loopback           |

### Test coverage

- **Unit tests (Vitest, 140+):**
  - scheduling, auto-timeboxing, and conflicts;
  - recurrence (floating and zoned, across DST);
  - rollover, time accounting, and capacity;
  - migrations, the undo log, and ICS import/export (including VTIMEZONE generation);
  - the time-zone-change policy;
  - quick-capture parsing and statistics.
- **Integration contract tests** run each adapter against recorded fixtures: pagination,
  mapping, sync tokens and delta links, 410 resync, deletions, and write-back. Sync-engine
  tests run against a real SQLite database: idempotency, conflicts, deselection, and removal.
  Manager tests cover rollback, error states, scheduling, disconnect, and Delete all data.
- **Rust tests** cover the database, backups, restore safety, host allow-lists, secret
  validation, PKCE (RFC 7636 vectors), and the OAuth callback. The OS credential-store round
  trip runs in its own binary: always on Windows (Credential Manager), and on Linux with
  `KEEL_TEST_OS_STORE=1`.
- **End-to-end (25 steps, real desktop binary through tauri-driver and WebKitWebDriver under
  Xvfb):**
  - the core flow: onboarding → capture → plan → timebox → focus → complete → shutdown →
    review;
  - undo, backups and exports, and restart persistence (including a running timer), plus
    sleep and wake;
  - keyboard use, drag and drop, and drag-to-timebox;
  - recurring tasks, bulk edit, and ICS import;
  - calendar-feed integration against a mock host, and email import;
  - restore and Delete all data.

  The whole suite also runs **offline**.

To run the E2E suite locally on Linux, install `webkit2gtk-driver` and `xvfb`, then run
`cargo install tauri-driver --locked`. The E2E suite does not currently run on Windows (see
[section 11](#11-known-gaps)).

### CI

`.github/workflows/ci.yml` runs three jobs:

- **Linux:** lint, typecheck, unit and Rust tests.
- **Windows:** unit tests under Node on Windows, Rust tests with MSVC (including Credential
  Manager), and a release build of the NSIS and MSI installers.
- **Linux E2E:** online and offline.

## 10. Feature status

Legend:

- ✅ **implemented**: tested as noted.
- 🔑 **requires credentials for live verification**: implemented and contract-tested, never
  run against the live service.
- ❌ **not implemented**

| Area          | Feature                                                                                          | Status          | Verified by                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------ | --------------- | ----------------------------------------------------------------------------- |
| Planning      | Daily planning ritual (review, estimate, auto-timebox, workload, intention)                      | ✅              | E2E                                                                           |
|               | Shutdown ritual, reflection, weekly review                                                       | ✅              | E2E (shutdown), unit                                                          |
|               | Carry-forward / rollover (auto or manual)                                                        | ✅              | unit                                                                          |
|               | Capacity and overcommit warnings, working hours and days, meeting buffers                        | ✅              | unit                                                                          |
| Tasks         | Inbox, backlog, projects, areas, tags                                                            | ✅              | unit, E2E                                                                     |
|               | Subtasks, notes, links, priority, estimates                                                      | ✅              | unit, E2E                                                                     |
|               | Deadline vs planned day vs time block, kept separate                                             | ✅              | unit                                                                          |
|               | Recurring tasks (virtual future occurrences, series edit)                                        | ✅              | unit, E2E                                                                     |
|               | Quick capture with natural-language parsing                                                      | ✅              | unit, E2E                                                                     |
|               | Search, completion history, bulk edit                                                            | ✅              | E2E (bulk), unit                                                              |
|               | Drag and drop (days, backlog, calendar) plus keyboard equivalents                                | ✅              | E2E                                                                           |
|               | Undo for every change                                                                            | ✅              | unit, E2E                                                                     |
| Calendar      | Local calendars, events, all-day and recurring events, conflicts, week view                      | ✅              | unit, E2E                                                                     |
|               | Time zones, DST, secondary zone, time-zone-change policy                                         | ✅              | unit                                                                          |
|               | ICS import (idempotent, Windows zone names) and export                                           | ✅              | unit, E2E                                                                     |
|               | Calendar-feed subscriptions                                                                      | ✅              | unit, E2E (mock host)                                                         |
| Focus         | Timer persisted across restarts, with sleep/wake detection                                       | ✅              | unit, E2E                                                                     |
|               | Notifications (block start, estimate reached, shutdown reminder)                                 | ✅ implemented  | not automatically verified: OS delivery is untested, including Windows toasts |
| Review        | Day and week review, planned vs actual, charts with table views                                  | ✅              | unit, E2E                                                                     |
| Customization | Themes, density, week start, 12/24 h, time zone, working days, notifications, shortcut rebinding | ✅              | unit, manual                                                                  |
|               | Onboarding without an account, command palette                                                   | ✅              | E2E                                                                           |
| Data          | Backup and restore, JSON/CSV/ICS export, Delete all data                                         | ✅              | Rust tests, E2E                                                               |
|               | Encryption at rest                                                                               | ❌ in-app       | Documented: use BitLocker, FileVault or LUKS                                  |
| Integrations  | Google Calendar (read, optional block mirroring)                                                 | 🔑              | contract tests                                                                |
|               | Outlook / Microsoft 365 calendar                                                                 | 🔑              | contract tests                                                                |
|               | Todoist, Asana, Trello, Notion (import + completion write-back)                                  | 🔑              | contract tests                                                                |
|               | Jira Cloud (read-only)                                                                           | 🔑              | contract tests                                                                |
|               | Email → task from saved `.eml` files (local)                                                     | ✅              | unit, E2E                                                                     |
|               | Email → task through a forwarding address or mailbox (IMAP)                                      | ❌              | —                                                                             |
|               | Two-way sync of task edits (titles and notes pushed back)                                        | ❌              | Only completion is written back                                               |
| Platform      | Windows installers (NSIS, MSI)                                                                   | ✅              | CI build                                                                      |
|               | Windows Credential Manager storage                                                               | ✅              | CI Rust test on Windows                                                       |
|               | macOS build                                                                                      | ❌ not verified | Should compile; never built                                                   |

## 11. Known gaps

- **No live integration test.** Adapters follow the providers' documented APIs and pass
  contract tests. Real accounts may still differ: permissions, tenant policies, or API
  changes.
- **The Windows GUI is not driven by automated tests.** The E2E suite runs on Linux
  (WebKitGTK). On Windows, CI covers unit tests, Rust tests (including Credential Manager),
  and the installer build, but not WebView2 UI flows. WebView2 is Chromium-based while the
  E2E engine is WebKit, so rendering differences are possible.
- **Unsigned installers.** Expect a SmartScreen warning. There is no auto-update.
- **Notifications** are implemented but have not been verified end to end on any OS. On
  Windows, toast notifications typically need the installed app, not `npm run dev`.
- **No in-app encryption at rest.** Rely on BitLocker, Device encryption, FileVault, or LUKS.
- **Single device.** There is no sync between computers (by design). To move data, use
  Save backup file… and Restore from file….
- **Accessibility:**
  - Implemented: labelled controls, keyboard operation, and reduced-motion support.
  - Not done: an audit with Narrator or NVDA.
- **Localization:** English only.
- **Integration limits:**
  - Microsoft series arrive as individual occurrences.
  - Google `RDATE` rules are ignored.
  - Jira issues cannot be completed from Keel.
  - Trello completion is the due-date checkbox.
  - Notion write-back needs a checkbox property.
  - Classic Outlook `.msg` files cannot be imported.

## License

MIT
