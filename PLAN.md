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
  - Verification: this build host is Linux, so the app is exercised end-to-end here on WebKitGTK;
    a Windows NSIS installer is cross-compiled with `cargo-xwin` where possible, and a GitHub
    Actions `windows-latest` workflow builds and tests natively. Anything only verified on Linux
    is labelled as such.

## Architecture

```
┌──────────────────────────── WebView (React + TS) ─────────────────────────────┐
│ features/*  (Today board, Week, Calendar, Focus, Rituals, Review, Settings…) │
│      │ read: zustand store (in-memory, hydrated from SQLite)                  │
│      ▼ write: services/* (one transaction per user action, undo-grouped)       │
│ domain/*  pure logic — scheduling, recurrence, rollover, capacity, time acct, │
│           quick-capture parsing, ICS mapping. 100% unit-testable, no I/O.      │
│ db/*      SqlDriver interface ─ migrations (SQL files) ─ undo log ─ repos      │
│      │                                                                        │
└──────┼────────────────────────────────────────────────────────────────────────┘
       │ Tauri IPC (invoke)            tests/dev: sql.js driver (same SQL, same migrations)
┌──────▼──────────────────── Rust (src-tauri) ──────────────────────────────────┐
│ db.rs        one rusqlite connection, execute/query/batch, backup (VACUUM INTO)│
│ secrets.rs   OS credential store (keyring: Keychain / Cred. Manager / Secret   │
│              Service). Tokens never enter SQLite, never returned to the UI.    │
│ oauth.rs     loopback (127.0.0.1) OAuth 2 + PKCE, state check, token refresh  │
│ http.rs      allow-listed authorized fetch for opt-in integrations            │
│ files.rs     export/import/backup file I/O at user-chosen paths               │
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
- **Integrations**: adapter interfaces for task sources and calendar sources; opt-in only,
  visibly marked as networked. Tokens in the OS credential store. Remote events and local
  blocks are separate tables; mappings are keyed `(account, entity, external_id)` for
  idempotent sync. Keel never edits/deletes a remote item it did not create unless the user
  explicitly asks.

## Feature matrix (priority order)

Status legend: ☐ todo · ◐ in progress · ☑ implemented & tested · ⚠ requires credentials for live verification · ✗ not implemented

| #   | Area          | Feature                                                                                                                             | Status |
| --- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 0   | Foundation    | Tauri scaffold, Rust DB executor, TS driver, migrations, lint/format/typecheck, tests                                               | ☐      |
| 1   | Core slice    | Quick capture → today plan → timebox → focus timer → complete → shutdown review → persistence                                       | ☐      |
| 2   | Planning      | Guided morning ritual, rollover, capacity/overcommit warnings, working hours                                                        | ☐      |
| 3   | Tasks         | Inbox, projects, areas, subtasks, tags, links, notes, due/planned/scheduled, priority, search/filter, bulk edit, history, DnD, undo | ☐      |
| 4   | Recurrence    | Recurring tasks, series edit, instance completion                                                                                   | ☐      |
| 5   | Calendar      | Local calendars, events, all-day, overlaps, conflicts, availability, time zones, week view, ICS import/export                       | ☐      |
| 6   | Review        | Day/week review, planned vs actual, local stats, reflections                                                                        | ☐      |
| 7   | Customization | Themes, week start, time format, tz, working days, notifications, shortcuts, density, onboarding, command palette                   | ☐      |
| 8   | Data          | Backup/restore, JSON/CSV/ICS export, delete-all, encryption at rest (evaluate)                                                      | ☐      |
| 9   | Integrations  | Adapter layer, ICS subscription, Google Calendar, Microsoft Calendar, Todoist, others as feasible                                   | ☐      |
| 10  | Delivery      | README, E2E (capture→review), offline start, restart persistence                                                                    | ☐      |

## Progress log

- 2026-09-25: Inspected environment, wrote plan.

## Known limitations / open questions

- Live verification of any OAuth/API integration requires user-supplied credentials.
