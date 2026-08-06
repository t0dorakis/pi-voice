/**
 * Unit tests for extensions/audio.ts. All process and temp-file operations are
 * injected; these tests never invoke an audio player or ffmpeg.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUDIO_PLAYBACK_TIMEOUT_MS,
  type AudioPlaybackOperations,
  createAudioQueue,
  getAtempoFilter,
  getAudioPlayer,
  playWav,
} from "./audio.ts";

interface ProcessCall {
  command: string;
  args: string[];
  signal?: AbortSignal;
  timeout: number;
}

function fakeOperations(
  run: AudioPlaybackOperations["runProcess"] = async () => {},
): AudioPlaybackOperations & { calls: ProcessCall[]; removed: string[]; prefixes: string[] } {
  const calls: ProcessCall[] = [];
  const removed: string[] = [];
  const prefixes: string[] = [];
  return {
    calls,
    removed,
    prefixes,
    runProcess: async (command, args, options) => {
      calls.push({ command, args, ...options });
      await run(command, args, options);
    },
    makeTempDir: async (prefix) => {
      prefixes.push(prefix);
      return "/virtual/tmp/speed-work";
    },
    removeTempDir: async (path) => {
      removed.push(path);
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition was not reached");
}

describe("getAudioPlayer", () => {
  it("uses afplay on macOS with a PATH fallback", () => {
    assert.equal(
      getAudioPlayer("darwin", () => true),
      "/usr/bin/afplay",
    );
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
      getAudioPlayer("linux", (path) => path === "/usr/bin/paplay"),
      "/usr/bin/paplay",
    );
    assert.equal(
      getAudioPlayer("linux", (path) => path === "/usr/bin/aplay"),
      "/usr/bin/aplay",
    );
    assert.equal(
      getAudioPlayer("linux", () => false),
      "aplay",
    );
  });
});

describe("getAtempoFilter", () => {
  it("supports the full 0.5-3 range and chains factors above 2", () => {
    assert.equal(getAtempoFilter(0.5), "atempo=0.5");
    assert.equal(getAtempoFilter(1), "atempo=1");
    assert.equal(getAtempoFilter(2), "atempo=2");
    assert.equal(getAtempoFilter(2.5), "atempo=2,atempo=1.25");
    assert.equal(getAtempoFilter(3), "atempo=2,atempo=1.5");
  });

  it("rejects non-finite and out-of-range speeds", () => {
    for (const speed of [0.49, 3.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => getAtempoFilter(speed), RangeError);
    }
  });
});

describe("playWav", () => {
  it("bypasses ffmpeg at 1x and invokes the player with only the WAV path", async () => {
    const operations = fakeOperations();

    await playWav("/audio/input.wav", {
      operations,
      player: "/usr/bin/afplay",
    });

    assert.deepEqual(operations.calls, [
      {
        command: "/usr/bin/afplay",
        args: ["/audio/input.wav"],
        signal: undefined,
        timeout: AUDIO_PLAYBACK_TIMEOUT_MS,
      },
    ]);
    assert.deepEqual(operations.prefixes, []);
    assert.deepEqual(operations.removed, []);
  });

  it("renders adjusted audio with ffmpeg before plain afplay playback", async () => {
    const operations = fakeOperations();
    const controller = new AbortController();

    await playWav("/audio/input.wav", {
      speed: 3,
      signal: controller.signal,
      operations,
      player: "/usr/bin/afplay",
      ffmpeg: "/opt/ffmpeg",
    });

    assert.equal(operations.prefixes.length, 1);
    assert.match(operations.prefixes[0], /pi-voice-speed-$/);
    assert.deepEqual(operations.calls, [
      {
        command: "/opt/ffmpeg",
        args: [
          "-y",
          "-i",
          "/audio/input.wav",
          "-filter:a",
          "atempo=2,atempo=1.5",
          "/virtual/tmp/speed-work/adjusted.wav",
        ],
        signal: controller.signal,
        timeout: AUDIO_PLAYBACK_TIMEOUT_MS,
      },
      {
        command: "/usr/bin/afplay",
        args: ["/virtual/tmp/speed-work/adjusted.wav"],
        signal: controller.signal,
        timeout: AUDIO_PLAYBACK_TIMEOUT_MS,
      },
    ]);
    assert.ok(!operations.calls[1].args.includes("--rate"));
    assert.deepEqual(operations.removed, ["/virtual/tmp/speed-work"]);
  });

  it("passes cancellation to an active player process", async () => {
    const controller = new AbortController();
    const operations = fakeOperations(
      async (_command, _args, { signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Playback aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    const playback = playWav("/audio/input.wav", {
      signal: controller.signal,
      operations,
      player: "afplay",
    });
    await waitFor(() => operations.calls.length === 1);
    controller.abort();

    await assert.rejects(playback, { name: "AbortError" });
    assert.equal(operations.calls[0].signal, controller.signal);
  });

  it("does not start work when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const operations = fakeOperations();

    await assert.rejects(
      playWav("/audio/input.wav", {
        speed: 2,
        signal: controller.signal,
        operations,
      }),
      { name: "AbortError" },
    );
    assert.equal(operations.calls.length, 0);
    assert.equal(operations.prefixes.length, 0);
  });

  it("cleans adjusted audio when ffmpeg fails", async () => {
    const failure = new Error("ffmpeg failed");
    const operations = fakeOperations(async () => {
      throw failure;
    });

    await assert.rejects(
      playWav("/audio/input.wav", { speed: 0.5, operations, player: "afplay" }),
      failure,
    );
    assert.equal(operations.calls.length, 1);
    assert.deepEqual(operations.removed, ["/virtual/tmp/speed-work"]);
  });

  it("cleans adjusted audio when playback fails or is aborted between processes", async () => {
    const playerFailure = new Error("player failed");
    const failingOperations = fakeOperations(async (command) => {
      if (command === "afplay") throw playerFailure;
    });
    await assert.rejects(
      playWav("/audio/input.wav", {
        speed: 2,
        operations: failingOperations,
        player: "afplay",
      }),
      playerFailure,
    );
    assert.deepEqual(failingOperations.removed, ["/virtual/tmp/speed-work"]);

    const controller = new AbortController();
    const abortedOperations = fakeOperations(async (command) => {
      if (command === "ffmpeg") controller.abort();
    });
    await assert.rejects(
      playWav("/audio/input.wav", {
        speed: 2,
        signal: controller.signal,
        operations: abortedOperations,
        player: "afplay",
      }),
      { name: "AbortError" },
    );
    assert.equal(abortedOperations.calls.length, 1);
    assert.deepEqual(abortedOperations.removed, ["/virtual/tmp/speed-work"]);
  });
});

describe("createAudioQueue", () => {
  it("cancels active playback, clears pending work, and plays only the newest item", async () => {
    const queue = createAudioQueue();
    const started: string[] = [];
    let firstAborted = false;

    queue.enqueue({
      play: (signal) => {
        started.push("first");
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              firstAborted = true;
              reject(new DOMException("Superseded", "AbortError"));
            },
            { once: true },
          );
        });
      },
    });
    queue.enqueue({
      play: async () => {
        started.push("pending");
      },
    });
    queue.enqueue({
      play: async () => {
        started.push("newest");
      },
    });

    assert.equal(firstAborted, true);
    assert.equal(queue.size, 1);
    await waitFor(() => !queue.playing);
    assert.deepEqual(started, ["first", "newest"]);
    assert.equal(queue.size, 0);
  });

  it("cancel aborts active work and discards pending work", async () => {
    const queue = createAudioQueue();
    let aborted = false;
    queue.enqueue({
      play: (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("Cancelled", "AbortError"));
          });
        }),
    });

    queue.cancel();
    assert.equal(aborted, true);
    assert.equal(queue.size, 0);
    await waitFor(() => !queue.playing);
  });

  it("recovers from rejected and synchronously throwing items", async () => {
    const queue = createAudioQueue();
    const started: string[] = [];
    queue.enqueue({
      play: () => {
        started.push("bad");
        throw new Error("exploded");
      },
    });
    queue.enqueue({
      // A no-argument callback remains compatible with the prior QueueItem API.
      play: async () => {
        started.push("good");
      },
    });

    await waitFor(() => !queue.playing);
    assert.deepEqual(started, ["bad", "good"]);
  });
});
