"""SQLite-backed generation history (stdlib only, one file: data/engine.db)."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    model TEXT NOT NULL,
    mode TEXT NOT NULL,
    provider TEXT NOT NULL,
    is_demo INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    message TEXT,
    error TEXT,
    error_details TEXT,
    setup_steps TEXT,
    notice TEXT,
    params TEXT NOT NULL,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    started_at REAL,
    finished_at REAL
);
CREATE INDEX IF NOT EXISTS idx_generations_owner ON generations(owner, created_at);
CREATE INDEX IF NOT EXISTS idx_generations_status ON generations(status, created_at);
"""

JSON_FIELDS = {"params", "setup_steps"}
ACTIVE = ("queued", "running")


class GenerationStore:
    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript(SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # -- helpers ----------------------------------------------------------
    @staticmethod
    def _row(row: sqlite3.Row | None) -> dict | None:
        if row is None:
            return None
        data = dict(row)
        for key in JSON_FIELDS:
            data[key] = json.loads(data[key]) if data.get(key) else ([] if key == "setup_steps" else {})
        return data

    # -- writes -----------------------------------------------------------
    def create(self, record: dict) -> dict:
        now = time.time()
        record = {"status": "queued", "progress": 0, "message": "في قائمة الانتظار...", **record,
                  "created_at": record.get("created_at", now), "updated_at": now}
        stored = {k: (json.dumps(v, ensure_ascii=False) if k in JSON_FIELDS else v) for k, v in record.items()}
        columns = ", ".join(stored)
        placeholders = ", ".join("?" for _ in stored)
        with self._lock:
            self._conn.execute(f"INSERT INTO generations ({columns}) VALUES ({placeholders})", list(stored.values()))
        return self.get(record["id"])

    def update(self, generation_id: str, **fields) -> None:
        if not fields:
            return
        fields["updated_at"] = time.time()
        stored = {k: (json.dumps(v, ensure_ascii=False) if k in JSON_FIELDS else v) for k, v in fields.items()}
        assignments = ", ".join(f"{k} = ?" for k in stored)
        with self._lock:
            self._conn.execute(f"UPDATE generations SET {assignments} WHERE id = ?", [*stored.values(), generation_id])

    def delete(self, generation_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM generations WHERE id = ?", (generation_id,))

    def claim_next(self) -> dict | None:
        """Atomically move the oldest queued generation to running."""
        with self._lock:
            row = self._conn.execute(
                "SELECT id FROM generations WHERE status = 'queued' AND deleted = 0 "
                "ORDER BY created_at, rowid LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            now = time.time()
            self._conn.execute(
                "UPDATE generations SET status = 'running', progress = 1, message = ?, started_at = ?, updated_at = ? "
                "WHERE id = ?",
                ("بدأ التوليد...", now, now, row["id"]),
            )
            return self.get(row["id"])

    def recover_interrupted(self) -> int:
        """Generations that were running when the engine stopped cannot resume."""
        with self._lock:
            cursor = self._conn.execute(
                "UPDATE generations SET status = 'failed', error = ?, message = ?, updated_at = ? "
                "WHERE status = 'running'",
                ("توقف المحرك أثناء التوليد. اضغط «إعادة التوليد» للمحاولة مرة أخرى.", "فشل التوليد.", time.time()),
            )
            return cursor.rowcount

    # -- reads ------------------------------------------------------------
    def get(self, generation_id: str) -> dict | None:
        with self._lock:
            return self._row(self._conn.execute("SELECT * FROM generations WHERE id = ?", (generation_id,)).fetchone())

    def list_for_owner(self, owner: str, limit: int = 60, before: float | None = None) -> list[dict]:
        query = "SELECT * FROM generations WHERE owner = ? AND deleted = 0"
        args: list = [owner]
        if before is not None:
            query += " AND created_at < ?"
            args.append(before)
        query += " ORDER BY created_at DESC, rowid DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            return [self._row(r) for r in self._conn.execute(query, args).fetchall()]

    def queue_position(self, generation: dict) -> int:
        """1-based position among waiting generations (0 when running or finished)."""
        if generation["status"] != "queued":
            return 0
        with self._lock:
            ahead = self._conn.execute(
                "SELECT COUNT(*) FROM generations WHERE deleted = 0 AND (status = 'running' OR "
                "(status = 'queued' AND (created_at < ? OR (created_at = ? AND rowid < "
                "(SELECT rowid FROM generations WHERE id = ?)))))",
                (generation["created_at"], generation["created_at"], generation["id"]),
            ).fetchone()[0]
        return ahead + 1

    def count_active(self, owner: str | None = None) -> int:
        query = "SELECT COUNT(*) FROM generations WHERE status IN ('queued', 'running') AND deleted = 0"
        args: list = []
        if owner is not None:
            query += " AND owner = ?"
            args.append(owner)
        with self._lock:
            return self._conn.execute(query, args).fetchone()[0]

    def expired(self, finished_before: float) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM generations WHERE status NOT IN ('queued', 'running') AND updated_at < ?",
                (finished_before,),
            ).fetchall()
        return [self._row(r) for r in rows]
