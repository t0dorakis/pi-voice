import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type EventOperations, runHerdrEvent } from "./herdr-cli.ts";
import { piFocusedSpeechPath, piTitleUpdatePath, stablePathKey } from "./herdr-status.ts";

const homes: string[] = [];
const originalHome = process.env.HOME;

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "pi-voice-herdr-test-"));
  homes.push(path);
  process.env.HOME = path;
  const voice = resolve(path, ".pi", "voice");
  mkdirSync(voice, { recursive: true });
  writeFileSync(
    resolve(voice, "config.json"),
    JSON.stringify({
      herdr: { enabled: true, piTitleBridge: true, fastFocusedSpeech: true },
    }),
  );
  return path;
}

function event(status: string, state: string): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    HERDR_PLUGIN_STATE_DIR: state,
    HERDR_BIN_PATH: "/mock/herdr",
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: "pane.agent_status_changed",
      data: { pane_id: "w1:p2", agent_status: status },
    }),
  };
}

afterEach(() => {
  process.env.HOME = originalHome;
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Herdr event orchestration", () => {
  it("summarizes, speaks, renames, and writes a Pi title update without real services", async () => {
    const tempHome = home();
    const state = resolve(tempHome, "plugin-state");
    const sessionPath = resolve(tempHome, "session.jsonl");
    const calls: string[] = [];
    const operations: EventOperations = {
      async run(_command, args) {
        calls.push(args.join(" "));
        if (args[1] === "get") {
          return JSON.stringify({
            result: {
              pane: {
                pane_id: "w1:p2",
                focused: false,
                agent: "pi",
                agent_status: "done",
                agent_session: { agent: "pi", kind: "path", value: sessionPath },
              },
            },
          });
        }
        return Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
      },
      async summarize(text) {
        calls.push(`summary:${text.split("\n").length}`);
        return JSON.stringify({
          announcement: "Der Agent hat alle Tests erfolgreich abgeschlossen und wartet jetzt.",
          title: "Alle Tests abgeschlossen",
          rename: true,
        });
      },
      async startChatterbox() {
        calls.push("start");
      },
      async synthesize(text) {
        calls.push(`tts:${text}`);
        return Buffer.from("fake wav");
      },
      async playPing() {
        calls.push("ping");
      },
      async play(path) {
        calls.push("play");
        assert.equal(statSync(path).mode & 0o777, 0o600);
      },
      async renamePane(paneId, title) {
        calls.push(`rename:${paneId}:${title}`);
      },
      async renameWorkspace(workspaceId, title) {
        calls.push(`rename-workspace:${workspaceId}:${title}`);
      },
    };

    await runHerdrEvent(event("done", state), operations);

    assert.ok(calls.includes("pane read w1:p2 --source recent-unwrapped --lines 80 --format text"));
    assert.ok(calls.includes("summary:80"));
    assert.ok(calls.includes("ping"));
    assert.ok(calls.includes("tts:Der Agent Alle Tests abgeschlossen ist fertig."));
    assert.ok(calls.includes("play"));
    assert.ok(calls.includes("rename:w1:p2:Alle Tests abgeschlossen"));
    const paneState = JSON.parse(
      readFileSync(resolve(state, "panes", `${stablePathKey("w1:p2")}.json`), "utf8"),
    );
    assert.equal(paneState.lastAutoTitle, "Alle Tests abgeschlossen");
    const update = JSON.parse(
      readFileSync(
        piTitleUpdatePath(resolve(tempHome, ".pi", "voice", "herdr", "pi-titles"), sessionPath),
        "utf8",
      ),
    );
    assert.equal(update.sessionPath, sessionPath);
  });

  it("treats working as cancellation only", async () => {
    const tempHome = home();
    let called = false;
    const operations = new Proxy({} as EventOperations, {
      get() {
        called = true;
        throw new Error("operation should not run");
      },
    });
    await runHerdrEvent(event("working", resolve(tempHome, "state")), operations);
    assert.equal(called, false);
  });

  it("prevents an older hook from speaking after a newer claim", async () => {
    const tempHome = home();
    const state = resolve(tempHome, "state");
    let releaseSummary: ((value: string) => void) | undefined;
    let summaryStarted: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => {
      summaryStarted = resolveStarted;
    });
    let spoke = false;
    const operations: EventOperations = {
      async run(_command, args) {
        if (args[1] === "get") {
          return JSON.stringify({
            result: {
              pane: { pane_id: "w1:p2", focused: false, agent: "pi", agent_status: "done" },
            },
          });
        }
        return "Recent controlled pane output";
      },
      summarize() {
        summaryStarted?.();
        return new Promise((resolveSummary) => {
          releaseSummary = resolveSummary;
        });
      },
      async startChatterbox() {
        spoke = true;
      },
      async synthesize() {
        spoke = true;
        return Buffer.alloc(0);
      },
      async playPing() {},
      async play() {
        spoke = true;
      },
      async renamePane() {},
      async renameWorkspace() {},
    };
    const older = runHerdrEvent(event("done", state), operations);
    await started;
    await runHerdrEvent(event("working", state), operations);
    releaseSummary?.(
      JSON.stringify({
        announcement: "Der Agent hat alle Tests erfolgreich abgeschlossen und wartet jetzt.",
        title: "Alle Tests abgeschlossen",
        rename: true,
      }),
    );
    await older;
    assert.equal(spoke, false);
  });

  it("speaks a trusted exact lead before naming focused single-pane workspaces", async () => {
    const tempHome = home();
    const sessionPath = resolve(tempHome, "focused-session.jsonl");
    const speechPath = piFocusedSpeechPath(
      resolve(tempHome, ".pi", "voice", "herdr", "pi-focused-speech"),
      "w1:p2",
      sessionPath,
    );
    mkdirSync(resolve(speechPath, ".."), { recursive: true });
    writeFileSync(
      speechPath,
      JSON.stringify({
        paneId: "w1:p2",
        sessionPath,
        runToken: "test-run-token",
        text: "Die fokussierte Antwort ist jetzt schnell hörbar. Weitere Details folgen.",
        writtenAt: Date.now(),
      }),
    );
    let summarized = false;
    const synthesized: string[] = [];
    let played = false;
    let renamed = false;
    let workspaceRenamed = false;
    const operations: EventOperations = {
      async run(_command, args) {
        if (args[0] === "workspace") {
          return JSON.stringify({
            result: {
              workspace: { workspace_id: "w1", label: "my-project", pane_count: 1 },
            },
          });
        }
        if (args[1] === "get") {
          return JSON.stringify({
            result: {
              pane: {
                pane_id: "w1:p2",
                workspace_id: "w1",
                cwd: "/tmp/my-project",
                focused: true,
                agent: "pi",
                agent_status: "idle",
                agent_session: { agent: "pi", kind: "path", value: sessionPath },
              },
            },
          });
        }
        return "Die Implementierung der Herdr-Sprachmeldungen ist jetzt vollständig getestet.";
      },
      async summarize() {
        summarized = true;
        return JSON.stringify({
          announcement:
            "Die Herdr-Sprachmeldungen sind vollständig implementiert und erfolgreich getestet worden.",
          title: "Herdr-Sprachmeldungen in Pi integrieren",
          rename: true,
        });
      },
      async startChatterbox() {},
      async synthesize(text) {
        synthesized.push(text);
        return Buffer.from("fake wav");
      },
      async playPing() {
        throw new Error("focused panes must not ping");
      },
      async play() {
        played = true;
      },
      async renamePane() {
        renamed = true;
      },
      async renameWorkspace() {
        workspaceRenamed = true;
      },
    };
    await runHerdrEvent(event("idle", resolve(tempHome, "state")), operations);
    assert.equal(summarized, true);
    assert.equal(renamed, true);
    assert.equal(workspaceRenamed, true);
    assert.deepEqual(synthesized, ["Die fokussierte Antwort ist jetzt schnell hörbar."]);
    assert.equal(existsSync(speechPath), false);
    assert.equal(played, true);
  });

  it("continues through Luna naming and speech when the focused fast path fails", async () => {
    const tempHome = home();
    const sessionPath = resolve(tempHome, "fallback-session.jsonl");
    const speechPath = piFocusedSpeechPath(
      resolve(tempHome, ".pi", "voice", "herdr", "pi-focused-speech"),
      "w1:p2",
      sessionPath,
    );
    mkdirSync(resolve(speechPath, ".."), { recursive: true });
    writeFileSync(
      speechPath,
      JSON.stringify({
        paneId: "w1:p2",
        sessionPath,
        runToken: "fallback-run",
        text: "Die schnelle Ausgabe schlägt kontrolliert fehl.",
        writtenAt: Date.now(),
      }),
    );
    const synthesized: string[] = [];
    let renamed = false;
    let played = false;
    const operations: EventOperations = {
      async run(_command, args) {
        if (args[1] === "get") {
          return JSON.stringify({
            result: {
              pane: {
                pane_id: "w1:p2",
                focused: true,
                agent: "pi",
                agent_status: "idle",
                agent_session: { agent: "pi", kind: "path", value: sessionPath },
              },
            },
          });
        }
        return "Die Implementierung ist vollständig getestet.";
      },
      async summarize() {
        return JSON.stringify({
          announcement: "Die sichere Luna-Ausgabe übernimmt nach dem Fehler erfolgreich.",
          title: "Sichere Sprachfallbacks implementieren",
          rename: true,
        });
      },
      async startChatterbox() {},
      async synthesize(text) {
        synthesized.push(text);
        if (synthesized.length === 1) throw new Error("fast synthesis failed");
        return Buffer.from("fallback wav");
      },
      async playPing() {
        throw new Error("focused fallback must not ping");
      },
      async play() {
        played = true;
      },
      async renamePane() {
        renamed = true;
      },
      async renameWorkspace() {},
    };
    await runHerdrEvent(event("idle", resolve(tempHome, "state")), operations);
    assert.deepEqual(synthesized, [
      "Die schnelle Ausgabe schlägt kontrolliert fehl.",
      "Die sichere Luna-Ausgabe übernimmt nach dem Fehler erfolgreich.",
    ]);
    assert.equal(renamed, true);
    assert.equal(played, true);
  });

  it("rejects a stale completion event when the pane is already working", async () => {
    const tempHome = home();
    let summarized = false;
    const operations: EventOperations = {
      async run() {
        return JSON.stringify({
          result: {
            pane: { pane_id: "w1:p2", focused: false, agent: "pi", agent_status: "working" },
          },
        });
      },
      async summarize() {
        summarized = true;
        return "";
      },
      async startChatterbox() {},
      async synthesize() {
        return Buffer.alloc(0);
      },
      async playPing() {},
      async play() {},
      async renamePane() {},
      async renameWorkspace() {},
    };
    await runHerdrEvent(event("done", resolve(tempHome, "state")), operations);
    assert.equal(summarized, false);
  });
});
