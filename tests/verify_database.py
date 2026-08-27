#!/usr/bin/env python3
import json
import sqlite3
import sys


database_path = sys.argv[1]
connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)

result = {
    "posts": connection.execute("SELECT COUNT(*) FROM telemetry_posts").fetchone()[0],
    "battery": connection.execute(
        "SELECT voltage_v, soc_percent FROM battery_readings ORDER BY post_id DESC LIMIT 1"
    ).fetchone(),
    "weather": connection.execute(
        "SELECT temperature_c, weather_code, is_day FROM weather_readings ORDER BY post_id DESC LIMIT 1"
    ).fetchone(),
    "zones": connection.execute("SELECT COUNT(*) FROM zone_readings").fetchone()[0],
    "zone5": connection.execute(
        "SELECT enabled, raw_a, status FROM zone_readings WHERE zone = 5 ORDER BY post_id DESC LIMIT 1"
    ).fetchone(),
    "raw_json_nonempty": bool(connection.execute(
        "SELECT LENGTH(raw_json) > 0 FROM telemetry_posts ORDER BY id DESC LIMIT 1"
    ).fetchone()[0]),
    "first_id": connection.execute("SELECT MIN(id) FROM telemetry_posts").fetchone()[0],
    "last_id": connection.execute("SELECT MAX(id) FROM telemetry_posts").fetchone()[0],
}

print(json.dumps(result, separators=(",", ":")))
