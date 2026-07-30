/**
 * Unit tests for extensions/audio.ts — player detection (injected fs) and
 * the serial playback queue (fake play functions, no audio hardware).
 *
 * Run with: node --import jiti/register extensions/audio.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAudioQueue, getAudioPlayer } from "./audio.ts";

describe("getAudioPlayer", () => {
  it("uses afplay on macOS", () => {
    assert.equal(
      getAudioPlayer("darwin", () => true),
      "/usr/bin/afplay",
    );
    // Falls back to PATH lookup if the absolute path is missing.
    assert.equal(
      getAudioPlayer("darwin", () => false),
      "afplay",
    );
  });

  it("prefers pw-play, then paplay, then aplay on Linux", () => {
    assert.equal(
      getAudioPlayer("linux", () => true),
      "/usr/bin/pw-play",
    );
    assert.equal(
      getAudioPlayer("linux", (p) => p === "/usr/bin/paplay"),
      "/usr/bin/paplay",
    );
    assert.equal(
      getAudioPlayer("linux", (p) => p === "/usr/bin/aplay"),
      "/usr/bin/aplay",
    );
  });

  it("falls back to bare aplay when nothing is installed", () => {
    assert.equal(
      getAudioPlayer("linux", () => false),
      "aplay",
    );
  });
});

describe("createAudioQueue", () => {
  /** Deferred promise helper. */
  function deferred() {
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const tick = () => new Promise((r) => setTimeout(r, 10));

  it("plays items one at a time, in FIFO order", async () => {
    const queue = createAudioQueue();
    const started: string[] = [];
    const finished: string[] = [];
    const gates = [deferred(), deferred(), deferred()];

    const makeItem = (name: string, gate: ReturnType<typeof deferred>) => ({
      play: async () => {
        started.push(name);
        await gate.promise;
        finished.push(name);
      },
    });

    queue.enqueue(makeItem("a", gates[0]));
    queue.enqueue(makeItem("b", gates[1]));
    queue.enqueue(makeItem("c", gates[2]));

    // Only the first item may start while it's blocked.
    await tick();
    assert.deepEqual(started, ["a"]);
    assert.equal(queue.playing, true);
    assert.equal(queue.size, 2);

    // Release in order; each next item starts only after the previous ends.
    gates[0].resolve();
    await tick();
    assert.deepEqual(started, ["a", "b"]);
    gates[1].resolve();
    await tick();
    assert.deepEqual(started, ["a", "b", "c"]);
    gates[2].resolve();
    await tick();

    assert.deepEqual(finished, ["a", "b", "c"]);
    assert.equal(queue.playing, false);
    assert.equal(queue.size, 0);
  });

  it("a failing item does not block the rest of the queue", async () => {
    const queue = createAudioQueue();
    const played: string[] = [];

    queue.enqueue({
      play: () => {
        played.push("bad");
        return Promise.reject(new Error("playback exploded"));
      },
    });
    queue.enqueue({
      play: async () => {
        played.push("good");
      },
    });

    // Give the queue time to drain both items.
    for (let i = 0; i < 20 && played.length < 2; i++) await tick();

    assert.deepEqual(played, ["bad", "good"]);
    assert.equal(queue.playing, false);
  });

  it("items enqueued while playing are still drained", async () => {
    const queue = createAudioQueue();
    const played: string[] = [];
    const gate = deferred();

    queue.enqueue({
      play: async () => {
        played.push("first");
        await gate.promise;
      },
    });
    await tick();
    queue.enqueue({
      play: async () => {
        played.push("second");
      },
    });
    gate.resolve();

    for (let i = 0; i < 20 && played.length < 2; i++) await tick();
    assert.deepEqual(played, ["first", "second"]);
  });
});
