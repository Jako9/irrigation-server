#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const sqlite3 = require("sqlite3");

const HOST = process.env.IRRIGATION_HOST || "127.0.0.1";
const PORT = Number(process.env.IRRIGATION_PORT || 8070);
const DATA_DIR = process.env.IRRIGATION_DATA_DIR || path.join(__dirname, "data");
const MANAGEMENT_DIR = process.env.IRRIGATION_MANAGEMENT_DIR || path.join(DATA_DIR, "management");
const DB_PATH = path.join(DATA_DIR, "irrigation.sqlite3");
const LOG_PATH = path.join(DATA_DIR, "log.txt");
const COMMANDS_PATH = path.join(MANAGEMENT_DIR, "commands.json");
const CONFIG_PATH = path.join(MANAGEMENT_DIR, "config.json");
const FIRMWARE_PATH = path.join(MANAGEMENT_DIR, "firmware.bin");
const MANAGEMENT_STATE_PATH = path.join(MANAGEMENT_DIR, "management-state.json");
const MANAGEMENT_LOCK_PATH = path.join(MANAGEMENT_DIR, ".management.lock");
const MAX_LOG_BYTES = Number(process.env.IRRIGATION_MAX_LOG_BYTES || 1024 * 1024);
const ALLOWED_SUBNET = process.env.IRRIGATION_ALLOWED_SUBNET || "127.0.0.1/32";
const SHARED_SECRET = String(process.env.IRRIGATION_SHARED_SECRET || "");
if (!SHARED_SECRET) {
  throw new Error("IRRIGATION_SHARED_SECRET is required");
}
const BODY_LIMIT = 64 * 1024;
const GIB = 1024 ** 3;
const MAX_DB_BYTES = Number(process.env.IRRIGATION_MAX_DB_BYTES || 10 * GIB);
const RETENTION_TARGET_BYTES = Number(process.env.IRRIGATION_RETENTION_TARGET_BYTES || 9 * GIB);
const DELETE_BATCH_BYTES = Number(process.env.IRRIGATION_DELETE_BATCH_BYTES || GIB);
const MAX_COMMANDS = 16;
const MAX_FIRMWARE_BYTES = 0x1F0000;
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30000;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("IRRIGATION_PORT must be a valid TCP port");
}
if (!(RETENTION_TARGET_BYTES < MAX_DB_BYTES) || DELETE_BATCH_BYTES <= 0) {
  throw new Error("Invalid retention configuration");
}
if (!Number.isInteger(MAX_LOG_BYTES) || MAX_LOG_BYTES < 1) {
  throw new Error("IRRIGATION_MAX_LOG_BYTES must be a positive integer");
}

const expectedAuthorization = Buffer.from(`Bearer ${SHARED_SECRET}`, "utf8");

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o750 });
fs.mkdirSync(MANAGEMENT_DIR, { recursive: true, mode: 0o700 });

const allowedClients = new net.BlockList();
const subnetMatch = ALLOWED_SUBNET.match(/^([^/]+)\/(\d{1,2})$/);
if (!subnetMatch || net.isIP(subnetMatch[1]) !== 4 || Number(subnetMatch[2]) > 32) {
  throw new Error("IRRIGATION_ALLOWED_SUBNET must be an IPv4 CIDR");
}
allowedClients.addSubnet(subnetMatch[1], Number(subnetMatch[2]), "ipv4");

const db = new sqlite3.Database(DB_PATH);
db.configure("busyTimeout", 5000);

function exec(sql) {
  return new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function callback(error) {
      if (error) reject(error);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
  });
}

async function initializeDatabase() {
  await exec(`
    PRAGMA auto_vacuum=INCREMENTAL;
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;

    CREATE TABLE IF NOT EXISTS telemetry_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at_ms INTEGER NOT NULL,
      source_ip TEXT NOT NULL,
      clock_s REAL NOT NULL,
      next_humidity_s REAL NOT NULL,
      raw_json TEXT NOT NULL,
      raw_bytes INTEGER NOT NULL CHECK(raw_bytes >= 0)
    );

    CREATE TABLE IF NOT EXISTS battery_readings (
      post_id INTEGER PRIMARY KEY REFERENCES telemetry_posts(id) ON DELETE CASCADE,
      valid INTEGER,
      voltage_v REAL,
      soc_percent REAL,
      status_raw INTEGER,
      stage_raw INTEGER,
      charge_current_a REAL,
      solar_voltage_v REAL,
      solar_current_a REAL,
      solar_power_w REAL,
      load_state_raw INTEGER,
      load_current_a REAL,
      load_power_w REAL,
      usb_state_raw INTEGER,
      usb_voltage_v REAL,
      internal_temperature_c REAL,
      ambient_temperature_c REAL,
      temperature_state_raw INTEGER
    );

    CREATE TABLE IF NOT EXISTS weather_readings (
      post_id INTEGER PRIMARY KEY REFERENCES telemetry_posts(id) ON DELETE CASCADE,
      valid INTEGER,
      temperature_c REAL,
      weather_code INTEGER,
      is_day INTEGER
    );

    CREATE TABLE IF NOT EXISTS zone_readings (
      post_id INTEGER NOT NULL REFERENCES telemetry_posts(id) ON DELETE CASCADE,
      zone INTEGER NOT NULL,
      enabled INTEGER,
      raw_a REAL,
      raw_b REAL,
      wetness_a REAL,
      wetness_b REAL,
      wetness REAL,
      threshold REAL,
      requested INTEGER,
      cooldown_blocked INTEGER,
      watering INTEGER,
      watered INTEGER NOT NULL DEFAULT 0,
      has_been_watered INTEGER,
      last_watered_s REAL,
      close_deadline_s REAL,
      status TEXT,
      PRIMARY KEY(post_id, zone)
    );

    CREATE INDEX IF NOT EXISTS idx_posts_received_at
      ON telemetry_posts(received_at_ms);
    CREATE INDEX IF NOT EXISTS idx_zones_zone_post
      ON zone_readings(zone, post_id);
  `);

  const zoneColumns = await all("PRAGMA table_info(zone_readings)");
  if (!zoneColumns.some(column => column.name === "watered")) {
    await exec("ALTER TABLE zone_readings ADD COLUMN watered INTEGER NOT NULL DEFAULT 0");
  }
  await run("UPDATE zone_readings SET watered = 0 WHERE watered IS NULL");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateTelemetry(value) {
  if (!isObject(value)) return "Body must be a JSON object";
  if (!finiteNumber(value.clock_s)) return "clock_s must be a finite number";
  if (!finiteNumber(value.next_humidity_s)) return "next_humidity_s must be a finite number";
  if (!isObject(value.battery)) return "battery must be an object";
  if (!isObject(value.weather)) return "weather must be an object";
  if (!Array.isArray(value.zones)) return "zones must be an array";
  if (!Array.isArray(value.logs)) return "logs must be an array";
  for (const entry of value.logs) {
    if (!isObject(entry)) return "Each log entry must be an object";
    if (!Number.isSafeInteger(entry.clock_ms) || entry.clock_ms < 0) {
      return "Each log clock_ms must be a non-negative safe integer";
    }
    if (entry.timestamp_ms !== null &&
        (!Number.isSafeInteger(entry.timestamp_ms) || entry.timestamp_ms < 0)) {
      return "Each log timestamp_ms must be null or a non-negative safe integer";
    }
    if (typeof entry.message !== "string") return "Each log message must be a string";
  }
  const seen = new Set();
  for (const zone of value.zones) {
    if (!isObject(zone) || !Number.isInteger(zone.zone) || zone.zone < 1) {
      return "Each zone must have a positive integer zone number";
    }
    if (seen.has(zone.zone)) return "Zone numbers must be unique within a post";
    if (zone.watered != null && typeof zone.watered !== "boolean") {
      return "Each zone watered field must be a boolean";
    }
    seen.add(zone.zone);
  }
  return null;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? Number(value) : null;
}

function numberOrNull(value) {
  return finiteNumber(value) ? value : null;
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

async function insertTelemetry(telemetry, rawJson, sourceIp) {
  await run("BEGIN IMMEDIATE");
  try {
    const post = await run(
      `INSERT INTO telemetry_posts
       (received_at_ms, source_ip, clock_s, next_humidity_s, raw_json, raw_bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [Date.now(), sourceIp, telemetry.clock_s, telemetry.next_humidity_s,
       rawJson, Buffer.byteLength(rawJson, "utf8")]
    );
    const postId = post.lastID;
    const battery = telemetry.battery;
    await run(
      `INSERT INTO battery_readings VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [postId, booleanOrNull(battery.valid), numberOrNull(battery.voltage_v),
       numberOrNull(battery.soc_percent), integerOrNull(battery.status_raw),
       integerOrNull(battery.stage_raw), numberOrNull(battery.charge_current_a),
       numberOrNull(battery.solar_voltage_v), numberOrNull(battery.solar_current_a),
       numberOrNull(battery.solar_power_w), integerOrNull(battery.load_state_raw),
       numberOrNull(battery.load_current_a), numberOrNull(battery.load_power_w),
       integerOrNull(battery.usb_state_raw), numberOrNull(battery.usb_voltage_v),
       numberOrNull(battery.internal_temperature_c), numberOrNull(battery.ambient_temperature_c),
       integerOrNull(battery.temperature_state_raw)]
    );
    const weather = telemetry.weather;
    await run(
      "INSERT INTO weather_readings VALUES (?, ?, ?, ?, ?)",
      [postId, booleanOrNull(weather.valid), numberOrNull(weather.temperature_c),
       integerOrNull(weather.weather_code), booleanOrNull(weather.is_day)]
    );
    for (const zone of telemetry.zones) {
      await run(
        `INSERT INTO zone_readings
         (post_id, zone, enabled, raw_a, raw_b, wetness_a, wetness_b, wetness,
          threshold, requested, cooldown_blocked, watering, watered,
          has_been_watered, last_watered_s, close_deadline_s, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [postId, zone.zone, booleanOrNull(zone.enabled), numberOrNull(zone.raw_a),
         numberOrNull(zone.raw_b), numberOrNull(zone.wetness_a), numberOrNull(zone.wetness_b),
         numberOrNull(zone.wetness), numberOrNull(zone.threshold), booleanOrNull(zone.requested),
         booleanOrNull(zone.cooldown_blocked), booleanOrNull(zone.watering),
         zone.watered === true ? 1 : 0,
         booleanOrNull(zone.has_been_watered), numberOrNull(zone.last_watered_s),
         numberOrNull(zone.close_deadline_s), stringOrNull(zone.status)]
      );
    }
    await run("COMMIT");
    return postId;
  } catch (error) {
    try { await run("ROLLBACK"); } catch (_) { /* preserve original error */ }
    throw error;
  }
}

function databaseFootprint() {
  return [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`].reduce((total, file) => {
    try { return total + fs.statSync(file).size; }
    catch (error) { return error.code === "ENOENT" ? total : (() => { throw error; })(); }
  }, 0);
}

function isWakeLog(entry) {
  return /^Wake cause\b/i.test(entry.message.trim());
}

function appendStructuredLogs(entries) {
  if (entries.length === 0) return;
  let selected = entries;
  let existingBytes = 0;
  try { existingBytes = fs.statSync(LOG_PATH).size; }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  if (existingBytes === 0) {
    const firstWake = entries.findIndex(isWakeLog);
    if (firstWake === -1) return;
    selected = entries.slice(firstWake);
  }

  const text = `${selected.map(entry => JSON.stringify({
    clock_ms: entry.clock_ms,
    timestamp_ms: entry.timestamp_ms,
    message: entry.message
  })).join("\n")}\n`;
  fs.appendFileSync(LOG_PATH, text, { encoding: "utf8", mode: 0o640 });
  if (fs.statSync(LOG_PATH).size <= MAX_LOG_BYTES) return;

  const lines = fs.readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean);
  const suffixBytes = new Array(lines.length + 1).fill(0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    suffixBytes[index] = suffixBytes[index + 1] + Buffer.byteLength(`${lines[index]}\n`, "utf8");
  }
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    let entry;
    try { entry = JSON.parse(lines[index]); }
    catch (_) { continue; }
    if (isWakeLog(entry) && suffixBytes[index] <= MAX_LOG_BYTES) {
      start = index;
      break;
    }
  }
  const temporaryPath = `${LOG_PATH}.trim`;
  const retained = start === -1 ? "" : `${lines.slice(start).join("\n")}\n`;
  fs.writeFileSync(temporaryPath, retained, { encoding: "utf8", mode: 0o640 });
  fs.renameSync(temporaryPath, LOG_PATH);
}

async function deleteOldestBatch() {
  let lastId = 0;
  let accumulated = 0;
  while (accumulated < DELETE_BATCH_BYTES) {
    const rows = await all(
      "SELECT id, raw_bytes FROM telemetry_posts WHERE id > ? ORDER BY id LIMIT 1000",
      [lastId]
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      accumulated += row.raw_bytes;
      lastId = row.id;
      if (accumulated >= DELETE_BATCH_BYTES) break;
    }
  }
  if (lastId === 0) return false;
  await run("BEGIN IMMEDIATE");
  try {
    await run("DELETE FROM telemetry_posts WHERE id <= ?", [lastId]);
    await run("COMMIT");
  } catch (error) {
    try { await run("ROLLBACK"); } catch (_) { /* preserve original error */ }
    throw error;
  }
  await exec("PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE);");
  return true;
}

async function enforceRetention() {
  if (databaseFootprint() <= MAX_DB_BYTES) return;
  while (databaseFootprint() > RETENTION_TARGET_BYTES) {
    if (!await deleteOldestBatch()) break;
  }
  if (databaseFootprint() > MAX_DB_BYTES) {
    throw new Error("Unable to reduce database footprint below configured limit");
  }
}

let writeQueue = Promise.resolve();
let retentionBlocked = false;
function enqueueWrite(task) {
  const result = writeQueue.then(task, task);
  writeQueue = result.catch(() => undefined);
  return result;
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function withManagementLock(task) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await fs.promises.mkdir(MANAGEMENT_LOCK_PATH, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = await fs.promises.stat(MANAGEMENT_LOCK_PATH);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          const stale = `${MANAGEMENT_LOCK_PATH}.stale-${process.pid}-${Date.now()}`;
          await fs.promises.rename(MANAGEMENT_LOCK_PATH, stale);
          await fs.promises.rm(stale, { recursive: true, force: true });
          continue;
        }
      } catch (lockError) {
        if (lockError.code === "ENOENT") continue;
      }
      if (Date.now() >= deadline) throw new Error("Management files are busy");
      await delay(30 + Math.floor(Math.random() * 40));
    }
  }
  try { return await task(); }
  finally { await fs.promises.rmdir(MANAGEMENT_LOCK_PATH).catch(() => undefined); }
}

async function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  let handle;
  try {
    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(temporaryPath, filePath);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.promises.unlink(temporaryPath).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

function sendJson(response, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
    "Connection": "close",
    ...extraHeaders
  });
  response.end(data);
}

function sendBuffer(response, status, data, contentType) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    "Connection": "close"
  });
  response.end(data);
}

function validateCommands(value) {
  if (!Array.isArray(value)) throw new Error("Command queue must be an array");
  if (value.length > MAX_COMMANDS) throw new Error("Command queue exceeds 16 entries");
  for (const command of value) {
    if (!isObject(command) || typeof command.name !== "string" || command.name.length === 0 ||
        !isObject(command.arguments)) {
      throw new Error("Command queue contains an invalid entry");
    }
  }
  return value;
}

async function loadManagementManifest() {
  const [configBytes, firmwareBytes, commandsBytes] = await Promise.all([
    fs.promises.readFile(CONFIG_PATH),
    fs.promises.readFile(FIRMWARE_PATH),
    fs.promises.readFile(COMMANDS_PATH)
  ]);
  if (configBytes.length === 0) throw new Error("Published configuration is empty");
  if (firmwareBytes.length === 0 || firmwareBytes.length > MAX_FIRMWARE_BYTES) {
    throw new Error("Published firmware has an invalid size");
  }
  let commands;
  try { commands = validateCommands(JSON.parse(commandsBytes.toString("utf8"))); }
  catch (error) { throw new Error(`Invalid command queue: ${error.message}`); }
  return {
    config_sha256: crypto.createHash("sha256").update(configBytes).digest("hex"),
    program_md5: crypto.createHash("md5").update(firmwareBytes).digest("hex"),
    commands
  };
}

async function atomicallyClearCommands() {
  const temporaryPath = `${COMMANDS_PATH}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  let handle;
  try {
    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile("[]\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(temporaryPath, COMMANDS_PATH);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.promises.unlink(temporaryPath).catch(error => {
      if (error.code !== "ENOENT") console.error(`Temporary queue cleanup failed: ${error.message}`);
    });
  }
}

async function recordManagementDelivery(kind, data) {
  await withManagementLock(async () => {
    let state = {};
    try { state = JSON.parse(await fs.promises.readFile(MANAGEMENT_STATE_PATH, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") console.error(`Management state read failed: ${error.message}`); }
    const now = new Date().toISOString();
    if (kind === "config") {
      state.config = {
        sha256: crypto.createHash("sha256").update(data).digest("hex"),
        served_at: now,
        snapshot: JSON.parse(data.toString("utf8")),
        bytes_base64: data.toString("base64")
      };
    } else {
      state.firmware = {
        md5: crypto.createHash("md5").update(data).digest("hex"),
        size: data.length,
        served_at: now
      };
    }
    await atomicWriteJson(MANAGEMENT_STATE_PATH, state);
  });
}

async function serveManagementFile(response, filePath, contentType, validateSize = false, deliveryKind = null) {
  try {
    const data = await fs.promises.readFile(filePath);
    if (data.length === 0 || (validateSize && data.length > MAX_FIRMWARE_BYTES)) {
      throw new Error("Published file has an invalid size");
    }
    if (deliveryKind) response.once("finish", () => {
      recordManagementDelivery(deliveryKind, data).catch(error =>
        console.error(`Management delivery state failed: ${error.message}`));
    });
    sendBuffer(response, 200, data, contentType);
  } catch (error) {
    console.error(`Management download failed for ${path.basename(filePath)}: ${error.message}`);
    sendJson(response, 503, { error: "Management file unavailable" });
  }
}

function authorized(header) {
  if (typeof header !== "string") return false;
  const supplied = Buffer.from(header, "utf8");
  return supplied.length === expectedAuthorization.length &&
    crypto.timingSafeEqual(supplied, expectedAuthorization);
}

function receiveBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let tooLarge = false;
    request.on("data", chunk => {
      if (tooLarge) return;
      length += chunk.length;
      if (length > BODY_LIMIT) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        const error = new Error("Request body is too large");
        error.statusCode = 413;
        reject(error);
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    request.on("error", reject);
  });
}

async function handleRequest(request, response) {
  const sourceIp = request.socket.remoteAddress;
  if (!sourceIp || net.isIP(sourceIp) !== 4 || !allowedClients.check(sourceIp, "ipv4")) {
    return sendJson(response, 403, { error: "Forbidden" });
  }
  if (!authorized(request.headers.authorization)) {
    return sendJson(response, 401, { error: "Unauthorized" }, { "WWW-Authenticate": "Bearer" });
  }
  if (request.url === "/config.json") {
    if (request.method !== "GET") {
      return sendJson(response, 405, { error: "Method not allowed" }, { Allow: "GET" });
    }
    return serveManagementFile(response, CONFIG_PATH, "application/json", false, "config");
  }
  if (request.url === "/firmware.bin") {
    if (request.method !== "GET") {
      return sendJson(response, 405, { error: "Method not allowed" }, { Allow: "GET" });
    }
    return serveManagementFile(response, FIRMWARE_PATH, "application/octet-stream", true, "firmware");
  }
  if (request.url !== "/") return sendJson(response, 404, { error: "Not found" });
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "Method not allowed" }, { Allow: "POST" });
  }
  const contentType = String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return sendJson(response, 400, { error: "Content-Type must be application/json" });
  }

  let rawJson;
  try {
    rawJson = await receiveBody(request);
  } catch (error) {
    if (!response.headersSent) sendJson(response, error.statusCode || 400, { error: error.message });
    return;
  }

  let telemetry;
  try { telemetry = JSON.parse(rawJson); }
  catch (_) { return sendJson(response, 400, { error: "Invalid JSON" }); }
  const validationError = validateTelemetry(telemetry);
  if (validationError) return sendJson(response, 400, { error: validationError });

  try {
    const manifest = await enqueueWrite(async () => {
      await loadManagementManifest();
      if (retentionBlocked) {
        await enforceRetention();
        retentionBlocked = false;
      }
      const id = await insertTelemetry(telemetry, rawJson, sourceIp);
      appendStructuredLogs(telemetry.logs);
      try { await enforceRetention(); }
      catch (error) {
        retentionBlocked = true;
        console.error(`Retention failed after post ${id}: ${error.message}`);
      }
      return withManagementLock(async () => {
        const management = await loadManagementManifest();
        await atomicallyClearCommands();
        return management;
      });
    });
    sendJson(response, 200, manifest);
  } catch (error) {
    console.error(`Telemetry transaction failed: ${error.message}`);
    sendJson(response, 503, { error: "Storage or management unavailable" });
  }
}

async function main() {
  await initializeDatabase();
  await enforceRetention();
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch(error => {
      console.error(`Unhandled request error: ${error.message}`);
      if (!response.headersSent) sendJson(response, 500, { error: "Internal server error" });
      else response.destroy();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(PORT, HOST, () => console.log(`Irrigation tracker listening on ${HOST}:${PORT}`));
}

function shutdown(signal) {
  console.log(`Received ${signal}; closing database`);
  db.close(error => process.exit(error ? 1 : 0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch(error => {
  console.error(`Startup failed: ${error.message}`);
  db.close(() => process.exit(1));
});
