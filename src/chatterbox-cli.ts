import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");
const BACKEND_DIR = resolve(PACKAGE_ROOT, "backends", "chatterbox");
const SERVER_SCRIPT = resolve(BACKEND_DIR, "server.py");
const VOICE_DIR = resolve(homedir(), ".pi", "voice");
const STATE_DIR = resolve(VOICE_DIR, "chatterbox");
const REFERENCES_DIR = resolve(VOICE_DIR, "references");
const CONFIG_PATH = resolve(VOICE_DIR, "config.json");
const VENV_DIR = resolve(STATE_DIR, ".venv");
const PYTHON = resolve(VENV_DIR, "bin", "python");
const PID_PATH = resolve(STATE_DIR, "server.pid");
const LOG_PATH = resolve(STATE_DIR, "server.log");
const TOKEN_PATH = resolve(STATE_DIR, "auth-token");
const OPERATION_LOCK_DIR = resolve(STATE_DIR, "operation.lock");
const OPERATION_LOCK_OWNER = resolve(OPERATION_LOCK_DIR, "owner");

interface ChatterboxSettings {
  host?: string;
  port?: number;
  model?: string;
  referenceAudio?: string;
  language?: string;
  fallbackLanguage?: string;
  exaggeration?: number;
  idleTimeoutMinutes?: number;
}

interface RootConfig {
  backend?: string;
  autoSpeak?: string;
  events?: unknown;
  chatterbox?: ChatterboxSettings;
  [key: string]: unknown;
}

function loadRootConfig(): RootConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as RootConfig;
  } catch (error) {
    throw new Error(
      `Cannot parse ${CONFIG_PATH}; refusing to overwrite it: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function saveRootConfig(config: RootConfig): void {
  mkdirSync(VOICE_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function settings(): Required<ChatterboxSettings> {
  const value = loadRootConfig().chatterbox ?? {};
  const host = value.host ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Chatterbox must bind to a loopback host.");
  }
  return {
    host,
    port: value.port ?? 8182,
    model: value.model ?? "mlx-community/chatterbox-multilingual-v3",
    referenceAudio: value.referenceAudio ?? resolve(REFERENCES_DIR, "default.wav"),
    language: value.language ?? "auto",
    fallbackLanguage: value.fallbackLanguage ?? "en",
    exaggeration: value.exaggeration ?? 0.1,
    idleTimeoutMinutes: value.idleTimeoutMinutes ?? 30,
  };
}

function readPid(): number | null {
  try {
    return Number.parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
  } catch {
    return null;
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isChatterboxProcess(pid: number): boolean {
  if (!running(pid)) return false;
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 && result.stdout.includes(SERVER_SCRIPT);
}

function readAuthToken(): string | null {
  try {
    const token = readFileSync(TOKEN_PATH, "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

function ensureAuthToken(): string {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(TOKEN_PATH)) {
    writeFileSync(TOKEN_PATH, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  }
  chmodSync(TOKEN_PATH, 0o600);
  const token = readAuthToken();
  if (!token) throw new Error("Chatterbox authentication token is empty.");
  return token;
}

async function health(): Promise<Record<string, unknown> | null> {
  const config = settings();
  const token = readAuthToken();
  if (!token) return null;
  try {
    const response = await fetch(`http://${config.host}:${config.port}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, unknown>;
    return data.backend === "chatterbox" && data.modelLoaded === true ? data : null;
  } catch {
    return null;
  }
}

function ensureRuntime(): void {
  const uv = spawnSync("uv", ["--version"], { stdio: "ignore" });
  if (uv.status !== 0) {
    throw new Error("uv is required for Chatterbox. Install it from https://docs.astral.sh/uv/");
  }
  mkdirSync(STATE_DIR, { recursive: true });
  console.log(
    existsSync(PYTHON)
      ? "Checking the Chatterbox environment..."
      : "Creating the isolated Chatterbox environment...",
  );
  const result = spawnSync("uv", ["sync", "--project", BACKEND_DIR, "--python", "3.12"], {
    stdio: "inherit",
    env: { ...process.env, UV_PROJECT_ENVIRONMENT: VENV_DIR },
  });
  if (result.status !== 0 || !existsSync(PYTHON)) {
    throw new Error("Failed to install the Chatterbox Python environment.");
  }
}

async function acquireOperationLock(): Promise<() => void> {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3600; attempt++) {
    try {
      mkdirSync(OPERATION_LOCK_DIR, { mode: 0o700 });
      writeFileSync(OPERATION_LOCK_OWNER, `${process.pid}\n`, { mode: 0o600 });
      return () => {
        try {
          const owner = Number.parseInt(readFileSync(OPERATION_LOCK_OWNER, "utf8").trim(), 10);
          if (owner === process.pid) rmSync(OPERATION_LOCK_DIR, { recursive: true, force: true });
        } catch {
          // lock already removed
        }
      };
    } catch {
      let owner = 0;
      try {
        owner = Number.parseInt(readFileSync(OPERATION_LOCK_OWNER, "utf8").trim(), 10);
      } catch {
        // A live owner may be between atomic directory creation and owner write.
        // Only reap an ownerless lock after a short grace period.
        try {
          if (Date.now() - statSync(OPERATION_LOCK_DIR).mtimeMs > 2000) {
            rmSync(OPERATION_LOCK_DIR, { recursive: true, force: true });
          }
        } catch {
          // lock disappeared; retry
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      if (!Number.isFinite(owner) || !running(owner)) {
        rmSync(OPERATION_LOCK_DIR, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Timed out waiting for Chatterbox operation lock ${OPERATION_LOCK_DIR}`);
}

async function withOperationLock<T>(operation: () => Promise<T>): Promise<T> {
  const release = await acquireOperationLock();
  try {
    return await operation();
  } finally {
    release();
  }
}

async function startLocked(): Promise<void> {
  if (await health()) {
    console.log("Chatterbox is already running.");
    return;
  }
  const config = settings();
  if (!existsSync(config.referenceAudio)) {
    throw new Error(
      `Reference audio is missing. Run: pi-voice chatterbox setup /path/to/voice.wav`,
    );
  }
  const oldPid = readPid();
  if (oldPid && isChatterboxProcess(oldPid)) {
    throw new Error(
      `Chatterbox process ${oldPid} is alive but not healthy. Run chatterbox restart.`,
    );
  }
  try {
    unlinkSync(PID_PATH);
  } catch {
    // no stale pid file
  }
  ensureAuthToken();
  ensureRuntime();
  const logFd = openSync(LOG_PATH, "a");
  const child = spawn(PYTHON, [SERVER_SCRIPT], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  if (!child.pid) throw new Error("Failed to start Chatterbox.");
  writeFileSync(PID_PATH, `${child.pid}\n`, { mode: 0o600 });
  console.log(`Starting Chatterbox (PID ${child.pid}). First use may download several gigabytes.`);
  for (let attempt = 0; attempt < 900; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (await health()) {
      console.log("Chatterbox is ready.");
      return;
    }
    if (!running(child.pid)) {
      throw new Error(`Chatterbox exited during startup. See ${LOG_PATH}`);
    }
  }
  throw new Error(`Timed out waiting for Chatterbox. See ${LOG_PATH}`);
}

async function stopLocked(): Promise<void> {
  const config = settings();
  const token = readAuthToken();
  try {
    if (!token) throw new Error("Authentication token missing");
    await fetch(`http://${config.host}:${config.port}/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // fall back to a verified Chatterbox PID
  }
  const pid = readPid();
  if (pid && isChatterboxProcess(pid)) {
    for (let attempt = 0; attempt < 20 && isChatterboxProcess(pid); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (isChatterboxProcess(pid)) process.kill(pid, "SIGTERM");
  }
  try {
    unlinkSync(PID_PATH);
  } catch {
    // no pid file
  }
  console.log("Chatterbox stopped.");
}

async function start(): Promise<void> {
  return withOperationLock(startLocked);
}

async function stop(): Promise<void> {
  return withOperationLock(stopLocked);
}

async function restart(): Promise<void> {
  return withOperationLock(async () => {
    await stopLocked();
    await startLocked();
  });
}

function setup(referencePath: string | undefined): void {
  if (!referencePath) throw new Error("Usage: pi-voice chatterbox setup /path/to/reference.wav");
  const source = resolve(referencePath);
  if (!existsSync(source)) throw new Error(`Reference audio not found: ${source}`);
  mkdirSync(REFERENCES_DIR, { recursive: true, mode: 0o700 });
  const target = resolve(REFERENCES_DIR, `default-${basename(source)}`);
  copyFileSync(source, target);
  chmodSync(target, 0o600);
  const root = loadRootConfig();
  root.enabled = true;
  root.backend = "chatterbox";
  root.autoSpeak = "exact";
  root.chatterbox = {
    ...settings(),
    referenceAudio: target,
  };
  saveRootConfig(root);
  console.log(`Protected reference copied to ${target}`);
  console.log("Chatterbox selected with exact-word automatic speech.");
}

async function status(): Promise<void> {
  const result = await health();
  if (!result) {
    console.log("Chatterbox: offline");
    return;
  }
  console.log("Chatterbox: online");
  console.log(`Model: ${String(result.model ?? "unknown")}`);
  console.log(`Synthesizing: ${result.synthesizing ? "yes" : "no"}`);
}

export async function handleChatterboxCommand(
  command: string | undefined,
  args: string[],
): Promise<void> {
  switch (command) {
    case "setup":
      await withOperationLock(async () => {
        const pid = readPid();
        const wasRunning = Boolean(pid && isChatterboxProcess(pid));
        setup(args[0]);
        if (wasRunning) {
          await stopLocked();
          await startLocked();
        }
      });
      return;
    case "start":
      await start();
      return;
    case "stop":
      await stop();
      return;
    case "restart":
      await restart();
      return;
    case "status":
      await status();
      return;
    default:
      throw new Error(
        "Usage: pi-voice chatterbox <setup|start|stop|restart|status> [reference.wav]",
      );
  }
}
