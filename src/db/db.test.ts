import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '@/test/testDb';
import { Database } from './driver';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  NewerSchemaError,
  currentSchemaVersion,
  migrate,
} from './migrate';
import { SqlJsDriver } from './sqljsDriver';
import { peekUndo, undoLast, undoable } from './undo';

const now = '2026-09-25T12:00:00.000Z';

async function insertTask(
  db: Database | Parameters<Parameters<Database['transaction']>[0]>[0],
  id: string,
  title = id,
) {
  await db.run('INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', [
    id,
    title,
    now,
    now,
  ]);
}

describe('migrations', () => {
  it('applies all migrations to an empty database and is idempotent', async () => {
    const db = await createTestDb();
    expect(await currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const again = await migrate(db);
    expect(again.applied).toEqual([]);
  });

  it('calls beforeMigrate only for databases that already have data', async () => {
    const sqlJs = await initSqlJs();
    const db = new Database(await SqlJsDriver.create(sqlJs));
    const calls: number[][] = [];
    await migrate(
      db,
      { beforeMigrate: async (p) => void calls.push(p.map((m) => m.version)) },
      MIGRATIONS.slice(0, 1),
    );
    expect(calls).toEqual([]);
    const extra = { version: 9999, name: 'extra', sql: 'CREATE TABLE extra_test (x INTEGER);' };
    await migrate(db, { beforeMigrate: async (p) => void calls.push(p.map((m) => m.version)) }, [
      ...MIGRATIONS.slice(0, 1),
      extra,
    ]);
    expect(calls).toEqual([[9999]]);
  });

  it('refuses to open a database from a newer version', async () => {
    const db = await createTestDb();
    await db.run("INSERT INTO schema_migrations VALUES (99999, 'future', ?)", [now]);
    await expect(migrate(db)).rejects.toBeInstanceOf(NewerSchemaError);
  });

  it('rolls back a failing migration completely', async () => {
    const sqlJs = await initSqlJs();
    const db = new Database(await SqlJsDriver.create(sqlJs));
    const bad = {
      version: 1,
      name: 'bad',
      sql: 'CREATE TABLE ok_table (x); CREATE TABLE broken (',
    };
    await expect(migrate(db, {}, [bad])).rejects.toThrow();
    const t = await db.get<{ n: number }>(
      "SELECT count(*) AS n FROM sqlite_master WHERE name = 'ok_table'",
    );
    expect(t?.n).toBe(0);
  });
});

describe('driver', () => {
  it('commits and rolls back transactions', async () => {
    const db = await createTestDb();
    await db.transaction(async (tx) => insertTask(tx, 'a'));
    await expect(
      db.transaction(async (tx) => {
        await insertTask(tx, 'b');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await db.all<{ id: string }>('SELECT id FROM tasks');
    expect(rows.map((r) => r.id)).toEqual(['a']);
  });

  it('serializes concurrent callers around a transaction', async () => {
    const db = await createTestDb();
    const order: string[] = [];
    const tx = db.transaction(async (t) => {
      order.push('tx-start');
      await insertTask(t, 'x');
      await new Promise((r) => setTimeout(r, 20));
      order.push('tx-end');
    });
    const read = db.all('SELECT id FROM tasks').then((rows) => {
      order.push(`read:${rows.length}`);
    });
    await Promise.all([tx, read]);
    expect(order).toEqual(['tx-start', 'tx-end', 'read:1']);
  });

  it('enforces foreign keys and one running timer', async () => {
    const db = await createTestDb();
    await expect(
      db.run(
        "INSERT INTO subtasks (id, task_id, title, created_at, updated_at) VALUES ('s', 'missing', 't', ?, ?)",
        [now, now],
      ),
    ).rejects.toThrow(/FOREIGN KEY/i);
    await insertTask(db, 't1');
    await db.run(
      "INSERT INTO time_sessions (id, task_id, start_utc, created_at, updated_at) VALUES ('s1', 't1', ?, ?, ?)",
      [now, now, now],
    );
    await expect(
      db.run(
        "INSERT INTO time_sessions (id, task_id, start_utc, created_at, updated_at) VALUES ('s2', 't1', ?, ?, ?)",
        [now, now, now],
      ),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it('allows only one current plan entry per task', async () => {
    const db = await createTestDb();
    await insertTask(db, 't1');
    await db.run(
      "INSERT INTO day_plan_entries (id, task_id, plan_date, status, created_at) VALUES ('p1','t1','2026-09-25','active',?)",
      [now],
    );
    await db.run(
      "INSERT INTO day_plan_entries (id, task_id, plan_date, status, created_at) VALUES ('p0','t1','2026-09-24','rolled_over',?)",
      [now],
    );
    await expect(
      db.run(
        "INSERT INTO day_plan_entries (id, task_id, plan_date, status, created_at) VALUES ('p2','t1','2026-09-26','active',?)",
        [now],
      ),
    ).rejects.toThrow(/UNIQUE/i);
  });
});

describe('undo log', () => {
  it('reverts inserts, updates and deletes of one step', async () => {
    const db = await createTestDb();
    await insertTask(db, 'keep', 'Original');
    await undoable(db, 'Edit', async (tx) => {
      await insertTask(tx, 'new');
      await tx.run("UPDATE tasks SET title = 'Changed', priority = 2 WHERE id = 'keep'");
    });
    expect((await peekUndo(db))?.label).toBe('Edit');
    await undoLast(db);
    const rows = await db.all<{ id: string; title: string; priority: number }>(
      'SELECT id, title, priority FROM tasks',
    );
    expect(rows).toEqual([{ id: 'keep', title: 'Original', priority: 0 }]);
    expect(await peekUndo(db)).toBeNull();
  });

  it('restores cascaded children and SET NULL references', async () => {
    const db = await createTestDb();
    await db.run(
      "INSERT INTO projects (id, name, color, created_at, updated_at) VALUES ('p', 'Proj', '#000', ?, ?)",
      [now, now],
    );
    await insertTask(db, 't');
    await db.run("UPDATE tasks SET project_id = 'p' WHERE id = 't'");
    await db.run(
      "INSERT INTO subtasks (id, task_id, title, created_at, updated_at) VALUES ('s1', 't', 'one', ?, ?)",
      [now, now],
    );
    await db.run(
      "INSERT INTO day_plan_entries (id, task_id, plan_date, status, created_at) VALUES ('e','t','2026-09-25','active',?)",
      [now],
    );

    await undoable(db, 'Delete project', (tx) => tx.run("DELETE FROM projects WHERE id = 'p'"));
    expect(
      (await db.get<{ project_id: string | null }>("SELECT project_id FROM tasks WHERE id='t'"))
        ?.project_id,
    ).toBeNull();
    await undoLast(db);
    expect(
      (await db.get<{ project_id: string | null }>("SELECT project_id FROM tasks WHERE id='t'"))
        ?.project_id,
    ).toBe('p');

    await undoable(db, 'Delete task', (tx) => tx.run("DELETE FROM tasks WHERE id = 't'"));
    expect((await db.all('SELECT * FROM subtasks')).length).toBe(0);
    await undoLast(db);
    expect((await db.all('SELECT * FROM subtasks')).length).toBe(1);
    expect((await db.all("SELECT * FROM day_plan_entries WHERE status='active'")).length).toBe(1);
  });

  it('does not record changes made outside an undo step', async () => {
    const db = await createTestDb();
    await insertTask(db, 'plain');
    expect(await peekUndo(db)).toBeNull();
    await undoable(db, 'No-op', async () => undefined);
    expect(await peekUndo(db)).toBeNull();
  });

  it('only restores columns changed in the step', async () => {
    const db = await createTestDb();
    await insertTask(db, 't', 'A');
    await undoable(db, 'Rename', (tx) => tx.run("UPDATE tasks SET title='B' WHERE id='t'"));
    // A later, unrecorded change to a different column survives the undo.
    await db.run("UPDATE tasks SET notes='kept' WHERE id='t'");
    await undoLast(db);
    expect(await db.get("SELECT title, notes FROM tasks WHERE id='t'")).toEqual({
      title: 'A',
      notes: 'kept',
    });
  });

  it('handles quotes and nulls in restored values', async () => {
    const db = await createTestDb();
    await insertTask(db, 't', 'It\'s "quoted"');
    await db.run("UPDATE tasks SET notes = 'line1\nline2', estimate_min = NULL WHERE id='t'");
    await undoable(db, 'Delete', (tx) => tx.run("DELETE FROM tasks WHERE id='t'"));
    await undoLast(db);
    expect(await db.get("SELECT title, notes, estimate_min FROM tasks WHERE id='t'")).toEqual({
      title: 'It\'s "quoted"',
      notes: 'line1\nline2',
      estimate_min: null,
    });
  });
});
