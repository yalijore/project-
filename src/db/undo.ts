/**
 * Generic undo using SQLite triggers (the pattern described at sqlite.org/undoredo.html).
 *
 * While an undo group is open (undo_state.current_group is set), AFTER triggers on every
 * user-data table append the inverse statement of each change to `undo_log`. Undoing a group
 * replays its inverse statements newest-first inside one transaction. Because the triggers
 * see every row change — including foreign-key cascades — deletes, bulk edits and moves are
 * all reversible without per-feature undo code.
 *
 * Undo is strictly LIFO: only the most recent group can be undone, which guarantees each
 * inverse statement runs against exactly the state it was recorded from.
 */
import type { Database, Executor } from './driver';

export const UNDO_TABLES = [
  'areas',
  'projects',
  'recurrence_series',
  'recurrence_exceptions',
  'tasks',
  'subtasks',
  'tags',
  'task_tags',
  'task_links',
  'day_plan_entries',
  'calendars',
  'calendar_events',
  'time_blocks',
  'time_sessions',
  'rituals',
] as const;

/** How many undo groups are kept. Older ones are discarded. */
export const UNDO_HISTORY_LIMIT = 100;

const CURRENT = '(SELECT current_group FROM undo_state WHERE id = 1)';

function q(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export async function installUndoTriggers(db: Executor): Promise<void> {
  const statements: string[] = [];
  for (const table of UNDO_TABLES) {
    const columns = (await db.all<{ name: string }>(`PRAGMA table_info(${q(table)})`)).map(
      (c) => c.name,
    );
    if (columns.length === 0) continue;
    const guard = `WHEN ${CURRENT} IS NOT NULL`;
    for (const kind of ['insert', 'update', 'delete']) {
      statements.push(`DROP TRIGGER IF EXISTS ${q(`undo_${table}_${kind}`)};`);
    }

    // Only the columns that actually changed are restored, so unrelated later edits
    // (e.g. a timer heartbeat on the same row) are not clobbered by an undo.
    const setList = columns
      .map(
        (c) =>
          `(CASE WHEN old.${q(c)} IS NOT new.${q(c)} THEN '${q(c).replace(/'/g, "''")}=' || quote(old.${q(c)}) || ',' ELSE '' END)`,
      )
      .join(' || ');
    const insertCols = ['rowid', ...columns.map(q)].join(',');
    const insertVals = columns.map((c) => `quote(old.${q(c)})`).join(" || ',' || ");

    statements.push(`
      CREATE TRIGGER ${q(`undo_${table}_insert`)} AFTER INSERT ON ${q(table)} ${guard} BEGIN
        INSERT INTO undo_log (group_id, stmt)
        VALUES (${CURRENT}, 'DELETE FROM ${q(table)} WHERE rowid=' || new.rowid);
      END;`);
    statements.push(`
      CREATE TRIGGER ${q(`undo_${table}_update`)} AFTER UPDATE ON ${q(table)} ${guard} BEGIN
        INSERT INTO undo_log (group_id, stmt)
        VALUES (${CURRENT}, 'UPDATE ${q(table)} SET ' || ${setList} || 'rowid=rowid WHERE rowid=' || old.rowid);
      END;`);
    statements.push(`
      CREATE TRIGGER ${q(`undo_${table}_delete`)} AFTER DELETE ON ${q(table)} ${guard} BEGIN
        INSERT INTO undo_log (group_id, stmt)
        VALUES (${CURRENT}, 'INSERT INTO ${q(table)} (${insertCols}) VALUES (' || old.rowid || ',' || ${insertVals} || ')');
      END;`);
  }
  await db.script(statements.join('\n'));
}

export async function beginUndoGroup(tx: Executor, label: string): Promise<number> {
  const res = await tx.run('INSERT INTO undo_groups (label, created_at) VALUES (?, ?)', [
    label,
    new Date().toISOString(),
  ]);
  await tx.run('UPDATE undo_state SET current_group = ? WHERE id = 1', [res.lastInsertRowid]);
  return res.lastInsertRowid;
}

export async function endUndoGroup(tx: Executor, groupId: number): Promise<void> {
  await tx.run('UPDATE undo_state SET current_group = NULL WHERE id = 1');
  const logged = await tx.get<{ n: number }>(
    'SELECT count(*) AS n FROM undo_log WHERE group_id = ?',
    [groupId],
  );
  if (!logged?.n) {
    await tx.run('DELETE FROM undo_groups WHERE id = ?', [groupId]);
    return;
  }
  const cutoff = groupId - UNDO_HISTORY_LIMIT;
  if (cutoff > 0) {
    await tx.run('DELETE FROM undo_log WHERE group_id <= ?', [cutoff]);
    await tx.run('DELETE FROM undo_groups WHERE id <= ?', [cutoff]);
  }
}

/**
 * Runs `fn` in a transaction whose changes form one undoable step labelled `label`.
 * If `fn` opens no changes, no undo step is recorded.
 */
export async function undoable<T>(
  db: Database,
  label: string,
  fn: (tx: Executor) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const group = await beginUndoGroup(tx, label);
    try {
      return await fn(tx);
    } finally {
      await endUndoGroup(tx, group);
    }
  });
}

export interface UndoStep {
  id: number;
  label: string;
  createdAt: string;
}

export async function peekUndo(db: Executor): Promise<UndoStep | null> {
  const row = await db.get<{ id: number; label: string; created_at: string }>(
    'SELECT id, label, created_at FROM undo_groups ORDER BY id DESC LIMIT 1',
  );
  return row ? { id: row.id, label: row.label, createdAt: row.created_at } : null;
}

/** Reverts the most recent undo group. Returns what was undone, or null if nothing. */
export async function undoLast(db: Database): Promise<UndoStep | null> {
  return db.transaction(async (tx) => {
    const step = await peekUndo(tx);
    if (!step) return null;
    // Replaying a cascade re-inserts children before their parent; defer FK checks to COMMIT.
    await tx.run('PRAGMA defer_foreign_keys = ON');
    const rows = await tx.all<{ stmt: string }>(
      'SELECT stmt FROM undo_log WHERE group_id = ? ORDER BY seq DESC',
      [step.id],
    );
    for (const { stmt } of rows) await tx.run(stmt);
    await tx.run('DELETE FROM undo_log WHERE group_id = ?', [step.id]);
    await tx.run('DELETE FROM undo_groups WHERE id = ?', [step.id]);
    return step;
  });
}
