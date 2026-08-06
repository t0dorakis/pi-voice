/**
 * Audio playback for pi-voice: player detection, cancellable WAV playback,
 * speed adjustment, and a newest-wins playback queue.
 *
 * Process and temporary-file operations are injectable so tests never touch
 * audio hardware or invoke ffmpeg.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Long summaries can exceed 30s of audio; give playback ample time.
export const AUDIO_PLAYBACK_TIMEOUT_MS = 5 * 60 * 1000;

// Injectable for tests — the real wiring passes no arguments.
export function getAudioPlayer(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform === "darwin") {
    return exists("/usr/bin/afplay") ? "/usr/bin/afplay" : "afplay";
  }
  // Linux: prefer PipeWire/PulseAudio players, fall back to ALSA.
  const candidates = [
    "/usr/bin/pw-play",
    "/usr/local/bin/pw-play",
    "/usr/bin/paplay",
    "/usr/local/bin/paplay",
    "/usr/bin/aplay",
    "/usr/local/bin/aplay",
  ];
  for (const cmd of candidates) {
    if (exists(cmd)) return cmd;
  }
  return "aplay";
}

export interface ProcessRunOptions {
  signal?: AbortSignal;
  timeout: number;
}

export interface AudioPlaybackOperations {
  runProcess(command: string, args: string[], options: ProcessRunOptions): Promise<void>;
  makeTempDir(prefix: string): Promise<string>;
  removeTempDir(path: string): Promise<void>;
}

function runProcess(
  command: string,
  args: string[],
  { signal, timeout }: ProcessRunOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      execFile(command, args, { signal, timeout }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

const defaultOperations: AudioPlaybackOperations = {
  runProcess,
  makeTempDir: (prefix) => mkdtemp(prefix),
  removeTempDir: (path) => rm(path, { recursive: true, force: true }),
};

export interface PlayWavOptions {
  /** Playback multiplier. ffmpeg's atempo supports each stage in [0.5, 2]. */
  speed?: number;
  signal?: AbortSignal;
  operations?: AudioPlaybackOperations;
  player?: string;
  ffmpeg?: string;
}

function abortIfNeeded(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** Build an ffmpeg atempo chain whose individual stages stay in [0.5, 2]. */
export function getAtempoFilter(speed: number): string {
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 3) {
    throw new RangeError("Playback speed must be between 0.5 and 3");
  }

  const stages: number[] = [];
  let remaining = speed;
  while (remaining > 2) {
    stages.push(2);
    remaining /= 2;
  }
  stages.push(remaining);
  return stages.map((stage) => `atempo=${stage}`).join(",");
}

/**
 * Play a WAV file without a shell. Non-1x speed is rendered to a temporary WAV
 * by ffmpeg first; players (including afplay) always receive only the WAV path.
 */
export async function playWav(outPath: string, options: PlayWavOptions = {}): Promise<void> {
  const {
    speed = 1,
    signal,
    operations = defaultOperations,
    player = getAudioPlayer(),
    ffmpeg = "ffmpeg",
  } = options;
  const filter = getAtempoFilter(speed);
  abortIfNeeded(signal);

  if (speed === 1) {
    await operations.runProcess(player, [outPath], {
      signal,
      timeout: AUDIO_PLAYBACK_TIMEOUT_MS,
    });
    return;
  }

  const tempDir = await operations.makeTempDir(join(tmpdir(), "pi-voice-speed-"));
  const adjustedPath = join(tempDir, "adjusted.wav");
  try {
    abortIfNeeded(signal);
    await operations.runProcess(ffmpeg, ["-y", "-i", outPath, "-filter:a", filter, adjustedPath], {
      signal,
      timeout: AUDIO_PLAYBACK_TIMEOUT_MS,
    });
    abortIfNeeded(signal);
    await operations.runProcess(player, [adjustedPath], {
      signal,
      timeout: AUDIO_PLAYBACK_TIMEOUT_MS,
    });
  } finally {
    // Cleanup is best-effort and must not hide a playback/transcoding failure.
    await operations.removeTempDir(tempDir).catch(() => {});
  }
}

// ── Newest-wins playback queue ────────────────────────────────────

export interface QueueItem {
  play: (signal: AbortSignal) => Promise<void>;
}

export interface AudioQueue {
  /** Cancel active/pending work and retain only this newest item. */
  enqueue(item: QueueItem): void;
  /** Cancel active playback and discard all pending work. */
  cancel(): void;
  readonly size: number;
  readonly playing: boolean;
}

/**
 * Prevents overlapping playback while prioritizing the newest request. Every
 * enqueue aborts the active item and drops pending items. Queue item failures,
 * including aborts, are swallowed so they cannot wedge the queue.
 */
export function createAudioQueue(): AudioQueue {
  const queue: QueueItem[] = [];
  let activeController: AbortController | undefined;

  function drain(): void {
    if (activeController) return;
    const item = queue.shift();
    if (!item) return;

    const controller = new AbortController();
    activeController = controller;
    let playback: Promise<void>;
    try {
      playback = item.play(controller.signal);
    } catch (error) {
      playback = Promise.reject(error);
    }
    playback
      .catch(() => {})
      .finally(() => {
        if (activeController === controller) activeController = undefined;
        drain();
      });
  }

  function cancel(): void {
    queue.length = 0;
    activeController?.abort();
  }

  return {
    enqueue(item: QueueItem) {
      cancel();
      queue.push(item);
      drain();
    },
    cancel,
    get size() {
      return queue.length;
    },
    get playing() {
      return activeController !== undefined;
    },
  };
}
