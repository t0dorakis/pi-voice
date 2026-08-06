/**
 * Unit tests for the pi-voice event system (PRD.md).
 *
 * Tests that the extension emits events on pi.events.emit() per spec:
 *   - voice:config       — on any settings change (TUI toggle, voice, speed, reset, alt+v)
 *   - voice:speak_start  — before TTS synthesis
 *   - voice:speak_end    — after playback (success or error)
 *
 * The extension exports a default factory function(pi). We mock the full
 * pi API, call through the factory, then trigger actions via the captured
 * registrations.
 *
 * Note: Each mock pi has its own _emitted array to prevent cross-test
 * leakage from fire-and-forget speak() callbacks still running from
 * previous tests.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import extensionFactory from "./index.js";

// ── Constants ──────────────────────────────────────────────────────

const CONFIG_DIR = resolve(homedir(), ".pi", "voice");
const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");
const CHATTERBOX_TOKEN_PATH = resolve(CONFIG_DIR, "chatterbox", "auth-token");
const KEY_ESCAPE = "\x1b";
const KEY_ENTER = "\r";
const KEY_LEFT = "\x1b[D";
const KEY_RIGHT = "\x1b[C";
const _KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_R = "r";

/** Wait time for afplay to start, play, and callback to fire (~850ms observed). */
const PLAYBACK_SETTLE = 1200;

// ── Types (mirror PRD interfaces for assertions) ───────────────────

interface VoiceConfigEvent {
  enabled: boolean;
  voice: string;
  speed: number;
}

type VoiceSpeakSource = "tool" | "auto" | "sample";

interface VoiceSpeakStartEvent {
  text: string;
  voice: string;
  speed: number;
  source: VoiceSpeakSource;
}

interface VoiceSpeakEndEvent {
  text: string;
  source: VoiceSpeakSource;
  error?: string;
}

// ── Config backup / restore ────────────────────────────────────────

let configBackup: string | null = null;
let tokenBackup: string | null = null;

function backupConfig() {
  try {
    configBackup = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf-8") : null;
    tokenBackup = existsSync(CHATTERBOX_TOKEN_PATH)
      ? readFileSync(CHATTERBOX_TOKEN_PATH, "utf-8")
      : null;
  } catch {
    configBackup = null;
    tokenBackup = null;
  }
  mkdirSync(resolve(CONFIG_DIR, "chatterbox"), { recursive: true });
  writeFileSync(CHATTERBOX_TOKEN_PATH, "test-token\n");
}

function restoreConfig() {
  try {
    if (configBackup !== null) {
      writeFileSync(CONFIG_PATH, configBackup);
    } else {
      try {
        unlinkSync(CONFIG_PATH);
      } catch {
        /* already gone */
      }
    }
    if (tokenBackup !== null) {
      writeFileSync(CHATTERBOX_TOKEN_PATH, tokenBackup);
    } else {
      try {
        unlinkSync(CHATTERBOX_TOKEN_PATH);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* best effort */
  }
}

/** Write a clean test config without event model (avoids real model lookup). */
function writeTestConfig(overrides: Record<string, unknown> = {}) {
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
        enabled: true,
        voice: "af_heart",
        speed: 1.0,
        events: {
          agent_end: { prompt: "Summarize in one sentence." },
        },
        ...overrides,
      },
      null,
      2,
    ),
  );
}

// ── Valid WAV buffer ───────────────────────────────────────────────

/** Minimal valid WAV that afplay/aplay can play (1 sample of silence at 44100Hz). */
function createValidWav(): ArrayBuffer {
  const buf = new ArrayBuffer(46);
  const v = new DataView(buf);
  // RIFF header
  v.setUint32(0, 0x52494646, false); // "RIFF"
  v.setUint32(4, 38, true); // file size - 8
  v.setUint32(8, 0x57415645, false); // "WAVE"
  // fmt chunk
  v.setUint32(12, 0x666d7420, false); // "fmt "
  v.setUint32(16, 16, true); // chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 44100, true); // sample rate
  v.setUint32(28, 88200, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  // data chunk
  v.setUint32(36, 0x64617461, false); // "data"
  v.setUint32(40, 2, true); // data size
  v.setInt16(44, 0, true); // silence
  return buf;
}

// ── Mock infrastructure ────────────────────────────────────────────

/** Registered commands, tools, shortcuts, event handlers. */
// biome-ignore lint/suspicious/noExplicitAny: mock infrastructure uses flexible any types
let commands: Record<string, { handler: (...args: any[]) => Promise<any> }>;
// biome-ignore lint/suspicious/noExplicitAny: mock infrastructure uses flexible any types
let tools: Record<string, { execute: (...args: any[]) => Promise<any> }>;
// biome-ignore lint/suspicious/noExplicitAny: mock infrastructure uses flexible any types
let shortcuts: Record<string, { handler: (ctx: any) => Promise<void> }>;
// biome-ignore lint/suspicious/noExplicitAny: mock infrastructure uses flexible any types
let piEventHandlers: Record<string, (...args: any[]) => Promise<void>>;

/** Captured TUI component from /voice command. */
let tuiComponent: {
  render: (width: number) => string[];
  handleInput: (data: string) => void;
  invalidate: () => void;
} | null;
let tuiDone: ((result: unknown) => void) | null;
let tuiPromise: Promise<unknown> | null;

const originalFetch = globalThis.fetch;

/**
 * Build a mock pi with its own _emitted array.
 * Each test gets a fresh mock, so old fire-and-forget callbacks
 * from previous tests don't leak events.
 */
function createMockPi() {
  const _emitted: Array<{ event: string; data: unknown }> = [];

  commands = {};
  tools = {};
  shortcuts = {};
  piEventHandlers = {};
  tuiComponent = null;
  tuiDone = null;
  tuiPromise = null;

  return {
    _emitted,
    _entries: [] as Array<{ customType: string; data: unknown }>,
    _execCalls: [] as Array<{ command: string; args: string[] }>,
    async exec(command: string, args: string[]) {
      this._execCalls.push({ command, args });
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
    events: {
      emit(event: string, data: unknown) {
        _emitted.push({ event, data });
      },
      on() {
        return () => {};
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: mock infrastructure uses flexible any types
    registerCommand(name: string, config: { handler: (...args: any[]) => Promise<any> }) {
      commands[name] = config;
    },
    registerTool(config: Record<string, unknown>) {
      // biome-ignore lint/suspicious/noExplicitAny: mock infrastructure uses flexible any types
      tools[config.name as string] = config as any;
    },
    // biome-ignore lint/suspicious/noExplicitAny: mock infrastructure uses flexible any types
    registerShortcut(key: string, config: { handler: (ctx: any) => Promise<void> }) {
      shortcuts[key] = config;
    },
    // biome-ignore lint/suspicious/noExplicitAny: mock infrastructure uses flexible any types
    on(event: string, handler: (...args: any[]) => Promise<void>) {
      piEventHandlers[event] = handler;
    },
    appendEntry(customType: string, data: unknown) {
      // biome-ignore lint/suspicious/noExplicitAny: captured on the mock object
      (this as any)._entries.push({ customType, data });
    },
  };
}

/** Mock fetch to return canned server responses. */
function mockFetch(responses?: {
  health?: Record<string, unknown>;
  voices?: string[];
  ttsOk?: boolean;
}) {
  const healthResponse = responses?.health ?? {
    status: "ok",
    activeDtype: "q4",
    modelLoaded: true,
    loading: false,
  };
  const voicesResponse = responses?.voices ?? ["af_heart", "af_alloy", "bf_emma"];
  const ttsOk = responses?.ttsOk ?? true;

  // biome-ignore lint/suspicious/noExplicitAny: mock fetch accepts any input
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;

    if (url.endsWith("/health")) {
      return new Response(JSON.stringify(healthResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/voices")) {
      return new Response(JSON.stringify({ voices: voicesResponse }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/tts")) {
      if (!ttsOk) {
        return new Response(JSON.stringify({ error: "Server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(createValidWav(), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    }
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  }) as typeof fetch;
}

/** Build a mock ExtensionContext. */
function createMockCtx(overrides: Record<string, unknown> = {}) {
  return {
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
      },
      setStatus() {},
      // biome-ignore lint/suspicious/noExplicitAny: mock factory is intentionally any
      async custom(factory: any) {
        tuiPromise = new Promise((resolve) => {
          tuiDone = resolve;
        });
        const mockTui = { requestRender() {} };
        const mockTheme = {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        };
        const mockKb = {};
        tuiComponent = factory(mockTui, mockTheme, mockKb, (result: unknown) => {
          tuiDone?.(result);
        });
        return tuiPromise;
      },
      notify() {},
    },
    sessionManager: { getBranch: () => [] },
    modelRegistry: { find: () => null },
    model: undefined,
    ...overrides,
  };
}

/** Helper: filter emitted events by name for a specific mock pi. */
// biome-ignore lint/suspicious/noExplicitAny: mock pi is intentionally any
function getEvents(pi: any, name: string): Array<{ event: string; data: unknown }> {
  // biome-ignore lint/suspicious/noExplicitAny: filter callback uses any for flexibility
  return pi._emitted.filter((e: any) => e.event === name);
}

async function waitFor(predicate: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ── Test suite ─────────────────────────────────────────────────────

describe("pi-voice event system", () => {
  beforeEach(() => {
    backupConfig();
    writeTestConfig();
    mockFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreConfig();
    tuiComponent = null;
    tuiDone = null;
    tuiPromise = null;
  });

  // ── voice:config ───────────────────────────────────────────────

  describe("voice:config", () => {
    it("emits when TTS is toggled via /voice TUI", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      const handlerPromise = commands.voice.handler([], createMockCtx());
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(tuiComponent);

      tuiComponent.handleInput(KEY_LEFT);
      tuiComponent.handleInput(KEY_ESCAPE);
      await handlerPromise;

      const events = getEvents(pi, "voice:config");
      assert.ok(events.length >= 1, `Expected voice:config, got ${events.length}`);

      const payload = events[0].data as VoiceConfigEvent;
      assert.equal(typeof payload.enabled, "boolean");
      assert.equal(typeof payload.voice, "string");
      assert.equal(typeof payload.speed, "number");
    });

    it("emits when voice is changed via /voice TUI", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      const handlerPromise = commands.voice.handler([], createMockCtx());
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(tuiComponent);

      tuiComponent.handleInput(KEY_DOWN);
      tuiComponent.handleInput(KEY_RIGHT);
      tuiComponent.handleInput(KEY_ESCAPE);
      await handlerPromise;

      const events = getEvents(pi, "voice:config");
      assert.ok(events.length >= 1);
    });

    it("emits when speed is changed via /voice TUI", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      const handlerPromise = commands.voice.handler([], createMockCtx());
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(tuiComponent);

      tuiComponent.handleInput(KEY_DOWN);
      tuiComponent.handleInput(KEY_DOWN);
      tuiComponent.handleInput(KEY_RIGHT);
      tuiComponent.handleInput(KEY_ESCAPE);
      await handlerPromise;

      const events = getEvents(pi, "voice:config");
      assert.ok(events.length >= 1);
    });

    it("emits when settings are reset via /voice TUI", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      const handlerPromise = commands.voice.handler([], createMockCtx());
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(tuiComponent);

      tuiComponent.handleInput(KEY_R);
      tuiComponent.handleInput(KEY_ESCAPE);
      await handlerPromise;

      const events = getEvents(pi, "voice:config");
      assert.ok(events.length >= 1, "Reset should emit voice:config");
    });
  });

  // ── alt+v keybind ──────────────────────────────────────────────

  describe("alt+v keybind", () => {
    it("emits voice:config when toggling TTS", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await shortcuts["alt+v"].handler(createMockCtx());

      const events = getEvents(pi, "voice:config");
      assert.equal(events.length, 1);

      const payload = events[0].data as VoiceConfigEvent;
      assert.equal(typeof payload.enabled, "boolean");
      assert.equal(typeof payload.voice, "string");
      assert.equal(typeof payload.speed, "number");
    });

    it("toggles enabled state (on → off → on)", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await shortcuts["alt+v"].handler(createMockCtx());
      const first = getEvents(pi, "voice:config")[0].data as VoiceConfigEvent;
      assert.equal(first.enabled, false, "First toggle should disable");

      await shortcuts["alt+v"].handler(createMockCtx());
      const second = getEvents(pi, "voice:config")[1].data as VoiceConfigEvent;
      assert.equal(second.enabled, true, "Second toggle should enable");
    });

    it("keeps toggle session-only: config file unchanged, session entry appended", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await shortcuts["alt+v"].handler(createMockCtx());

      // Session-only settings (a1268d3): the config file is NOT touched ...
      const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      assert.equal(saved.enabled, true, "Config file should be unchanged by alt+v");

      // ... the override lives in a voice-session entry instead.
      const entries = pi._entries.filter(
        (e: { customType: string }) => e.customType === "voice-session",
      );
      assert.ok(entries.length >= 1, "Expected a voice-session entry");
      const last = entries[entries.length - 1].data as { enabled?: boolean };
      assert.equal(last.enabled, false);
    });

    it("voice:config payload has exactly { enabled, voice, speed }", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await shortcuts["alt+v"].handler(createMockCtx());

      const payload = getEvents(pi, "voice:config")[0].data as VoiceConfigEvent;
      const keys = Object.keys(payload).sort();
      assert.deepEqual(keys, ["enabled", "speed", "voice"]);
    });
  });

  // ── voice:speak_start ──────────────────────────────────────────

  describe("voice:speak_start", () => {
    it("emits with source: tool when tts tool is invoked", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute("tc_1", { text: "Hello" }, undefined, undefined, createMockCtx());
      await new Promise((r) => setTimeout(r, 50));

      const events = getEvents(pi, "voice:speak_start");
      assert.ok(events.length >= 1);

      const payload = events[0].data as VoiceSpeakStartEvent;
      assert.equal(payload.text, "Hello");
      assert.equal(payload.source, "tool");
      assert.equal(typeof payload.voice, "string");
      assert.equal(typeof payload.speed, "number");
    });

    it("does NOT emit speak_start when TTS is disabled", async () => {
      writeTestConfig({ enabled: false });
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute("tc_1", { text: "Muted" }, undefined, undefined, createMockCtx());
      await new Promise((r) => setTimeout(r, 50));

      const events = getEvents(pi, "voice:speak_start");
      assert.equal(events.length, 0, "Should not emit speak_start when disabled");
    });

    it("emits with source: sample for TUI playSampleTts", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      const handlerPromise = commands.voice.handler([], createMockCtx());
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(tuiComponent);

      tuiComponent.handleInput(KEY_ENTER);
      await new Promise((r) => setTimeout(r, PLAYBACK_SETTLE));

      const events = getEvents(pi, "voice:speak_start");
      assert.ok(events.length >= 1);
      assert.equal((events[0].data as VoiceSpeakStartEvent).source, "sample");

      tuiComponent.handleInput(KEY_ESCAPE);
      await handlerPromise;
    });

    it("payload matches VoiceSpeakStartEvent interface", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute("tc_1", { text: "Check" }, undefined, undefined, createMockCtx());
      await new Promise((r) => setTimeout(r, 50));

      const payload = getEvents(pi, "voice:speak_start")[0].data as VoiceSpeakStartEvent;
      const keys = Object.keys(payload).sort();
      assert.deepEqual(keys, ["source", "speed", "text", "voice"]);
    });
  });

  // ── voice:speak_end ────────────────────────────────────────────

  describe("voice:speak_end", () => {
    it("emits after successful playback with no error field", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute("tc_1", { text: "Works" }, undefined, undefined, createMockCtx());
      // Wait for: fetch → write WAV → exec afplay → callback
      await new Promise((r) => setTimeout(r, PLAYBACK_SETTLE));

      const events = getEvents(pi, "voice:speak_end");
      assert.ok(events.length >= 1, `Expected voice:speak_end, got ${events.length}`);

      const payload = events[0].data as VoiceSpeakEndEvent;
      assert.equal(payload.text, "Works");
      assert.equal(payload.source, "tool");
      assert.equal("error" in payload, false, "Successful speak_end should not have error field");
    });

    it("emits with error field on TTS server failure", async () => {
      globalThis.fetch = originalFetch;
      mockFetch({ ttsOk: false });

      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute("tc_1", { text: "Fails" }, undefined, undefined, createMockCtx());
      await new Promise((r) => setTimeout(r, 100));

      const events = getEvents(pi, "voice:speak_end");
      assert.ok(events.length >= 1);

      const payload = events[0].data as VoiceSpeakEndEvent;
      assert.equal(payload.source, "tool");
      assert.ok(payload.error, "Should have error field on failure");
      assert.equal(typeof payload.error, "string");
    });

    it("payload has text + source at minimum", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute("tc_1", { text: "Shape" }, undefined, undefined, createMockCtx());
      await waitFor(() => getEvents(pi, "voice:speak_end").length > 0, 3000);

      const payload = getEvents(pi, "voice:speak_end")[0].data as VoiceSpeakEndEvent;
      assert.ok("text" in payload, "Should have text");
      assert.ok("source" in payload, "Should have source");
    });
  });

  // ── source field ───────────────────────────────────────────────

  describe("source field", () => {
    it('"tool" from tts tool', async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute("tc_1", { text: "Src" }, undefined, undefined, createMockCtx());
      await new Promise((r) => setTimeout(r, 50));

      const events = getEvents(pi, "voice:speak_start");
      if (events.length > 0) {
        assert.equal((events[0].data as VoiceSpeakStartEvent).source, "tool");
      }
    });

    it('"sample" from TUI playSampleTts', async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      const handlerPromise = commands.voice.handler([], createMockCtx());
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(tuiComponent);

      tuiComponent.handleInput(KEY_ENTER);
      await new Promise((r) => setTimeout(r, PLAYBACK_SETTLE));

      const events = getEvents(pi, "voice:speak_start");
      if (events.length > 0) {
        assert.equal((events[0].data as VoiceSpeakStartEvent).source, "sample");
      }

      tuiComponent.handleInput(KEY_ESCAPE);
      await handlerPromise;
    });
  });

  // ── paired lifecycle ───────────────────────────────────────────

  describe("speak_start / speak_end pairing", () => {
    it("every speak_start has a corresponding speak_end", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await tools.tts.execute("tc_1", { text: "Pair" }, undefined, undefined, createMockCtx());
      await new Promise((r) => setTimeout(r, PLAYBACK_SETTLE));

      const starts = getEvents(pi, "voice:speak_start").length;
      const ends = getEvents(pi, "voice:speak_end").length;
      assert.equal(ends, starts, "speak_end count should match speak_start count");
    });
  });

  // ── exact Chatterbox auto-speech ───────────────────────────────

  describe("exact Chatterbox auto-speech", () => {
    function configureExact() {
      writeTestConfig({
        backend: "chatterbox",
        autoSpeak: "exact",
        chatterbox: {
          host: "127.0.0.1",
          port: 8182,
          language: "auto",
        },
      });
    }

    it("speaks the final assistant wording at agent_settled without legacy summaries", async () => {
      configureExact();
      const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        requests.push({
          url,
          body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
        });
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ status: "ok", modelLoaded: true }), { status: 200 });
        }
        return new Response(createValidWav(), { status: 200 });
      }) as typeof fetch;

      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);
      const ctx = createMockCtx({
        modelRegistry: { find: () => assert.fail("exact speech must not resolve a summary model") },
      });
      await piEventHandlers.session_start({}, ctx);

      await piEventHandlers.message_end(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "## Genau\nDas ist **meine** Formulierung." }],
          },
        },
        ctx,
      );
      await piEventHandlers.turn_end({ message: { role: "assistant", content: [] } }, ctx);
      await piEventHandlers.agent_end({ messages: [] }, ctx);
      assert.equal(requests.length, 0, "legacy events must not synthesize in exact mode");

      await piEventHandlers.agent_settled({}, ctx);
      await waitFor(() => requests.some((request) => request.url.endsWith("/tts")));

      const start = getEvents(pi, "voice:speak_start")[0].data as VoiceSpeakStartEvent;
      assert.equal(start.text, "Genau\nDas ist meine Formulierung.");
      const tts = requests.find((request) => request.url.endsWith("/tts"));
      assert.equal(tts?.url, "http://127.0.0.1:8182/tts");
      assert.equal(tts?.body?.text, start.text);
      assert.equal(pi._execCalls.length, 0, "healthy Chatterbox must remain lazy");
    });

    it("does not fall back to Kokoro when Chatterbox startup fails", async () => {
      configureExact();
      const urls: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        urls.push(url);
        return new Response(JSON.stringify({ error: "offline" }), { status: 503 });
      }) as typeof fetch;

      const pi = createMockPi();
      pi.exec = async function (command: string, args: string[]) {
        this._execCalls.push({ command, args });
        return { code: 1, stdout: "", stderr: "start failed", killed: false };
      };
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      await piEventHandlers.message_end(
        { message: { role: "assistant", content: [{ type: "text", text: "Only Chatterbox" }] } },
        createMockCtx(),
      );
      await piEventHandlers.agent_settled({}, createMockCtx());
      await waitFor(() => getEvents(pi, "voice:speak_end").length === 1);

      assert.ok(urls.every((url) => url.startsWith("http://127.0.0.1:8182")));
      assert.deepEqual(pi._execCalls[0].args, ["chatterbox", "restart"]);
      assert.match(
        (getEvents(pi, "voice:speak_end")[0].data as VoiceSpeakEndEvent).error ?? "",
        /start failed/,
      );
    });

    it("restarts Chatterbox and retries synthesis exactly once", async () => {
      configureExact();
      let ttsCalls = 0;
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ status: "ok", modelLoaded: true }), { status: 200 });
        }
        ttsCalls++;
        if (ttsCalls === 1) {
          return new Response(JSON.stringify({ error: "synthesis failed" }), { status: 500 });
        }
        return new Response(createValidWav(), { status: 200 });
      }) as typeof fetch;

      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);
      await piEventHandlers.message_end(
        { message: { role: "assistant", content: [{ type: "text", text: "Retry me" }] } },
        createMockCtx(),
      );
      await piEventHandlers.agent_settled({}, createMockCtx());
      await waitFor(() => ttsCalls === 2);

      assert.equal(ttsCalls, 2);
      assert.deepEqual(
        pi._execCalls.map((call: { args: string[] }) => call.args),
        [["chatterbox", "restart"]],
      );
    });

    it("cancels stale synthesis so only the newest response can play", async () => {
      configureExact();
      let firstResolve: ((response: Response) => void) | undefined;
      const ttsTexts: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ status: "ok", modelLoaded: true }), { status: 200 });
        }
        const text = (JSON.parse(String(init?.body)) as { text: string }).text;
        ttsTexts.push(text);
        if (text === "Old response") {
          return new Promise<Response>((resolve) => {
            firstResolve = resolve;
          });
        }
        return new Response(createValidWav(), { status: 200 });
      }) as typeof fetch;

      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);
      const ctx = createMockCtx();
      await piEventHandlers.message_end(
        { message: { role: "assistant", content: [{ type: "text", text: "Old response" }] } },
        ctx,
      );
      const oldSettled = piEventHandlers.agent_settled({}, ctx);
      await waitFor(() => firstResolve !== undefined);

      await piEventHandlers.agent_start({}, ctx);
      await piEventHandlers.message_end(
        { message: { role: "assistant", content: [{ type: "text", text: "Newest response" }] } },
        ctx,
      );
      const newestSettled = piEventHandlers.agent_settled({}, ctx);
      await waitFor(() => ttsTexts.includes("Newest response"));
      firstResolve?.(new Response(createValidWav(), { status: 200 }));
      await Promise.all([oldSettled, newestSettled]);
      await new Promise((resolve) => setTimeout(resolve, PLAYBACK_SETTLE));

      const successful = getEvents(pi, "voice:speak_end")
        .map((event) => event.data as VoiceSpeakEndEvent)
        .filter((event) => !event.error);
      assert.deepEqual(
        successful.map((event) => event.text),
        ["Newest response"],
      );
    });

    it("does not use an event context after session shutdown", async () => {
      configureExact();
      let resolveTts: ((response: Response) => void) | undefined;
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ status: "ok", modelLoaded: true }), { status: 200 });
        }
        return new Promise<Response>((resolve) => {
          resolveTts = resolve;
        });
      }) as typeof fetch;

      let stale = false;
      let staleReads = 0;
      const ctx = new Proxy(createMockCtx(), {
        get(target, property, receiver) {
          if (stale) staleReads++;
          return Reflect.get(target, property, receiver);
        },
      });
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);
      await piEventHandlers.message_end(
        { message: { role: "assistant", content: [{ type: "text", text: "Old session" }] } },
        ctx,
      );
      const settled = piEventHandlers.agent_settled({}, ctx);
      await waitFor(() => resolveTts !== undefined);
      stale = true;
      await piEventHandlers.session_shutdown({}, ctx);
      resolveTts?.(new Response(createValidWav(), { status: 200 }));
      await settled;

      assert.equal(staleReads, 0);
      assert.equal(
        getEvents(pi, "voice:speak_end").filter(
          (event) => !(event.data as VoiceSpeakEndEvent).error,
        ).length,
        0,
      );
    });
  });

  // ── auto-TTS (no model available) ──────────────────────────────

  describe("auto-TTS without model", () => {
    it("does not emit speak events when no model is available", async () => {
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      const handler = piEventHandlers.agent_end;
      assert.ok(handler, "agent_end handler should be registered");

      await handler(
        {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "No model test" }],
            },
          ],
        },
        createMockCtx(),
      );
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(
        getEvents(pi, "voice:speak_start").length,
        0,
        "Should not emit speak_start without a model",
      );
      assert.equal(
        getEvents(pi, "voice:speak_end").length,
        0,
        "Should not emit speak_end without a model",
      );
    });

    it("does not emit speak events when TTS is disabled", async () => {
      writeTestConfig({ enabled: false });
      const pi = createMockPi();
      // biome-ignore lint/suspicious/noExplicitAny: mock pi cast
      extensionFactory(pi as any);

      const handler = piEventHandlers.agent_end;
      assert.ok(handler);

      await handler(
        {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Disabled test" }],
            },
          ],
        },
        createMockCtx(),
      );
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(getEvents(pi, "voice:speak_start").length, 0);
    });
  });
});
