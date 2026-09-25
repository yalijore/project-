//! A thin, serialized SQLite executor.
//!
//! Keel's schema, migrations and queries live in TypeScript (so the exact same SQL is
//! exercised by unit tests against sql.js). This module owns the single on-disk
//! connection and exposes execute/query primitives plus whole-file operations
//! (backup, restore, wipe) that cannot be expressed as SQL from the web view.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value as JsonValue;

use crate::error::{Error, Result};

pub const DB_FILE: &str = "keel.sqlite3";
const BACKUP_DIR: &str = "backups";
const BACKUP_PREFIX: &str = "keel-backup-";
const BACKUP_EXT: &str = "sqlite3";
/// Automatic backups kept on disk; manual exports are never pruned.
const AUTO_BACKUPS_KEPT: usize = 14;

pub struct Db {
    conn: Mutex<Option<Connection>>,
    pub dir: PathBuf,
    pub path: PathBuf,
}

pub type SharedDb = Arc<Db>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub changes: usize,
    pub last_insert_rowid: i64,
}

#[derive(Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<JsonValue>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub file_name: String,
    pub path: String,
    pub created_ms: u128,
    pub size_bytes: u64,
    pub reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbInfo {
    pub path: String,
    pub data_dir: String,
    pub size_bytes: u64,
    pub sqlite_version: String,
}

fn open_connection(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // FULL keeps committed transactions durable across power loss, not just app crashes.
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

fn json_to_sql(value: &JsonValue) -> SqlValue {
    match value {
        JsonValue::Null => SqlValue::Null,
        JsonValue::Bool(b) => SqlValue::Integer(i64::from(*b)),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else {
                SqlValue::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        JsonValue::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

fn sql_to_json(value: ValueRef<'_>) -> JsonValue {
    match value {
        ValueRef::Null => JsonValue::Null,
        ValueRef::Integer(i) => JsonValue::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        ValueRef::Text(t) => JsonValue::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => JsonValue::Array(b.iter().map(|x| JsonValue::from(*x)).collect()),
    }
}

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn sanitize_reason(reason: &str) -> String {
    let cleaned: String = reason
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(32)
        .collect();
    if cleaned.is_empty() {
        "manual".into()
    } else {
        cleaned
    }
}

/// Returns `Some(max_version)` if `path` is a readable Keel database, checking integrity.
pub fn validate_database_file(path: &Path) -> Result<i64> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if check != "ok" {
        return Err(Error::msg(format!("integrity check failed: {check}")));
    }
    let has_migrations: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
        [],
        |r| r.get(0),
    )?;
    if has_migrations == 0 {
        return Err(Error::msg(
            "not a Keel database (no schema_migrations table)",
        ));
    }
    let version: i64 = conn.query_row(
        "SELECT coalesce(max(version), 0) FROM schema_migrations",
        [],
        |r| r.get(0),
    )?;
    Ok(version)
}

impl Db {
    pub fn open(dir: &Path) -> Result<Self> {
        fs::create_dir_all(dir)?;
        let path = dir.join(DB_FILE);
        let conn = open_connection(&path)?;
        Ok(Db {
            conn: Mutex::new(Some(conn)),
            dir: dir.to_path_buf(),
            path,
        })
    }

    fn lock(&self) -> MutexGuard<'_, Option<Connection>> {
        // A panic while holding the lock cannot leave SQLite itself inconsistent, so recover.
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let guard = self.lock();
        let conn = guard
            .as_ref()
            .ok_or_else(|| Error::msg("database is closed"))?;
        f(conn)
    }

    pub fn execute(&self, sql: &str, params: &[JsonValue]) -> Result<ExecResult> {
        self.with_conn(|c| {
            let mut stmt = c.prepare_cached(sql)?;
            let changes = stmt.execute(params_from_iter(params.iter().map(json_to_sql)))?;
            Ok(ExecResult {
                changes,
                last_insert_rowid: c.last_insert_rowid(),
            })
        })
    }

    pub fn query(&self, sql: &str, params: &[JsonValue]) -> Result<QueryResult> {
        self.with_conn(|c| {
            let mut stmt = c.prepare_cached(sql)?;
            let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
            let n = columns.len();
            let mut rows = stmt.query(params_from_iter(params.iter().map(json_to_sql)))?;
            let mut out = Vec::new();
            while let Some(row) = rows.next()? {
                let mut values = Vec::with_capacity(n);
                for i in 0..n {
                    values.push(sql_to_json(row.get_ref(i)?));
                }
                out.push(values);
            }
            Ok(QueryResult { columns, rows: out })
        })
    }

    pub fn execute_script(&self, sql: &str) -> Result<()> {
        self.with_conn(|c| Ok(c.execute_batch(sql)?))
    }

    /// Rolls back a transaction left open by a web view that reloaded mid-transaction.
    pub fn reset(&self) -> Result<bool> {
        self.with_conn(|c| {
            if c.is_autocommit() {
                Ok(false)
            } else {
                c.execute_batch("ROLLBACK")?;
                Ok(true)
            }
        })
    }

    pub fn info(&self) -> Result<DbInfo> {
        let sqlite_version = self.with_conn(|c| {
            Ok(c.query_row("SELECT sqlite_version()", [], |r| r.get::<_, String>(0))?)
        })?;
        let size_bytes = fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0)
            + fs::metadata(self.path.with_extension("sqlite3-wal"))
                .map(|m| m.len())
                .unwrap_or(0);
        Ok(DbInfo {
            path: self.path.display().to_string(),
            data_dir: self.dir.display().to_string(),
            size_bytes,
            sqlite_version,
        })
    }

    pub fn backup_dir(&self) -> PathBuf {
        self.dir.join(BACKUP_DIR)
    }

    /// Writes a consistent, compacted copy of the live database to `dest`.
    pub fn vacuum_into(&self, dest: &Path) -> Result<()> {
        if dest.exists() {
            fs::remove_file(dest)?;
        }
        let dest_str = dest
            .to_str()
            .ok_or_else(|| Error::msg("backup path is not valid UTF-8"))?
            .to_string();
        self.with_conn(|c| {
            c.execute("VACUUM INTO ?1", [dest_str])?;
            Ok(())
        })
    }

    pub fn create_backup(&self, reason: &str) -> Result<BackupInfo> {
        let dir = self.backup_dir();
        fs::create_dir_all(&dir)?;
        let reason = sanitize_reason(reason);
        let created_ms = now_ms();
        let file_name = format!("{BACKUP_PREFIX}{created_ms}-{reason}.{BACKUP_EXT}");
        let dest = dir.join(&file_name);
        self.vacuum_into(&dest)?;
        let size_bytes = fs::metadata(&dest)?.len();
        self.prune_backups()?;
        Ok(BackupInfo {
            file_name,
            path: dest.display().to_string(),
            created_ms,
            size_bytes,
            reason,
        })
    }

    pub fn list_backups(&self) -> Result<Vec<BackupInfo>> {
        let dir = self.backup_dir();
        if !dir.exists() {
            return Ok(vec![]);
        }
        let mut out = Vec::new();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let Some(rest) = file_name
                .strip_prefix(BACKUP_PREFIX)
                .and_then(|r| r.strip_suffix(&format!(".{BACKUP_EXT}")))
            else {
                continue;
            };
            let mut parts = rest.splitn(2, '-');
            let created_ms = parts
                .next()
                .and_then(|s| s.parse::<u128>().ok())
                .unwrap_or(0);
            let reason = parts.next().unwrap_or("manual").to_string();
            out.push(BackupInfo {
                path: entry.path().display().to_string(),
                file_name,
                created_ms,
                size_bytes: entry.metadata()?.len(),
                reason,
            });
        }
        out.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
        Ok(out)
    }

    fn prune_backups(&self) -> Result<()> {
        // Only automatic backups ("auto", "pre-migration", "pre-restore", ...) are pruned;
        // backups the user explicitly asked for ("manual") are kept.
        let backups = self.list_backups()?;
        for old in backups
            .into_iter()
            .filter(|b| b.reason != "manual")
            .skip(AUTO_BACKUPS_KEPT)
        {
            let _ = fs::remove_file(&old.path);
        }
        Ok(())
    }

    pub fn resolve_backup(&self, file_name: &str) -> Result<PathBuf> {
        // Only plain file names inside the backup directory are accepted.
        if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
            return Err(Error::msg("invalid backup name"));
        }
        let path = self.backup_dir().join(file_name);
        if !path.is_file() {
            return Err(Error::msg("backup not found"));
        }
        Ok(path)
    }

    fn close(&self) -> Result<()> {
        let mut guard = self.lock();
        if let Some(conn) = guard.take() {
            // Checkpoint so the main file is complete before we copy or delete it.
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
            conn.close().map_err(|(_, e)| Error::from(e))?;
        }
        Ok(())
    }

    fn reopen(&self) -> Result<()> {
        let conn = open_connection(&self.path)?;
        *self.lock() = Some(conn);
        Ok(())
    }

    fn remove_db_files(&self) -> Result<()> {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let p = PathBuf::from(format!("{}{}", self.path.display(), suffix));
            if p.exists() {
                fs::remove_file(p)?;
            }
        }
        Ok(())
    }

    /// Replaces the live database with `source` after validating it. A safety backup of the
    /// current database is written first, so a restore can itself be undone.
    pub fn restore_from(&self, source: &Path, max_supported_version: i64) -> Result<BackupInfo> {
        let version = validate_database_file(source)?;
        if version > max_supported_version {
            return Err(Error::msg(format!(
                "this backup was created by a newer version of Keel (schema v{version}); update Keel first"
            )));
        }
        let safety = self.create_backup("pre-restore")?;
        // Copy to a temp file next to the target first so the swap is a same-volume rename.
        let staging = self.dir.join(format!("{DB_FILE}.restoring"));
        fs::copy(source, &staging)?;
        self.close()?;
        let result = (|| -> Result<()> {
            self.remove_db_files()?;
            fs::rename(&staging, &self.path)?;
            Ok(())
        })();
        // Always reopen, even if the swap failed, so the app keeps working.
        let reopen = self.reopen();
        result?;
        reopen?;
        Ok(safety)
    }

    /// Permanently deletes the database and all local backups, then starts empty.
    pub fn wipe(&self) -> Result<()> {
        self.close()?;
        let result = (|| -> Result<()> {
            self.remove_db_files()?;
            let backups = self.backup_dir();
            if backups.exists() {
                fs::remove_dir_all(backups)?;
            }
            Ok(())
        })();
        let reopen = self.reopen();
        result?;
        reopen
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_db() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(dir.path()).unwrap();
        (dir, db)
    }

    fn init_schema(db: &Db) {
        db.execute_script(
            "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);
             INSERT INTO schema_migrations VALUES (1, 'init', 'now');
             CREATE TABLE t(id TEXT PRIMARY KEY, n INTEGER, r REAL, flag INTEGER);",
        )
        .unwrap();
    }

    #[test]
    fn round_trips_values() {
        let (_d, db) = temp_db();
        init_schema(&db);
        let res = db
            .execute(
                "INSERT INTO t VALUES (?1, ?2, ?3, ?4)",
                &[json!("a"), json!(42), json!(1.5), json!(true)],
            )
            .unwrap();
        assert_eq!(res.changes, 1);
        let q = db.query("SELECT id, n, r, flag FROM t", &[]).unwrap();
        assert_eq!(q.columns, vec!["id", "n", "r", "flag"]);
        assert_eq!(q.rows[0], vec![json!("a"), json!(42), json!(1.5), json!(1)]);
    }

    #[test]
    fn reset_rolls_back_open_transaction() {
        let (_d, db) = temp_db();
        init_schema(&db);
        db.execute_script("BEGIN").unwrap();
        db.execute("INSERT INTO t(id) VALUES ('x')", &[]).unwrap();
        assert!(db.reset().unwrap());
        assert!(!db.reset().unwrap());
        assert!(db.query("SELECT * FROM t", &[]).unwrap().rows.is_empty());
    }

    #[test]
    fn backup_and_restore() {
        let (_d, db) = temp_db();
        init_schema(&db);
        db.execute("INSERT INTO t(id) VALUES ('before')", &[])
            .unwrap();
        let backup = db.create_backup("manual").unwrap();
        db.execute("INSERT INTO t(id) VALUES ('after')", &[])
            .unwrap();
        assert_eq!(db.list_backups().unwrap().len(), 1);

        let path = db.resolve_backup(&backup.file_name).unwrap();
        db.restore_from(&path, 1).unwrap();
        let q = db.query("SELECT id FROM t ORDER BY id", &[]).unwrap();
        assert_eq!(q.rows, vec![vec![json!("before")]]);
        // The pre-restore safety backup exists alongside the manual one.
        assert_eq!(db.list_backups().unwrap().len(), 2);
    }

    #[test]
    fn restore_rejects_newer_schema_and_garbage() {
        let (dir, db) = temp_db();
        init_schema(&db);
        let backup = db.create_backup("manual").unwrap();
        let path = db.resolve_backup(&backup.file_name).unwrap();
        assert!(db.restore_from(&path, 0).is_err());

        let junk = dir.path().join("junk.sqlite3");
        fs::write(&junk, b"not a database").unwrap();
        assert!(db.restore_from(&junk, 99).is_err());
        // Database still usable after failed restores.
        assert!(db.query("SELECT 1", &[]).is_ok());
    }

    #[test]
    fn resolve_backup_rejects_traversal() {
        let (_d, db) = temp_db();
        assert!(db.resolve_backup("../keel.sqlite3").is_err());
        assert!(db.resolve_backup("a/b").is_err());
    }

    #[test]
    fn prunes_only_automatic_backups() {
        let (_d, db) = temp_db();
        init_schema(&db);
        db.create_backup("manual").unwrap();
        for _ in 0..(AUTO_BACKUPS_KEPT + 3) {
            db.create_backup("auto").unwrap();
            std::thread::sleep(Duration::from_millis(2));
        }
        let all = db.list_backups().unwrap();
        assert_eq!(all.iter().filter(|b| b.reason == "manual").count(), 1);
        assert_eq!(
            all.iter().filter(|b| b.reason == "auto").count(),
            AUTO_BACKUPS_KEPT
        );
    }

    #[test]
    fn wipe_removes_everything() {
        let (_d, db) = temp_db();
        init_schema(&db);
        db.create_backup("manual").unwrap();
        db.wipe().unwrap();
        let q = db
            .query("SELECT count(*) FROM sqlite_master WHERE type='table'", &[])
            .unwrap();
        assert_eq!(q.rows[0][0], json!(0));
        assert!(db.list_backups().unwrap().is_empty());
    }
}
