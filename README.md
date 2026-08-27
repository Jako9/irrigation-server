# Irrigation Server

Authenticated HTTP receiver for the
[Jako9 irrigation firmware](https://github.com/Jako9/irrigation-firmware).
It validates controller telemetry, stores normalized readings in SQLite, and
serves runtime configuration, queued commands, and OTA firmware back to the
controller.

Related repositories:

- [irrigation-firmware](https://github.com/Jako9/irrigation-firmware) measures
  soil moisture, operates the valves, and exchanges data with this server.
- [irrigation-dashboard](https://github.com/Jako9/irrigation-dashboard) reads
  this server's SQLite database and manages the files delivered to the
  controller.

## How it works

1. The ESP32 sends a bearer-authenticated JSON telemetry post to `POST /`.
2. The server validates the complete payload before writing anything.
3. One transaction stores the post, battery, weather, and per-zone readings in
   a WAL-mode SQLite database.
4. Structured controller logs are appended to a bounded log file.
5. The response describes the current configuration, command queue, and OTA
   firmware so the controller can download changed artifacts.
6. `GET /config.json` and `GET /firmware.bin` return the selected management
   files using the same bearer authentication.

Writes are serialized and database retention removes the oldest complete
telemetry posts when configured storage limits are reached. Irrigation logic
remains on the controller; losing this server does not itself operate a valve.

## Repository layout

```text
.
|-- server.js                     HTTP receiver, validation, and SQLite storage
|-- config.example.json           Safe controller-configuration template
|-- .env.example                  Environment-variable template
|-- deploy/systemd/               Generic Linux service unit
`-- tests/
    |-- fixtures/telemetry.json   Existing sample controller payload
    `-- verify_database.py        Existing read-only database inspector
```

Runtime databases, logs, firmware, commands, configuration, and credentials
are intentionally not versioned.

## Setup

### Requirements

- Node.js 20.17 or newer
- npm for a standalone installation
- A writable persistent data directory

Install the pinned dependency:

```bash
npm ci
```

Create private runtime directories and configuration:

```bash
mkdir -p ./data/management
cp .env.example .env
cp config.example.json ./data/management/config.json
```

Edit the copied configuration before enabling zones. Set calibrated wet/dry
values, weather coordinates, timezone, durations, and channel mappings for the
actual installation. Put an OTA image at `data/management/firmware.bin` and an
initial JSON array at `data/management/commands.json` when those features are
used.

Set `IRRIGATION_SHARED_SECRET` to a long random value that exactly matches the
firmware bearer secret. The server refuses to start when it is absent. Node 18
does not automatically load `.env` in this setup, so export the values in your shell or use
the supplied systemd `EnvironmentFile`:

```bash
export IRRIGATION_SHARED_SECRET='replace-with-your-private-value'
export IRRIGATION_HOST='127.0.0.1'
export IRRIGATION_ALLOWED_SUBNET='127.0.0.1/32'
export IRRIGATION_DATA_DIR="$PWD/data"
export IRRIGATION_MANAGEMENT_DIR="$PWD/data/management"
npm start
```

Bind to a private LAN address only when the ESP32 must connect directly, and set
`IRRIGATION_ALLOWED_SUBNET` to the narrow IPv4 CIDR containing the controller.
Do not publish the receiver without an appropriate trusted-network or
reverse-proxy boundary.

### Linux service

`deploy/systemd/irrigation-server.service` is a generic hardened template. Copy
the application to `/opt/irrigation-server`, store data in
`/var/lib/irrigation`, and put private environment values in
`/etc/irrigation-server.env`. Adapt its user and paths if necessary, then:

```bash
sudo systemd-analyze verify /etc/systemd/system/irrigation-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now irrigation-server.service
```

## HTTP interface

All routes require `Authorization: Bearer <shared-secret>`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/` | Validate and persist one telemetry cycle; return the management manifest |
| `GET` | `/config.json` | Download the active controller configuration |
| `GET` | `/firmware.bin` | Download the active OTA image |

Example telemetry request using the included fixture:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $IRRIGATION_SHARED_SECRET" \
  -H 'Content-Type: application/json' \
  --data-binary @tests/fixtures/telemetry.json \
  http://127.0.0.1:8070/
```

Inspect a database without modifying it:

```bash
python3 tests/verify_database.py ./data/irrigation.sqlite3
```

## Connection to the dashboard

Both services use the same persistent data and management directories. The
dashboard opens `irrigation.sqlite3` for telemetry queries and updates the
configuration, command queue, firmware, and management state through its
authenticated admin area. This server remains the only HTTP interface used by
the ESP32.

Start this server first, post telemetry, then configure the dashboard with
`IRRIGATION_DB` and `IRRIGATION_MANAGEMENT_DIR` pointing to those shared paths.
The processes can use different operating-system users only if both have the
required narrowly scoped file permissions.

## Checks and repository safety

Run the syntax check with:

```bash
npm run check
```
