/**
 * Audio playback for pi-voice: player detection, WAV playback, and a
 * serial playback queue (tts tool / auto-TTS / samples never overlap).
 *
 * Player selection and the queue are injectable/pure enough to unit-test
 * without touching audio hardware (see audio.test.ts).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

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

// execFile (no shell) — no quoting bugs, no injection surface.
export function playWav(outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(getAudioPlayer(), [outPath], { timeout: AUDIO_PLAYBACK_TIMEOUT_MS }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

// ── Serial playback queue ──────────────────────────────────────────

export interface QueueItem {
  play: () => Promise<void>;
}

export interface AudioQueue {
  enqueue(item: QueueItem): void;
  readonly size: number;
  readonly playing: boolean;
}

/**
 * Serializes audio playback so concurrent speech never overlaps.
 * A failing item is swallowed (errors are reported by the item itself)
 * and never blocks the rest of the queue.
 */
export function createAudioQueue(): AudioQueue {
  const queue: QueueItem[] = [];
  let playing = false;

  function drain(): void {
    if (playing) return;
    const item = queue.shift();
    if (!item) return;
    playing = true;
    item
      .play()
      .catch(() => {})
      .finally(() => {
        playing = false;
        drain();
      });
  }

  return {
    enqueue(item: QueueItem) {
      queue.push(item);
      drain();
    },
    get size() {
      return queue.length;
    },
    get playing() {
      return playing;
    },
  };
}
