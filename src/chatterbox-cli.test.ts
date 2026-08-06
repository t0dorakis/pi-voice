import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "bin", "pi-voice.mjs");
const tempHomes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "pi-voice-chatterbox-cli-"));
  tempHomes.push(home);
  return home;
}

function run(home: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("chatterbox setup", () => {
  it("preserves custom events and protects the copied reference", () => {
    const home = tempHome();
    const voiceDir = join(home, ".pi", "voice");
    mkdirSync(voiceDir, { recursive: true });
    const configPath = join(voiceDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        enabled: false,
        speed: 1.25,
        events: { "custom:done": { text: "Finished." } },
      }),
    );
    const reference = join(home, "voice sample.wav");
    writeFileSync(reference, "not-real-audio-but-setup-only-copies-it");

    const result = run(home, ["chatterbox", "setup", reference]);
    assert.equal(result.status, 0, result.stderr);

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.enabled, true);
    assert.equal(config.backend, "chatterbox");
    assert.equal(config.autoSpeak, "exact");
    assert.deepEqual(config.events, { "custom:done": { text: "Finished." } });
    assert.equal(config.speed, 1.25);
    assert.equal(statSync(config.chatterbox.referenceAudio).mode & 0o777, 0o600);
  });

  it("refuses to overwrite malformed configuration", () => {
    const home = tempHome();
    const voiceDir = join(home, ".pi", "voice");
    mkdirSync(voiceDir, { recursive: true });
    const configPath = join(voiceDir, "config.json");
    writeFileSync(configPath, "{ malformed");
    const reference = join(home, "reference.wav");
    writeFileSync(reference, "sample");

    const result = run(home, ["chatterbox", "setup", reference]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to overwrite/i);
    assert.equal(readFileSync(configPath, "utf8"), "{ malformed");
  });
});
