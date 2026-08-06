import { type FSWatcher, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type PiTitleUpdate, piTitleUpdatePath, readJsonFile } from "../src/herdr-status.ts";

interface BridgeConfig {
  herdr?: { enabled?: boolean; piTitleBridge?: boolean };
}

const REPORT_SOURCE = "herdr:pi";
const REPORT_AGENT = "pi";
const SEQUENCE_FLOOR = 18_000_000_000_000_000_000n;

function voiceDirectory(): string {
  return resolve(homedir(), ".pi", "voice");
}

function bridgeEnabled(): boolean {
  if (process.env.HERDR_ENV !== "1") return false;
  try {
    const path = resolve(voiceDirectory(), "config.json");
    const config = JSON.parse(readFileSync(path, "utf8")) as BridgeConfig;
    return config.herdr?.enabled === true && config.herdr.piTitleBridge === true;
  } catch {
    return false;
  }
}

function initialSequence(): bigint {
  try {
    const stored = BigInt(
      readFileSync(resolve(voiceDirectory(), "herdr", "pi-report-seq"), "utf8"),
    );
    return stored > SEQUENCE_FLOOR ? stored : SEQUENCE_FLOOR;
  } catch {
    return SEQUENCE_FLOOR;
  }
}

export default function herdrPiBridge(pi: ExtensionAPI): void {
  let watcher: FSWatcher | undefined;
  let active = false;
  let sessionPath: string | undefined;
  let blockedCount = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let sequence = initialSequence();
  let reports = Promise.resolve();
  const herdr = process.env.HERDR_BIN_PATH || "herdr";
  const paneId = process.env.HERDR_PANE_ID;

  function nextSequence(): string {
    sequence += 1n;
    const directory = resolve(voiceDirectory(), "herdr");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, "pi-report-seq");
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${sequence}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    return sequence.toString();
  }

  function enqueue(args: string[]): void {
    if (!active || !paneId) return;
    const commandArgs = [...args, "--seq", nextSequence()];
    reports = reports
      .then(async () => {
        const result = await pi.exec(herdr, commandArgs, { timeout: 5000 });
        if (result.code !== 0) {
          console.warn(`[pi-voice] Herdr report failed: ${result.stderr.trim()}`);
        }
      })
      .catch((error) => {
        console.warn(
          `[pi-voice] Herdr report failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  function clearIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  function reportState(state: "working" | "blocked" | "idle", message?: string): void {
    if (!paneId) return;
    const args = [
      "pane",
      "report-agent",
      paneId,
      "--source",
      REPORT_SOURCE,
      "--agent",
      REPORT_AGENT,
      "--state",
      state,
    ];
    if (sessionPath) args.push("--agent-session-path", sessionPath);
    if (message) args.push("--message", message);
    enqueue(args);
  }

  function startTitleWatcher(currentSessionPath: string): void {
    const directory = resolve(voiceDirectory(), "herdr", "pi-titles");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const expectedPath = piTitleUpdatePath(directory, currentSessionPath);
    const apply = () => {
      const update = readJsonFile<PiTitleUpdate>(expectedPath);
      if (
        !update ||
        resolve(update.sessionPath) !== resolve(currentSessionPath) ||
        !update.title.trim()
      ) {
        return;
      }
      const current = pi.getSessionName();
      if (!current || current === update.previousAutoTitle) pi.setSessionName(update.title.trim());
    };
    apply();
    watcher = watch(directory, (_eventType, filename) => {
      if (!filename || resolve(directory, String(filename)) === expectedPath) apply();
    });
  }

  pi.events.on("herdr:blocked", (raw) => {
    if (!active) return;
    const data = raw as { active?: boolean; label?: string } | undefined;
    if (data?.active) {
      blockedCount += 1;
      reportState("blocked", data.label);
      return;
    }
    blockedCount = Math.max(0, blockedCount - 1);
    reportState(blockedCount > 0 ? "blocked" : "working");
  });

  pi.on("session_start", (event, ctx) => {
    watcher?.close();
    watcher = undefined;
    active = bridgeEnabled() && ctx.hasUI === true && Boolean(paneId);
    if (!active) return;
    sessionPath = ctx.sessionManager.getSessionFile();
    blockedCount = 0;
    if (sessionPath && paneId) {
      const startSource =
        event.reason === "new" || event.reason === "resume" || event.reason === "fork"
          ? event.reason
          : "startup";
      enqueue([
        "pane",
        "report-agent-session",
        paneId,
        "--source",
        REPORT_SOURCE,
        "--agent",
        REPORT_AGENT,
        "--agent-session-path",
        sessionPath,
        "--session-start-source",
        startSource,
      ]);
      startTitleWatcher(sessionPath);
    }
    reportState(ctx.isIdle() ? "idle" : "working");
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!active) return;
    clearIdleTimer();
    sessionPath = ctx.sessionManager.getSessionFile() ?? sessionPath;
    reportState(blockedCount > 0 ? "blocked" : "working");
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!active) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (active && ctx.isIdle()) reportState(blockedCount > 0 ? "blocked" : "idle");
    }, 500);
    idleTimer.unref?.();
  });

  pi.on("agent_settled", () => {
    if (!active) return;
    clearIdleTimer();
    reportState(blockedCount > 0 ? "blocked" : "idle");
  });

  pi.on("session_shutdown", async (event) => {
    clearIdleTimer();
    watcher?.close();
    watcher = undefined;
    if (active && event.reason === "quit" && paneId) {
      enqueue([
        "pane",
        "release-agent",
        paneId,
        "--source",
        REPORT_SOURCE,
        "--agent",
        REPORT_AGENT,
      ]);
      await reports;
    }
    active = false;
    sessionPath = undefined;
    blockedCount = 0;
  });
}
