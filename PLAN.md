# Keel — build plan

Keel is a local-first daily planner (original brand; inspired by the _workflow breadth_ of
Sunsama, not its name, artwork, copy, or code). This file is the working plan: feature
inventory, architecture, progress, and known limitations. It is kept honest — a feature is
only marked done once it has been exercised by an automated test or a manual run noted here.

## Environment (inspected 2026-09-25)

- Repo: empty at start (branch `claude/funny-hawking-onirwa`).
- Build host: Ubuntu 24.04 x86_64, Node 22, pnpm/npm, Rust 1.94, WebKitGTK 4.1, WebKitWebDriver, Xvfb.
- Stack decision: **Tauri 2 + React 19 + TypeScript 6 + SQLite (rusqlite, bundled) + small Rust backend.**
  Nothing in this environment argued against the preferred stack.
- **Primary target: Windows 10/11 x64** (confirmed by the user). Consequences:
  - UI runs in WebView2 (Chromium); installers are NSIS (per-user, no admin) and MSI.
  - Secrets go to Windows Credential Manager (`keyring` crate, `windows-native`).
  - Data lives in `%APPDATA%\app.keel.planner\`.
  - Encryption at rest: BitLocker / Device Encryption is the documented prerequisite. SQLCipher was
    evaluated and not shipped: its vendored OpenSSL build needs Perl/NASM on Windows, which makes
    builds fragile, and inventing custom crypto is not acceptable.
  - Verification: this build host is Linux, so the GUI is exercised end-to-end here on WebKitGTK.
    An MSVC cross-build with `cargo-xwin` was blocked by the sandbox network policy (Microsoft
    CRT/SDK downloads denied); a MinGW cross-build produced a working PE32+ `keel.exe`. The
    GitHub Actions `windows-latest` job is the real Windows verification: unit tests under Node
    on Windows, Rust tests with MSVC (including a Credential Manager round trip), and NSIS + MSI
    installer builds. Anything only verified on Linux is labelled as such in the README.

## Architecture

```
┌──────────────────────────── WebView (React + TS) ─────────────────────────────┐
│ features/*      screens (board, calendar, rituals, focus, review, settings,   │
│                 integrations) read the zustand store (hydrated from SQLite)    │
│ data/actions    one transaction per user action, undo-grouped, targeted refresh│
│ data/repo       all SQL; runs unchanged on sql.js in tests and the web preview │
│ domain/*        pure logic: dates/DST, scheduling, recurrence, rollover,       │
│                 capacity, time accounting, quick capture, stats, ICS           │
│ integrations/*  adapters, sync engine, registry (data-flow disclosures),       │
│                 manager (connect/sync/scheduler/disconnect), .eml parsing      │
│ db/*            driver (serialized queue, transactions), migrations, undo log  │
└──────┬────────────────────────────────────────────────────────────────────────┘
       │ Tauri IPC (invoke)            tests/dev: sql.js driver (same SQL, same migrations)
┌──────▼──────────────────── Rust (src-tauri) ──────────────────────────────────┐
│ db.rs           one rusqlite connection, execute/query/script, backups         │
│                 (VACUUM INTO), restore with safety backup, wipe                │
│ secrets.rs      OS credential store (keyring: Credential Manager / Keychain /  │
│                 Secret Service). Never written to SQLite, never returned to UI │
│ integrations.rs authorized fetch with per-provider host allow-list, token      │
│                 refresh, calendar-feed download                                │
│ oauth.rs        loopback OAuth 2 + PKCE + state, Google revocation             │
│ files.rs        file I/O only at paths chosen in a native dialog               │
│ focusbar.rs     focus bar window: create on show / destroy on hide (no focus   │
│                 steal on Windows), placement, work-area clamping, drag         │
└───────────────────────────────────────────────────────────────────────────────┘
```

Key decisions

- **SQL lives in TypeScript, execution in Rust.** The Rust layer is a thin, serialized
  SQLite executor. The same migrations and repositories run against sql.js in unit tests
  and in a dev-only browser preview, so data logic is tested without a GUI.
- **Transactions**: the TS driver serializes every DB call through a queue; a transaction
  holds the queue, so reads-inside-transactions are safe with the single Rust connection.
- **Undo**: a generic SQLite trigger-based undo log (pattern from sqlite.org/undoredo)
  grouped per user action. Covers cascades and bulk edits uniformly.
- **Time model** (three distinct concepts, never conflated):
  - `tasks.due_date` — deadline, floating calendar date (`YYYY-MM-DD`).
  - `day_plan_entries.plan_date` — the day a task is planned for (floating date).
    One active/done entry per task; history rows (`rolled_over`, `moved`, `removed`)
    power reviews and rollover counts.
  - `time_blocks` — scheduled intervals as UTC instants + the IANA zone they were created in.
  - Calendar events: timed = UTC instants + zone; all-day = floating dates (end exclusive).
- **Timezone change policy**: blocks and events keep their absolute instant. When Keel
  detects that the effective zone changed, it shows a banner listing affected upcoming
  blocks and offers "Keep absolute times" (default) or "Keep local wall-clock times"
  (shifts future blocks). Planned dates and deadlines are floating dates and never move.
- **Recurrence**: RFC 5545 RRULE via `rrule`, evaluated in floating time and converted per
  zone with Luxon (DST-correct). Recurring tasks materialize lazily: past/today occurrences
  become real task rows; future occurrences render as virtual cards and materialize on first
  interaction. `UNIQUE(recurrence_id, recurrence_date)` makes materialization idempotent;
  completing/editing an instance never touches the series.
- **Timer**: sessions are rows with `end_utc NULL` while running (unique partial index ⇒
  one running timer). Elapsed time is computed from wall-clock instants, so restarts are
  lossless. A heartbeat detects sleep/wake gaps and asks whether to keep the gap.
- **Focus bar**: a second window (`focusbar.html`) with its own capability (events + four
  bar commands, no DB/file access). The main window is the single writer: it publishes
  snapshots (`focusbar:state`, monotonic `seq`) and executes the bar's commands
  (`focusbar:command`) one at a time, deduplicated by id, ignored when stale (task mismatch).
  Window creation is serialized in Rust and `showBar()` is single-flight, so two quick show
  requests never build two windows.
- **Integrations**: adapter interfaces for task sources and calendar sources; opt-in only,
  visibly marked as networked. Tokens in the OS credential store. Remote events and local
  blocks are separate tables; mappings are keyed `(account, entity, external_id)` for
  idempotent sync. Keel never edits/deletes a remote item it did not create unless the user
  explicitly asks.

## Feature matrix (priority order)

Status legend: ☑ implemented & tested · ⚠ requires credentials for live verification · ✗ not implemented.
The README's feature-status table is the user-facing, finer-grained version of this.

| #   | Area          | Feature                                                                                                                             | Status                                      |
| --- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 0   | Foundation    | Tauri scaffold, Rust DB executor, TS driver, migrations, lint/format/typecheck, tests                                               | ☑                                           |
| 1   | Core slice    | Quick capture → today plan → timebox → focus timer → complete → shutdown review → persistence                                       | ☑ (E2E)                                     |
| 2   | Planning      | Guided morning ritual, rollover, capacity/overcommit warnings, working hours, buffers                                               | ☑                                           |
| 3   | Tasks         | Inbox, projects, areas, subtasks, tags, links, notes, due/planned/scheduled, priority, search/filter, bulk edit, history, DnD, undo | ☑                                           |
| 4   | Recurrence    | Recurring tasks, series edit, instance completion                                                                                   | ☑                                           |
| 5   | Calendar      | Local calendars, events, all-day, overlaps, conflicts, availability, time zones, week view, ICS import/export                       | ☑                                           |
| 6   | Review        | Day/week review, planned vs actual, local stats, reflections                                                                        | ☑                                           |
| 7   | Customization | Themes, week start, time format, tz, working days, notifications, shortcuts, density, onboarding, command palette                   | ☑ (notification delivery not auto-verified) |
| 8   | Data          | Backup/restore, JSON/CSV/ICS export, delete-all (incl. integration credentials)                                                     | ☑                                           |
| 8b  | Data          | Encryption at rest in-app                                                                                                           | ✗ (documented: BitLocker/FileVault/LUKS)    |
| 9   | Integrations  | Adapter layer, sync engine, OS credential store, OAuth loopback, calendar-feed subscriptions, email (.eml, .msg) → task             | ☑                                           |
| 9b  | Integrations  | Google Calendar (RDATE), Microsoft 365/Outlook (series), Todoist, Asana, Trello, Jira, Notion (completion write-back)               | ⚠                                           |
| 9c  | Integrations  | Email-to-task via forwarding address / IMAP; two-way sync of task edits                                                             | ✗                                           |
| 10  | Delivery      | README, E2E (capture→review), offline start, restart persistence, CI incl. Windows installers                                       | ☑                                           |
| 11  | Focus         | Floating focus bar: always-on-top, controls, drag + remembered position, auto-show toggles, global shortcuts with conflict checks   | ☑ (Linux X11 E2E; see README for others)    |

## Progress log

- 2026-09-25: Inspected environment, wrote plan.
- M0–M1: scaffold, Rust executor, sql.js-backed tests, core vertical slice; E2E of the whole
  capture → plan → timebox → focus → complete → review flow on the real binary.
- M2–M7: rituals, rollover, capacity, week view, task depth, undo log, recurrence (lazy
  materialization), calendar depth + ICS (Windows zone names, VTIMEZONE from real DST
  transitions), reviews with validated chart palette, settings, onboarding, palette, shortcuts.
- M8: backups (auto/manual/pre-migration/pre-restore), restore with schema check, exports,
  delete-all; encryption at rest documented as an OS prerequisite.
- CI: Linux checks, Windows MSVC tests + NSIS/MSI installers, Linux E2E online and offline.
- E2E interactions suite found and fixed four real bugs (drop position after auto-scroll,
  portal clicks opening the task detail, empty column space not droppable, auto-backup right
  after Delete all data).
- M9: provider adapters + contract tests, sync engine, Rust credential store / authorized
  fetch / OAuth, integrations UI with data-flow disclosures, scheduler, disconnect/revoke,
  calendar-feed URLs moved into the credential store, local .eml import, E2E against a
  local mock host. OS credential-store test moved to its own binary (it was skippable when
  another test enabled the E2E file store in the same process).
- M10: README (install, build, data location, privacy, backup, integrations, feature
  status, gaps); time-zone-change policy unit test; full E2E rerun online and offline.
- Focus bar: always-on-top bar window, main-window controller (single authority,
  exactly-once commands), auto-show toggles, drag with remembered and clamped position,
  reset command, global shortcuts with conflict detection (in-app, system-reserved,
  already-registered), Wayland warning. E2E on X11 (openbox + xcompmgr) with a real second
  app, real mouse clicks and shortcut key presses; the same suite runs on Windows via a small
  Win32 helper (winctl.cs). Found and fixed: moves reported while the WM places a window were
  saved as the user's position; the drag handle needed a native drag; a sleep "gap" prompt
  could restart the wrong task; Focus mode + timer start could build two bar windows.
- Integration limits fixed: Outlook series stored as series (RRULE from the recurrence
  pattern, exceptions as overrides, EXDATEs from the instance list); Google/ICS `RDATE`;
  completion write-back for Jira (Done-category transition), Trello (due / list / archive)
  and Notion (checkbox, Status, Select); classic Outlook `.msg` import (own CFB/MAPI reader).
- CI: macOS job (unit + Rust tests, `.app` build); Windows E2E job (WebView2).
- After the owner installed the CI build on Windows: bug sweep and requests.
  - Workload: "more than time left" replaced ("2h won't fit today"); tasks timeboxed later
    today count as scheduled.
  - Task cards showed a leftover block from another day; now the card's own day, or the next
    block with its weekday.
  - Focus timer reworked on Sunsama's workflow (original visuals): one actual-vs-planned
    clock everywhere (Focus mode, focus bar, sidebar), resume continues the count, editable
    planned time, subtasks and notes, up next.
  - Color themes (Keel, Ocean, Iris, Rose, Graphite; light and dark; contrast-tested).
  - Smaller: "<1m" instead of "0m" for seconds of tracked time, clearer estimate wording,
    backup times in the user's 12/24 h format, round bar button.
- Releases: a version bump pushed to main or a claude/ branch builds and publishes a GitHub
  Release (installers, SHA256SUMS.txt, changelog notes); 0.2.0 was the first.
- Update wizard (0.3.0): opt-in lookup of the latest release with a read-only token (OS
  credential store, api.github.com only), download via GitHub's redirect without the token,
  SHA-256 check, backup, start installer and close (Windows); or a user-downloaded installer.
  E2E against a mock GitHub; the live API and the Windows install step are not yet run.
- Windows E2E runs: msedgedriver attaches over classic WebDriver to the DevTools port that a
  build-time config override opens (test builds only). Core flow 12/12 and focus bar 3/5
  pass on WebView2. The bar's measured size includes Windows' 1px frame (check allows ±2px);
  the position test now stays inside the runner's 1024×768 screen (Keel correctly pulled
  the off-screen bar back).

## Known limitations / open questions

- Live verification of any OAuth/API integration requires user-supplied credentials; none
  has been run against a live account.
- Windows UI flows (WebView2) are partly verified by automated E2E: the core flow (12 steps)
  and 3 of 5 focus-bar steps pass (on top without taking focus, pause/resume, global
  shortcuts). Position across restart and completing from the bar are pending; the
  integration and interaction suites run on Linux only. CI also covers Windows unit/Rust tests
  and installer builds; the CI installer has been installed and used by hand on Windows.
- Installers are unsigned (SmartScreen warning); no auto-update.
- Notification delivery is not verified end to end on any OS.
- macOS: builds and passes unit and Rust tests in CI; the UI is not driven by tests
  (tauri-driver has no macOS support).
- Focus bar on Linux Wayland: no always-on-top and no global shortcuts (compositor policy);
  the app says so in Settings.
