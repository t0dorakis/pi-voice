/**
 * Unit tests for extensions/config.ts — persistence against a temp dir,
 * never the real ~/.pi/voice/config.json.
 *
 * Run with: node --import jiti/register extensions/config.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_CONFIG, DEFAULT_SUMMARY_PROMPT, loadConfig, saveConfig } from "./config.ts";

let dir: string;
let configPath: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-voice-config-test-"));
  configPath = join(dir, "config.json");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns defaults (with the default agent_end event) when no file exists", () => {
    const config = loadConfig(configPath);
    assert.deepEqual(config, { ...DEFAULT_CONFIG });
    assert.ok(config.events?.agent_end);
    assert.equal((config.events.agent_end as { prompt: string }).prompt, DEFAULT_SUMMARY_PROMPT);
  });

  it("returns defaults when the file is invalid JSON", () => {
    writeFileSync(configPath, "{ not json");
    const config = loadConfig(configPath);
    assert.deepEqual(config, { ...DEFAULT_CONFIG });
  });

  it("reads user values, filling gaps with defaults", () => {
    writeFileSync(configPath, JSON.stringify({ enabled: false, speed: 1.75 }));
    const config = loadConfig(configPath);
    assert.equal(config.enabled, false);
    assert.equal(config.speed, 1.75);
    assert.equal(config.voice, DEFAULT_CONFIG.voice);
    assert.equal(config.host, DEFAULT_CONFIG.host);
    assert.equal(config.port, DEFAULT_CONFIG.port);
  });

  it("does NOT merge events: a config without events disables auto-TTS", () => {
    writeFileSync(configPath, JSON.stringify({ enabled: true }));
    const config = loadConfig(configPath);
    assert.equal(config.events, undefined);
  });

  it("keeps user-defined events as written", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        events: {
          turn_end: { text: "Turn done." },
          agent_end: { prompt: "Summarize.", model: { provider: "openai", id: "gpt-4" } },
        },
      }),
    );
    const config = loadConfig(configPath);
    assert.deepEqual(config.events?.turn_end, { text: "Turn done." });
    assert.deepEqual(config.events?.agent_end, {
      prompt: "Summarize.",
      model: { provider: "openai", id: "gpt-4" },
    });
  });
});

describe("saveConfig", () => {
  it("writes parseable JSON that loadConfig round-trips", () => {
    const config = {
      enabled: false,
      voice: "bf_emma",
      speed: 2.0,
      host: "127.0.0.1",
      port: 9999,
    };
    saveConfig(config, configPath);
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.equal(raw.voice, "bf_emma");
    assert.equal(raw.port, 9999);

    const loaded = loadConfig(configPath);
    assert.deepEqual(loaded, { ...config, events: undefined });
  });

  it("creates missing parent directories", () => {
    const nested = join(dir, "a", "b", "config.json");
    saveConfig({ ...DEFAULT_CONFIG }, nested);
    const loaded = loadConfig(nested);
    assert.equal(loaded.voice, DEFAULT_CONFIG.voice);
  });
});
