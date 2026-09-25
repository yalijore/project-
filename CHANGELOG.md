# Changelog

Each version's section is also its release notes on GitHub.

## Unreleased

**Fixed**

- The date number in each day's header sat higher than the weekday next to it; it now sits on
  the weekday's line.

## 0.3.0 — 2026-09-25

Install `Keel_0.3.0_x64-setup.exe` over your current Keel (no admin rights needed); your data
stays where it is. From this version on, you can update from inside Keel.

**New**

- **Update Keel…** (Settings → About, or the command palette): a wizard that
  - checks the repository's Releases for a newer version with a read-only GitHub token you add
    once (kept in Windows Credential Manager, sent only to api.github.com), shows what's new,
    downloads the installer and checks it against the release's `SHA256SUMS.txt`; or
  - takes an installer you downloaded yourself and shows its SHA-256;
  - then backs up your data, starts the installer, and closes Keel.

  Keel never checks for updates by itself. Delete all data also removes the token and any
  downloaded installer.

## 0.2.0 — 2026-09-25

Install `Keel_0.2.0_x64-setup.exe` (no admin rights needed) over your current Keel. Your data
stays where it is (`%APPDATA%\app.keel.planner\`). The installer is not code-signed, so
Windows may warn you: choose **More info → Run anyway**.

**Focus**

- The timer shows the task's **actual time against its planned time** everywhere (Focus mode,
  the floating focus bar, and the sidebar), for example `12:04 / 30:00`. Pausing and resuming
  continues the count.
- Focus mode, reworked: Actual and Planned side by side (click Planned to change it), one
  start/pause button, Complete, a progress line, subtasks you can tick or add, notes, and
  **Up next** to start the next task in one click.
- Focus bar: complete · title · actual / planned · start/pause · hide.

**New**

- **Color themes** in Settings → General: Keel, Ocean, Iris, Rose, and Graphite, each in light
  and dark.
- Classic Outlook **`.msg`** files can be imported as tasks, next to `.eml`.
- Outlook recurring meetings sync as real series; Google and `.ics` extra dates (`RDATE`) are
  honoured.
- Completing an imported task can update **Jira** (a transition to Done), **Trello** (due
  date, a “Done” list, or archive), and **Notion** (a Done checkbox, a Status, or a Select).

**Fixed**

- The day's workload warning: “more than time left” is now, for example, “2h won't fit
  today”, and tasks timeboxed later in the day count as scheduled.
- A task card could show a time block left behind on another day.
- Review showed “0m” for a few seconds of tracked time, and “100% under” for estimates.
- Backup times ignored the 12/24-hour setting.
- Opening Focus mode and starting the timer at once could open two focus bars.

## 0.1.0 — 2026-09-25

First version: planning and shutdown rituals, tasks, calendar with time zones, focus timer and
floating focus bar, review, backups and exports, and optional integrations.
