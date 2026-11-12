"""Small SQLite asset index used by the local Director Board."""
from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any


ASSET_TYPES = ("人物", "场景", "道具", "其他")


class AssetStore:
    def __init__(self, path: str | Path | None = None):
        if path is None:
            import folder_paths
            path = Path(folder_paths.get_user_directory()) / "zdx_assets.sqlite3"
        self.path = Path(path)

    def _connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA busy_timeout = 10000")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS assets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                image_path TEXT NOT NULL,
                description TEXT DEFAULT '',
                asset_type TEXT DEFAULT '其他',
                project_id TEXT DEFAULT '',
                project_title TEXT DEFAULT ''
            )
            """
        )
        columns = {row[1] for row in connection.execute("PRAGMA table_info(assets)")}
        if "project_id" not in columns:
            connection.execute("ALTER TABLE assets ADD COLUMN project_id TEXT DEFAULT ''")
        if "project_title" not in columns:
            connection.execute("ALTER TABLE assets ADD COLUMN project_title TEXT DEFAULT ''")
        connection.commit()
        return connection

    @staticmethod
    def _clean(values: dict[str, Any]) -> dict[str, str]:
        name = str(values.get("name") or "").strip()
        image_path = str(values.get("image_path") or "").replace("\\", "/").strip("/")
        description = str(values.get("description") or "").strip()
        asset_type = str(values.get("asset_type") or "其他").strip()
        if not name:
            raise ValueError("资产名称不能为空")
        if not image_path or image_path.startswith("/") or ".." in image_path.split("/"):
            raise ValueError("资产图片路径无效")
        if asset_type not in ASSET_TYPES:
            raise ValueError("资产类型无效")
        return {
            "name": name, "image_path": image_path, "description": description,
            "asset_type": asset_type,
            "project_id": str(values.get("project_id") or "").strip(),
            "project_title": str(values.get("project_title") or "").strip(),
        }

    def list(self) -> list[dict[str, Any]]:
        with closing(self._connect()) as connection:
            with connection:
                return [dict(row) for row in connection.execute("SELECT * FROM assets ORDER BY id DESC")]

    def create(self, values: dict[str, Any]) -> dict[str, Any]:
        clean = self._clean(values)
        with closing(self._connect()) as connection:
            with connection:
                cursor = connection.execute(
                    "INSERT INTO assets(name, image_path, description, asset_type, project_id, project_title) VALUES(?, ?, ?, ?, ?, ?)",
                    tuple(clean[key] for key in ("name", "image_path", "description", "asset_type", "project_id", "project_title")),
                )
                row = connection.execute("SELECT * FROM assets WHERE id = ?", (cursor.lastrowid,)).fetchone()
                return dict(row)

    def update(self, asset_id: int, values: dict[str, Any]) -> dict[str, Any]:
        clean = self._clean(values)
        with closing(self._connect()) as connection:
            with connection:
                cursor = connection.execute(
                    "UPDATE assets SET name = ?, image_path = ?, description = ?, asset_type = ?, project_id = ?, project_title = ? WHERE id = ?",
                    (*tuple(clean[key] for key in ("name", "image_path", "description", "asset_type", "project_id", "project_title")), asset_id),
                )
                if cursor.rowcount != 1:
                    raise KeyError(asset_id)
                return dict(connection.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone())

    def delete(self, asset_id: int) -> bool:
        with closing(self._connect()) as connection:
            with connection:
                return connection.execute("DELETE FROM assets WHERE id = ?", (asset_id,)).rowcount == 1
