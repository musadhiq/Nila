// SQLite storage for Nila. The local database is the source of truth.
// Tables: settings, reminders, reminder_history, snoozed_reminders.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

pub struct DbState(pub Mutex<Connection>);

impl DbState {
    pub fn new(conn: Connection) -> Self {
        Self(Mutex::new(conn))
    }
}

pub fn open(path: &std::path::Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CANTOPEN as i32),
                Some(format!("cannot create data dir: {e}")),
            )
        })?;
    }
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    Ok(conn)
}

const MIGRATIONS: &[&str] = &[
    // v1: initial schema
    "
    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reminders (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        message     TEXT NOT NULL,
        kind        TEXT NOT NULL,          -- 'water' | 'food' | 'break' | 'move' | 'sleep' | 'custom'
        schedule    TEXT NOT NULL,          -- JSON: {type:'once'|'daily'|'weekly'|'interval', ...}
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reminder_history (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        reminder_id  TEXT NOT NULL,
        occurred_at  TEXT NOT NULL,
        action       TEXT NOT NULL,          -- 'shown' | 'dismissed' | 'snoozed' | 'completed' | 'skipped'
        FOREIGN KEY (reminder_id) REFERENCES reminders(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_history_occurred ON reminder_history(occurred_at);
    CREATE TABLE IF NOT EXISTS snoozed_reminders (
        reminder_id TEXT PRIMARY KEY,
        wake_at     TEXT NOT NULL,           -- ISO 8601; survives restart
        FOREIGN KEY (reminder_id) REFERENCES reminders(id) ON DELETE CASCADE
    );
    ",
];

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let version = i as i64 + 1;
        if version > current {
            conn.execute_batch(sql)?;
            conn.execute_batch(&format!("PRAGMA user_version = {version}"))?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reminder {
    pub id: String,
    pub title: String,
    pub message: String,
    pub kind: String,
    pub schedule: String,
    pub enabled: bool,
}

/// Canonical reminder kinds. The backend accepts exactly these; the
/// frontend's `ReminderKind` union must stay in sync.
pub const VALID_KINDS: &[&str] = &[
    "water", "food", "break", "move", "sleep", "stretch", "exercise", "work", "custom",
    // System health reminders, fired by the system monitor (system_monitor.rs).
    "battery", "cpu", "memory", "disk",
];

pub fn list_reminders(conn: &Connection) -> rusqlite::Result<Vec<Reminder>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, message, kind, schedule, enabled FROM reminders ORDER BY created_at",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Reminder {
            id: r.get(0)?,
            title: r.get(1)?,
            message: r.get(2)?,
            kind: r.get(3)?,
            schedule: r.get(4)?,
            enabled: r.get::<_, i64>(5)? != 0,
        })
    })?;
    rows.collect()
}

pub fn upsert_reminder(conn: &Connection, r: &Reminder) -> rusqlite::Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO reminders (id, title, message, kind, schedule, enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, message = excluded.message, kind = excluded.kind,
           schedule = excluded.schedule, enabled = excluded.enabled, updated_at = excluded.updated_at",
        params![r.id, r.title, r.message, r.kind, r.schedule, r.enabled as i64, now, now],
    )?;
    Ok(())
}

pub fn delete_reminder(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM reminders WHERE id = ?1", params![id])?;
    // A snooze row must not outlive its reminder: a later reminder reusing
    // this id would otherwise inherit the old wake time.
    clear_snooze(conn, id)?;
    Ok(())
}

/// Delete every reminder of one kind (history/snooze rows cascade).
/// Used to drop all connector-owned reminders on disconnect/disable.
pub fn delete_reminders_by_kind(conn: &Connection, kind: &str) -> rusqlite::Result<usize> {
    let n = conn.execute("DELETE FROM reminders WHERE kind = ?1", params![kind])?;
    Ok(n)
}

/// True when a reminder row with this id exists (fired or pending).
/// The calendar sync uses it to avoid re-arming a late-event nudge
/// whose row outlived the in-memory cache across a restart.
pub fn reminder_exists(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM reminders WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

pub fn get_reminder(conn: &Connection, id: &str) -> rusqlite::Result<Option<Reminder>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, message, kind, schedule, enabled FROM reminders WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        None => Ok(None),
        Some(r) => Ok(Some(Reminder {
            id: r.get(0)?,
            title: r.get(1)?,
            message: r.get(2)?,
            kind: r.get(3)?,
            schedule: r.get(4)?,
            enabled: r.get::<_, i64>(5)? != 0,
        })),
    }
}

/// All active snoozes as (reminder_id, wake_at UTC). Rows with
/// unparseable timestamps are skipped, never fatal.
pub fn list_snoozed(conn: &Connection) -> rusqlite::Result<Vec<(String, chrono::DateTime<chrono::Utc>)>> {
    let mut stmt = conn.prepare("SELECT reminder_id, wake_at FROM snoozed_reminders")?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, wake) = row?;
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&wake) {
            out.push((id, dt.with_timezone(&chrono::Utc)));
        }
    }
    Ok(out)
}

pub fn clear_snooze(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM snoozed_reminders WHERE reminder_id = ?1", params![id])?;
    Ok(())
}

/// Drop snoozes whose wake time has passed (RFC 3339 UTC strings sort
/// lexicographically, so a string comparison is exact here).
pub fn delete_expired_snoozes(
    conn: &Connection,
    now: &chrono::DateTime<chrono::Utc>,
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM snoozed_reminders WHERE wake_at <= ?1",
        params![now.to_rfc3339()],
    )?;
    Ok(())
}

pub fn record_history(conn: &Connection, reminder_id: &str, action: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO reminder_history (reminder_id, occurred_at, action) VALUES (?1, ?2, ?3)",
        params![reminder_id, chrono::Utc::now().to_rfc3339(), action],
    )?;
    Ok(())
}

/// Number of reminders shown today (local day) — used for the daily limit.
pub fn shown_today(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM reminder_history
         WHERE action = 'shown' AND date(occurred_at, 'localtime') = date('now', 'localtime')",
        [],
        |r| r.get(0),
    )
}

/// Most recent time any reminder was shown (UTC ISO) — used for cooldown.
pub fn last_shown_at(conn: &Connection) -> rusqlite::Result<Option<String>> {
    let mut stmt = conn.prepare(
        "SELECT occurred_at FROM reminder_history WHERE action = 'shown'
         ORDER BY occurred_at DESC LIMIT 1",
    )?;
    let mut rows = stmt.query([])?;
    Ok(rows.next()?.map(|r| r.get(0)).transpose()?)
}

/// True when any history action for `reminder_id` was recorded at or
/// after `since` (RFC 3339 UTC; lexicographic comparison is exact).
/// Used at startup to tell "already handled" from "missed".
pub fn has_action_since(
    conn: &Connection,
    reminder_id: &str,
    since: &str,
) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM reminder_history WHERE reminder_id = ?1 AND occurred_at >= ?2",
        params![reminder_id, since],
        |r| r.get(0),
    )?;
    Ok(count > 0)
}

pub fn get_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;
    Ok(rows.next()?.map(|r| r.get(0)).transpose()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Read every settings row. Callers that already hold the DB lock must use
/// this instead of going through the `get_settings` command (which locks).
pub fn get_all_settings(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn migrations_run_twice_without_error() {
        let conn = memory_db();
        migrate(&conn).unwrap();
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64);
    }

    #[test]
    fn reminder_crud_roundtrip() {
        let conn = memory_db();
        let r = Reminder {
            id: "r1".into(),
            title: "Vellam".into(),
            message: "Vellam kudicho?".into(),
            kind: "water".into(),
            schedule: "{\"type\":\"interval\",\"minutes\":60}".into(),
            enabled: true,
        };
        upsert_reminder(&conn, &r).unwrap();
        let list = list_reminders(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].message, "Vellam kudicho?");
        delete_reminder(&conn, "r1").unwrap();
        assert!(list_reminders(&conn).unwrap().is_empty());
    }

    #[test]
    fn daily_limit_counter_counts_today_only() {
        let conn = memory_db();
        let r = Reminder {
            id: "r1".into(), title: "t".into(), message: "m".into(),
            kind: "water".into(), schedule: "{}".into(), enabled: true,
        };
        upsert_reminder(&conn, &r).unwrap();
        record_history(&conn, "r1", "shown").unwrap();
        record_history(&conn, "r1", "dismissed").unwrap();
        assert_eq!(shown_today(&conn).unwrap(), 1);
        assert!(last_shown_at(&conn).unwrap().is_some());
    }

    #[test]
    fn delete_reminder_clears_its_snooze_row() {
        let conn = memory_db();
        let r = Reminder {
            id: "r1".into(), title: "t".into(), message: "m".into(),
            kind: "water".into(), schedule: "{}".into(), enabled: true,
        };
        upsert_reminder(&conn, &r).unwrap();
        conn.execute(
            "INSERT INTO snoozed_reminders (reminder_id, wake_at) VALUES (?1, ?2)",
            rusqlite::params!["r1", "2999-01-01T00:00:00Z"],
        )
        .unwrap();
        assert_eq!(list_snoozed(&conn).unwrap().len(), 1);
        delete_reminder(&conn, "r1").unwrap();
        // The snooze must not outlive its reminder: a later reminder
        // reusing this id would otherwise inherit the old wake time.
        assert!(list_snoozed(&conn).unwrap().is_empty());
    }

    #[test]
    fn has_action_since_detects_handled_reminders() {
        let conn = memory_db();
        let r = Reminder {
            id: "r1".into(), title: "t".into(), message: "m".into(),
            kind: "water".into(), schedule: "{}".into(), enabled: true,
        };
        upsert_reminder(&conn, &r).unwrap();
        // No history yet: nothing handled since any past time.
        assert!(!has_action_since(&conn, "r1", "2020-01-01T00:00:00Z").unwrap());
        record_history(&conn, "r1", "shown").unwrap();
        // The action just happened: it counts for past cutoffs, not future ones.
        assert!(has_action_since(&conn, "r1", "2020-01-01T00:00:00Z").unwrap());
        assert!(!has_action_since(&conn, "r1", "2999-01-01T00:00:00Z").unwrap());
    }
}
