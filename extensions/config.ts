/**
 * pi-voice configuration: types, schema, defaults, and persistence.
 *
 * Config lives at ~/.pi/voice/config.json (global defaults); session
 * overrides are stored by the extension via pi.appendEntry(). Only the
 * fs-backed load/save at the bottom touches the outside world, and both
 * take the config path as a parameter so tests can use a temp dir.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { Type } from "typebox";

// ── Types ──────────────────────────────────────────────────────────

export interface ModelConfig {
  provider: string;
  id: string;
}

export type EventConfig = SummarizeEventConfig | DirectEventConfig;

export interface SummarizeEventConfig {
  prompt: string;
  model?: ModelConfig;
}

export interface DirectEventConfig {
  text: string;
}

export type VoiceBackend = "kokoro" | "chatterbox";
export type AutoSpeakMode = "off" | "exact";

export interface ChatterboxConfig {
  host: string;
  port: number;
  model: string;
  referenceAudio: string;
  language: string;
  fallbackLanguage: string;
  exaggeration: number;
  idleTimeoutMinutes: number;
}

export interface FullVoiceConfig {
  enabled: boolean;
  voice: string;
  speed: number;
  host: string;
  port: number;
  backend: VoiceBackend;
  autoSpeak: AutoSpeakMode;
  chatterbox: ChatterboxConfig;
  events?: Record<string, EventConfig>;
}

export interface VoiceSessionState {
  enabled?: boolean;
  voice?: string;
  speed?: number;
}

// ── Configuration Schema (TypeBox) ───────────────────────────────

const ModelSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const SummarizeEventConfigSchema = Type.Object({
  prompt: Type.String({ minLength: 1 }),
  model: Type.Optional(ModelSchema),
});

const DirectEventConfigSchema = Type.Object({
  text: Type.String({ minLength: 1 }),
});

const EventConfigSchema = Type.Union([SummarizeEventConfigSchema, DirectEventConfigSchema]);

const _VoiceConfigSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean({ default: true })),
  voice: Type.Optional(Type.String({ default: "af_heart" })),
  speed: Type.Optional(Type.Number({ minimum: 0.5, maximum: 3.0, default: 1.0 })),
  host: Type.Optional(Type.String({ default: "127.0.0.1" })),
  port: Type.Optional(Type.Number({ minimum: 1, maximum: 65535, default: 8181 })),
  backend: Type.Optional(Type.String({ default: "kokoro" })),
  autoSpeak: Type.Optional(Type.String({ default: "off" })),
  chatterbox: Type.Optional(
    Type.Object({
      host: Type.Optional(Type.String({ default: "127.0.0.1" })),
      port: Type.Optional(Type.Number({ minimum: 1, maximum: 65535, default: 8182 })),
      model: Type.Optional(Type.String()),
      referenceAudio: Type.Optional(Type.String()),
      language: Type.Optional(Type.String({ default: "auto" })),
      fallbackLanguage: Type.Optional(Type.String({ default: "en" })),
      exaggeration: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0.1 })),
      idleTimeoutMinutes: Type.Optional(Type.Number({ minimum: 0, default: 30 })),
    }),
  ),
  events: Type.Optional(Type.Record(Type.String(), EventConfigSchema)),
});

// ── Defaults ───────────────────────────────────────────────────────

export const DEFAULT_SUMMARY_PROMPT =
  "You are preparing text for a text-to-speech system. " +
  "You will receive a message from a conversation enclosed in quadruple backticks. " +
  "Summarize it in one single very short sentence, two at most. " +
  "Use a dry, matter-of-fact tone. " +
  "Do not use any markdown formatting, just plain text. " +
  "Prefer words over symbols or abbreviations, as this will be read aloud. " +
  "Output only the sentence, nothing else.";

export const DEFAULT_CONFIG: FullVoiceConfig = {
  enabled: true,
  voice: "af_heart",
  speed: 1.0,
  host: "127.0.0.1",
  port: 8181,
  backend: "kokoro",
  autoSpeak: "off",
  chatterbox: {
    host: "127.0.0.1",
    port: 8182,
    model: "mlx-community/chatterbox-multilingual-v3",
    referenceAudio: "",
    language: "auto",
    fallbackLanguage: "en",
    exaggeration: 0.1,
    idleTimeoutMinutes: 30,
  },
  events: {
    agent_end: {
      prompt: DEFAULT_SUMMARY_PROMPT,
    },
  },
};

// ── Paths ──────────────────────────────────────────────────────────

export const CONFIG_DIR = resolve(homedir(), ".pi", "voice");
export const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");

// ── Persistence ────────────────────────────────────────────────────

export function loadConfig(configPath: string = CONFIG_PATH): FullVoiceConfig {
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      // Do NOT merge with DEFAULT_CONFIG — only what the user has written runs.
      // If events is missing from user config, no auto-TTS events fire.
      return {
        enabled: raw.enabled ?? DEFAULT_CONFIG.enabled,
        voice: raw.voice ?? DEFAULT_CONFIG.voice,
        speed: raw.speed ?? DEFAULT_CONFIG.speed,
        host: raw.host ?? DEFAULT_CONFIG.host,
        port: raw.port ?? DEFAULT_CONFIG.port,
        backend: raw.backend === "chatterbox" ? "chatterbox" : "kokoro",
        autoSpeak: raw.autoSpeak === "exact" ? "exact" : "off",
        chatterbox: {
          ...DEFAULT_CONFIG.chatterbox,
          ...(raw.chatterbox ?? {}),
        },
        events: raw.events,
      };
    }
  } catch {
    /* use defaults */
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: FullVoiceConfig, configPath: string = CONFIG_PATH) {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
