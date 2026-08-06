/**
 * pi-voice extension — /voice command and tts tool.
 *
 * TUI settings (via /voice):
 *   - TTS enabled/disabled (toggle)
 *   - Voice selector (fetched from server when model is loaded)
 *   - Speed selector (0.5 – 3.0)
 *
 * Persistence:
 *   - Global defaults: ~/.pi/voice/config.json
 *   - Session overrides: pi.appendEntry("voice-session", ...)
 *
 * Auto-TTS events:
 *   - Configured via events: Record<string, EventConfig> in ~/.pi/voice/config.json
 *   - EventConfig is one of:
 *     - { prompt: string, model?: { provider, id } } — summarize event context via LLM, then speak
 *     - { text: string } — speak the text directly (no LLM)
 *   - prompt and text are mutually exclusive
 *   - model is optional per-event; if omitted, inherits the active session model
 *   - Default: agent_end with last_message context
 *   - Any event name can be used; presence in config = enabled
 *   - Built-in pi events (agent_end, turn_end, message_end) use pi.on()
 *   - Custom events (e.g. ask:started) use the shared pi.events bus
 *   - Uses per-event model if configured, otherwise inherits the active session model
 *
 * Agent tool:
 *   - tts: converts text → WAV via the TTS server, plays it.
 *     Uses session overrides > global defaults.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createAudioQueue, playWav } from "./audio.ts";
import {
  type FullVoiceConfig,
  loadConfig,
  type ModelConfig,
  saveConfig,
  type VoiceSessionState,
} from "./config.ts";
import {
  cleanTextForSpeech,
  extractLastMessage,
  extractTextContent,
  normalizeExactSpeech,
  SPEED_VALUES,
  speedToIndex,
  voiceHint,
} from "./text.ts";

// ── Event Types (exported) ──────────────────────────────────────

export type VoiceSpeakSource = "tool" | "auto" | "sample";

export interface VoiceConfigEvent {
  enabled: boolean;
  voice: string;
  speed: number;
}

export interface VoiceSpeakStartEvent {
  text: string;
  voice: string;
  speed: number;
  source: VoiceSpeakSource;
}

export interface VoiceSpeakEndEvent {
  text: string;
  source: VoiceSpeakSource;
  error?: string;
}

export interface VoiceEventMap {
  "voice:config": VoiceConfigEvent;
  "voice:speak_start": VoiceSpeakStartEvent;
  "voice:speak_end": VoiceSpeakEndEvent;
}

// ── Event Processing ───────────────────────────────────────────────

// Shared model runtime for speech-text generation. Created lazily on first
// use and reused across calls (reads ~/.pi/agent/auth.json + models.json).
let runtimePromise: Promise<ModelRuntime> | undefined;
function getModelRuntime(): Promise<ModelRuntime> {
  runtimePromise ??= ModelRuntime.create();
  return runtimePromise;
}

async function generateSpeechText(
  prompt: string,
  context: string,
  model: NonNullable<ExtensionContext["model"]>,
): Promise<string | null> {
  try {
    const userMessage = context
      ? `The following is a message from a conversation that you need to summarize:\n\n""""\n${context}\n""""`
      : "Generate speech text.";

    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: resolve(homedir(), ".pi", "agent"),
      systemPromptOverride: () => prompt,
      // Side session only needs the model — skip user resources entirely.
      // In particular, never load extensions here (pi-voice itself would
      // register its own auto-TTS handlers in the side session).
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const { session } = await createAgentSession({
      model,
      tools: [],
      sessionManager: SessionManager.inMemory(),
      modelRuntime: await getModelRuntime(),
      resourceLoader: loader,
    });

    try {
      let responseText = "";

      const unsub = session.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          for (const part of event.message.content) {
            if (part.type === "text" && part.text) {
              responseText += part.text;
            }
          }
        }
      });

      await session.prompt(userMessage);
      unsub();

      return responseText || null;
    } finally {
      session.dispose();
    }
  } catch (error) {
    console.warn("[pi-voice] Error generating speech text:", error);
    return null;
  }
}

// ── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let defaults = loadConfig();
  let session: VoiceSessionState = {};
  let lifecycleId = 0;
  let finalAssistantText = "";
  let activeModel: ExtensionContext["model"];
  const configuredModels = new Map<string, NonNullable<ExtensionContext["model"]>>();

  function getEffective(): FullVoiceConfig {
    return {
      enabled: session.enabled ?? defaults.enabled,
      voice: session.voice ?? defaults.voice,
      speed: session.speed ?? defaults.speed,
      host: defaults.host,
      port: defaults.port,
      backend: defaults.backend,
      autoSpeak: defaults.autoSpeak,
      chatterbox: { ...defaults.chatterbox },
      events: defaults.events,
    };
  }

  function serverUrl(): string {
    return `http://${defaults.host}:${defaults.port}`;
  }

  function chatterboxUrl(config: FullVoiceConfig): string {
    return `http://${config.chatterbox.host}:${config.chatterbox.port}`;
  }

  function refreshModelSnapshot(ctx: ExtensionContext): void {
    activeModel = undefined;
    configuredModels.clear();
    if (defaults.autoSpeak === "exact") return;
    activeModel = ctx.model;
    for (const eventConfig of Object.values(defaults.events ?? {})) {
      if (!("prompt" in eventConfig) || !eventConfig.model) continue;
      const key = `${eventConfig.model.provider}/${eventConfig.model.id}`;
      const model = ctx.modelRegistry.find(eventConfig.model.provider, eventConfig.model.id);
      if (model) configuredModels.set(key, model);
    }
  }

  function resolveSpeechModel(modelConfig?: ModelConfig): ExtensionContext["model"] {
    if (!modelConfig) return activeModel;
    return configuredModels.get(`${modelConfig.provider}/${modelConfig.id}`);
  }

  function persistSession() {
    pi.appendEntry<VoiceSessionState>("voice-session", { ...session });
  }

  function restoreSession(ctx: ExtensionContext) {
    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === "voice-session") {
        const data = entry.data as VoiceSessionState | undefined;
        if (data) session = { ...data };
      }
    }
    defaults = loadConfig();
  }

  // ── Audio playback ────────────────────────────────────────────

  // Temp audio lives in the OS tmpdir, not the config dir — a crashed pi
  // must not accumulate stale voice-*.wav files in ~/.pi/voice.
  const TMP_AUDIO_DIR = join(tmpdir(), "pi-voice");
  let tmpSeq = 0;

  const audioQueue = createAudioQueue();
  let speechSequence = 0;
  let synthesisController: AbortController | undefined;
  let cancelEnqueuedSpeech: (() => void) | undefined;
  const CLI_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/pi-voice.mjs");
  const CHATTERBOX_TOKEN_PATH = resolve(homedir(), ".pi", "voice", "chatterbox", "auth-token");

  function chatterboxAuthHeader(): string {
    const token = readFileSync(CHATTERBOX_TOKEN_PATH, "utf8").trim();
    if (!token) throw new Error("Chatterbox authentication token is missing");
    return `Bearer ${token}`;
  }

  // ── Speak + Auto-TTS (closured over pi) ─────────────────────

  function cancelSpeech(): void {
    speechSequence++;
    synthesisController?.abort();
    synthesisController = undefined;
    cancelEnqueuedSpeech?.();
    cancelEnqueuedSpeech = undefined;
    audioQueue.cancel();
  }

  function isAbort(error: unknown, signal: AbortSignal): boolean {
    return signal.aborted || (error instanceof Error && error.name === "AbortError");
  }

  async function chatterboxHealth(config: FullVoiceConfig, signal: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch(`${chatterboxUrl(config)}/health`, {
        headers: { Authorization: chatterboxAuthHeader() },
        signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
      });
      return response.ok;
    } catch (error) {
      if (signal.aborted) throw error;
      return false;
    }
  }

  async function runChatterboxCommand(
    command: "start" | "restart",
    signal: AbortSignal,
  ): Promise<void> {
    const result = await pi.exec(CLI_BIN, ["chatterbox", command], {
      signal,
      timeout: 16 * 60 * 1000,
    });
    if (result.code !== 0) {
      throw new Error(
        `Chatterbox ${command} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
      );
    }
  }

  async function ensureChatterbox(config: FullVoiceConfig, signal: AbortSignal): Promise<void> {
    if (await chatterboxHealth(config, signal)) return;
    // A prior cancelled MLX request can leave the single-threaded backend busy
    // and unable to answer health checks. Restarting is safe for both first start
    // and recovery, and guarantees the newest response can proceed.
    await runChatterboxCommand("restart", signal);
    if (!(await chatterboxHealth(config, signal))) {
      throw new Error("Chatterbox did not become healthy after start");
    }
  }

  async function responseError(response: Response): Promise<Error> {
    try {
      const data = (await response.json()) as { error?: string };
      return new Error(data.error || `TTS request failed (${response.status})`);
    } catch {
      return new Error(`TTS request failed (${response.status})`);
    }
  }

  async function requestAudio(
    text: string,
    config: FullVoiceConfig,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const chatterbox = config.backend === "chatterbox";
    if (chatterbox) await ensureChatterbox(config, signal);

    const url = chatterbox
      ? `${chatterboxUrl(config)}/tts`
      : `http://${config.host}:${config.port}/tts`;
    const body = chatterbox
      ? { text, language: config.chatterbox.language }
      : { text, voice: config.voice, speed: config.speed };

    const synthesize = async (): Promise<Buffer> => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(chatterbox ? { Authorization: chatterboxAuthHeader() } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) throw await responseError(response);
      return Buffer.from(await response.arrayBuffer());
    };

    try {
      return await synthesize();
    } catch (error) {
      if (!chatterbox || isAbort(error, signal)) throw error;
      await runChatterboxCommand("restart", signal);
      return await synthesize();
    }
  }

  // Synthesis and playback are newest-wins. Starting speech cancels both an
  // older HTTP request and active audio; sequence checks prevent late bodies
  // from ever reaching the player even if a fetch implementation ignores abort.
  async function speak(
    text: string,
    config: FullVoiceConfig,
    source: VoiceSpeakSource,
  ): Promise<void> {
    cancelSpeech();
    const sequence = speechSequence;
    const lifecycle = lifecycleId;
    const controller = new AbortController();
    synthesisController = controller;
    let ended = false;

    const finish = (error?: unknown): void => {
      if (ended) return;
      ended = true;
      // Async synthesis/playback may settle after /reload or session replacement.
      // Never touch the stale extension API from the old lifecycle.
      if (lifecycle !== lifecycleId) return;
      const message = error instanceof Error ? error.message : error ? String(error) : undefined;
      pi.events.emit("voice:speak_end", {
        text,
        source,
        ...(message ? { error: message } : {}),
      } satisfies VoiceSpeakEndEvent);
    };

    pi.events.emit("voice:speak_start", {
      text,
      voice: config.voice,
      speed: config.speed,
      source,
    } satisfies VoiceSpeakStartEvent);

    let outPath: string | undefined;
    try {
      const wavBuffer = await requestAudio(text, config, controller.signal);
      if (controller.signal.aborted || sequence !== speechSequence || lifecycle !== lifecycleId) {
        throw new DOMException("Cancelled by newer speech request", "AbortError");
      }

      outPath = join(TMP_AUDIO_DIR, `voice-${process.pid}-${Date.now()}-${tmpSeq++}.wav`);
      mkdirSync(TMP_AUDIO_DIR, { recursive: true });
      writeFileSync(outPath, wavBuffer);
      const path = outPath;
      const cancelThisSpeech = () => {
        finish(new DOMException("Cancelled by newer speech request", "AbortError"));
        try {
          unlinkSync(path);
        } catch {
          /* active playback may still own the file */
        }
      };
      cancelEnqueuedSpeech = cancelThisSpeech;

      audioQueue.enqueue({
        play: async (playbackSignal) => {
          let playbackError: unknown;
          try {
            if (sequence !== speechSequence || lifecycle !== lifecycleId) {
              throw new DOMException("Cancelled by newer speech request", "AbortError");
            }
            await playWav(path, {
              speed: config.backend === "chatterbox" ? config.speed : 1,
              signal: playbackSignal,
            });
          } catch (error) {
            playbackError = error;
            if (!isAbort(error, playbackSignal)) {
              console.warn("[pi-voice] Playback error:", error);
            }
          } finally {
            if (cancelEnqueuedSpeech === cancelThisSpeech) cancelEnqueuedSpeech = undefined;
            finish(playbackError);
            try {
              unlinkSync(path);
            } catch {
              /* ignore */
            }
          }
        },
      });
      outPath = undefined;
    } catch (error) {
      if (!isAbort(error, controller.signal)) {
        console.warn(`[pi-voice] ${config.backend} TTS error:`, error);
      }
      finish(error);
    } finally {
      if (synthesisController === controller) synthesisController = undefined;
      if (outPath) {
        try {
          unlinkSync(outPath);
        } catch {
          /* ignore */
        }
      }
    }
  }

  async function handleAutoTTS(
    eventName: string,
    // biome-ignore lint/suspicious/noExplicitAny: event shape varies by event type
    event: any,
    config: FullVoiceConfig,
    model: ExtensionContext["model"],
  ): Promise<void> {
    const lifecycle = lifecycleId;
    try {
      if (!config.enabled || config.autoSpeak === "exact") return;
      if (!config.events?.[eventName]) return;

      const eventConfig = config.events[eventName];
      if ("text" in eventConfig) {
        await speak(eventConfig.text, config, "auto");
        return;
      }

      const context = extractLastMessage(event);
      if (!context || !model) {
        if (!model) console.warn("[pi-voice] No model available for speech generation.");
        return;
      }

      const text = await generateSpeechText(eventConfig.prompt, context, model);
      if (lifecycle !== lifecycleId) return;
      if (text) await speak(text, config, "auto");
    } catch (error) {
      console.warn("[pi-voice] Auto-TTS error:", error);
    }
  }

  // ── Server API helpers ─────────────────────────────────────────

  async function fetchHealth(config: FullVoiceConfig = getEffective()) {
    try {
      const baseUrl = config.backend === "chatterbox" ? chatterboxUrl(config) : serverUrl();
      const res = await fetch(`${baseUrl}/health`, {
        headers:
          config.backend === "chatterbox" ? { Authorization: chatterboxAuthHeader() } : undefined,
      });
      if (!res.ok) return null;
      return (await res.json()) as {
        status: string;
        activeDtype?: string | null;
        modelLoaded: boolean;
        loading?: boolean;
      };
    } catch {
      return null;
    }
  }

  async function fetchVoices(): Promise<string[]> {
    const res = await fetch(`${serverUrl()}/voices`);
    if (!res.ok) return [];
    const data = (await res.json()) as { voices: string[] };
    return data.voices;
  }

  // ── /voice command ─────────────────────────────────────────────

  pi.registerCommand("voice", {
    description: "Configure TTS voice and speed",
    handler: async (_args, ctx) => {
      const effective = getEffective();

      const health = await fetchHealth(effective);
      let voices: string[] = [];
      if (effective.backend === "kokoro" && health?.modelLoaded) {
        try {
          voices = await fetchVoices();
        } catch {
          voices = [];
        }
      }

      await ctx.ui.custom((_tui, theme, _kb, done) => {
        let enabled = effective.enabled;
        let voiceIdx = voices.length > 0 ? Math.max(0, voices.indexOf(effective.voice)) : -1;
        let speedIdx = speedToIndex(effective.speed);
        let selectedRow = 0;
        let playing = false;
        let playError: string | null = null;
        let feedback: string | null = null;

        const rowDefs: Array<{ id: string }> = [
          { id: "enabled" },
          ...(voices.length > 0 ? [{ id: "voice" }] : []),
          { id: "speed" },
        ];

        const sampleText = "The quick brown fox jumps over the lazy dog.";

        function emitConfig() {
          pi.events.emit("voice:config", {
            enabled,
            voice: voices.length > 0 ? voices[voiceIdx] : defaults.voice,
            speed: Number.parseFloat(SPEED_VALUES[speedIdx]),
          });
        }

        async function playSampleTts() {
          const voice = voices.length > 0 ? voices[voiceIdx] : defaults.voice;
          const speed = Number.parseFloat(SPEED_VALUES[speedIdx]);
          await speak(sampleText, { ...effective, voice, speed }, "sample");
        }

        return {
          render(_width: number) {
            const lines: string[] = [];

            // Title
            lines.push(theme.fg("accent", theme.bold("Voice")));

            // Server status
            const statusText = health
              ? health.modelLoaded
                ? effective.backend === "chatterbox"
                  ? "● Chatterbox running"
                  : `● Kokoro running (${health.activeDtype})`
                : health.loading
                  ? "◐ Server loading…"
                  : "○ Server up (no model)"
              : "✗ Server not detected";
            const statusColor = health?.modelLoaded
              ? "success"
              : health?.loading
                ? "warning"
                : health
                  ? "dim"
                  : "dim";
            lines.push(`  ${theme.fg(statusColor, statusText)}`);
            const serviceCommand =
              effective.backend === "chatterbox" ? "pi-voice chatterbox" : "pi-voice server";
            const serverHint = health?.modelLoaded
              ? theme.fg("dim", `  ${serviceCommand} stop to stop`)
              : theme.fg("dim", `  ${serviceCommand} start to start`);
            lines.push(serverHint);

            // Active events
            const activeEvents = effective.events ? Object.keys(effective.events) : [];
            if (activeEvents.length > 0) {
              lines.push(`  ${theme.fg("dim", `Events: ${activeEvents.join(", ")}`)}`);
            }

            // Setting rows
            for (let i = 0; i < rowDefs.length; i++) {
              const row = rowDefs[i];
              const selected = i === selectedRow;
              const cursor = selected ? "→" : " ";

              if (row.id === "enabled") {
                const val = enabled ? "on" : "off";
                const left = selected ? "◂ " : "  ";
                const right = selected ? " ▸" : "";
                lines.push(`${cursor} TTS    ${left}${val}${right}`);
              } else if (row.id === "voice") {
                const val = voices[voiceIdx] ?? "";
                const hint = voiceHint(val);
                const left = selected ? "◂ " : "  ";
                const right = selected ? " ▸" : "";
                lines.push(
                  `${cursor} Voice  ${left}${val}${right} ${theme.fg("dim", `(${hint})`)}`,
                );
              } else if (row.id === "speed") {
                const val = SPEED_VALUES[speedIdx];
                const left = selected ? "◂ " : "  ";
                const right = selected ? " ▸" : "";
                lines.push(`${cursor} Speed  ${left}${val}${right}`);
              }
            }

            lines.push("");

            if (playing) {
              lines.push(`  ${theme.fg("warning", "▶ Playing sample…")}`);
            } else if (playError) {
              lines.push(`  ${theme.fg("error", `✗ ${playError}`)}`);
            } else if (feedback) {
              lines.push(`  ${theme.fg("success", feedback)}`);
            }

            lines.push(
              theme.fg("dim", " ↑↓ navigate • ←→ change • s save default • r reset • esc close"),
            );

            return lines;
          },
          invalidate() {},
          handleInput(data: string) {
            if (matchesKey(data, "escape")) {
              persistSession();
              done(undefined);
              return;
            }

            if (playError) playError = null;
            if (feedback) feedback = null;

            if (playing) return;

            if (matchesKey(data, "s")) {
              const voice = voices.length > 0 ? voices[voiceIdx] : defaults.voice;
              const speed = Number.parseFloat(SPEED_VALUES[speedIdx]);
              defaults = { ...defaults, enabled, voice, speed };
              saveConfig(defaults);
              feedback = "✓ Saved as default";
              _tui.requestRender();
              return;
            }

            if (matchesKey(data, "r")) {
              // Discard session overrides and restore the saved ~/.pi/voice/config.json values
              session = {};
              defaults = loadConfig();
              persistSession();
              enabled = defaults.enabled;
              voiceIdx = voices.length > 0 ? Math.max(0, voices.indexOf(defaults.voice)) : -1;
              speedIdx = speedToIndex(defaults.speed);
              emitConfig();
              feedback = "✓ Reset to defaults";
              _tui.requestRender();
              return;
            }

            if (matchesKey(data, "up")) {
              selectedRow = (selectedRow - 1 + rowDefs.length) % rowDefs.length;
              _tui.requestRender();
              return;
            }
            if (matchesKey(data, "down")) {
              selectedRow = (selectedRow + 1) % rowDefs.length;
              _tui.requestRender();
              return;
            }

            const rowId = rowDefs[selectedRow]?.id;

            if (matchesKey(data, "left") || matchesKey(data, "right")) {
              const dir = matchesKey(data, "right") ? 1 : -1;
              if (rowId === "enabled") {
                enabled = !enabled;
                session.enabled = enabled;
              } else if (rowId === "voice" && voices.length > 0) {
                voiceIdx = (voiceIdx + dir + voices.length) % voices.length;
                session.voice = voices[voiceIdx];
              } else if (rowId === "speed") {
                speedIdx = (speedIdx + dir + SPEED_VALUES.length) % SPEED_VALUES.length;
                const speed = Number.parseFloat(SPEED_VALUES[speedIdx]);
                session.speed = speed;
              }
              persistSession();
              emitConfig();
              _tui.requestRender();
              return;
            }

            if (matchesKey(data, "enter")) {
              playing = true;
              playError = null;
              _tui.requestRender();
              playSampleTts()
                .then(() => {
                  playing = false;
                  _tui.requestRender();
                })
                .catch((err: unknown) => {
                  playing = false;
                  playError = err instanceof Error ? err.message : String(err);
                  _tui.requestRender();
                });
              return;
            }
          },
        };
      });
    },
  });

  // ── tts tool ─────────────────────────────────────────────────

  pi.registerTool({
    name: "tts",
    label: "Text to Speech",
    description:
      "Convert text to speech using the selected pi-voice backend, then play the generated WAV.",
    promptSnippet: "Convert text to speech and play audio",
    promptGuidelines: [
      "Use tts when the user wants to hear text spoken aloud or convert text to audio.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "Text to convert to speech" }),
      voice: Type.Optional(
        Type.String({ description: "Voice name (defaults to configured voice)" }),
      ),
      speed: Type.Optional(
        Type.Number({
          description: "Speech speed 0.5-3.0 (defaults to configured speed)",
          minimum: 0.5,
          maximum: 3.0,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const effective = getEffective();

      if (!effective.enabled) {
        return {
          content: [
            {
              type: "text" as const,
              text: "TTS is currently disabled. Use /voice to enable it.",
            },
          ],
          details: {},
        };
      }

      const voice = params.voice ?? effective.voice;
      const speed = params.speed ?? effective.speed;
      const speechText = cleanTextForSpeech(params.text);
      if (!speechText) {
        return {
          content: [{ type: "text" as const, text: "There is no speakable text." }],
          details: {},
        };
      }

      speak(speechText, { ...effective, voice, speed }, "tool").catch(() => {
        /* errors already logged inside speak */
      });

      const preview = speechText.length > 80 ? `${speechText.slice(0, 80)}…` : speechText;
      return {
        content: [{ type: "text" as const, text: `Speaking: "${preview}"` }],
        details: {},
      };
    },
  });

  // ── Status bar ────────────────────────────────────────────────

  function updateStatusBar(ctx: ExtensionContext) {
    const effective = getEffective();
    const theme = ctx.ui.theme;
    const icon = effective.enabled ? theme.fg("success", "\u266A") : theme.fg("dim", "\u266A");
    ctx.ui.setStatus("pi-voice", icon);
  }

  // ── Session lifecycle ──────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    cancelSpeech();
    lifecycleId++;
    finalAssistantText = "";
    restoreSession(ctx);
    refreshModelSnapshot(ctx);
    updateStatusBar(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    cancelSpeech();
    lifecycleId++;
    finalAssistantText = "";
    restoreSession(ctx);
    refreshModelSnapshot(ctx);
    updateStatusBar(ctx);
  });

  pi.on("session_shutdown", async () => {
    lifecycleId++;
    finalAssistantText = "";
    activeModel = undefined;
    configuredModels.clear();
    cancelSpeech();
    for (const unsubscribe of customUnsubs) unsubscribe();
    customUnsubs.length = 0;
  });

  pi.on("model_select", async (_event, ctx) => {
    refreshModelSnapshot(ctx);
  });

  // ── Global toggle shortcut (alt+v) ────────────────────────────

  pi.registerShortcut("alt+v", {
    description: "Toggle TTS on/off",
    handler: async (ctx) => {
      const effective = getEffective();
      const next = !effective.enabled;
      session.enabled = next;
      persistSession();
      ctx.ui.notify(`TTS ${next ? "enabled" : "disabled"}`, "info");
      pi.events.emit("voice:config", {
        enabled: next,
        voice: effective.voice,
        speed: effective.speed,
      });
      updateStatusBar(ctx);
    },
  });

  // ── Auto-TTS event handlers ─────────────────────────────────────

  // Built-in pi events that carry message data.
  // Each handler checks at runtime if the event is configured.
  // Note: pi.on() requires literal event names (not variables) for type safety.

  pi.on("agent_start", async () => {
    finalAssistantText = "";
    if (getEffective().autoSpeak === "exact") cancelSpeech();
  });

  pi.on("agent_end", async (event) => {
    const effective = getEffective();
    const eventConfig = effective.events?.agent_end;
    const model =
      eventConfig && "prompt" in eventConfig ? resolveSpeechModel(eventConfig.model) : activeModel;
    handleAutoTTS("agent_end", event, effective, model).catch((err) =>
      console.warn("[pi-voice] Auto-TTS error:", err),
    );
  });

  pi.on("turn_end", async (event) => {
    const effective = getEffective();
    const eventConfig = effective.events?.turn_end;
    const model =
      eventConfig && "prompt" in eventConfig ? resolveSpeechModel(eventConfig.model) : activeModel;
    handleAutoTTS("turn_end", event, effective, model).catch((err) =>
      console.warn("[pi-voice] Auto-TTS error:", err),
    );
  });

  pi.on("message_end", async (event) => {
    const effective = getEffective();
    if (event.message.role === "assistant") {
      finalAssistantText = extractTextContent(event.message.content);
    }
    const eventConfig = effective.events?.message_end;
    const model =
      eventConfig && "prompt" in eventConfig ? resolveSpeechModel(eventConfig.model) : activeModel;
    handleAutoTTS("message_end", event, effective, model).catch((err) =>
      console.warn("[pi-voice] Auto-TTS error:", err),
    );
  });

  pi.on("agent_settled", () => {
    const effective = getEffective();
    if (!effective.enabled || effective.autoSpeak !== "exact") return;
    const text = normalizeExactSpeech(finalAssistantText);
    if (text) {
      void speak(text, effective, "auto").catch((error) => {
        console.warn("[pi-voice] Exact auto-TTS error:", error);
      });
    }
  });

  const builtinEventNames = new Set(["agent_end", "agent_settled", "turn_end", "message_end"]);

  // Custom events from other extensions (via shared event bus).
  // Any event name in config that isn't a built-in pi event is treated
  // as a custom event. If the event config has a `text` field, it's
  // spoken directly without LLM summarization.

  const customUnsubs: Array<() => void> = [];

  function registerCustomEvents() {
    // Remove previous listeners
    for (const unsub of customUnsubs) unsub();
    customUnsubs.length = 0;

    const events = defaults.events;
    if (!events) return;

    for (const eventName of Object.keys(events)) {
      if (builtinEventNames.has(eventName)) continue;
      const unsub = pi.events.on(eventName, (data: unknown) => {
        const effective = getEffective();
        const eventConfig = effective.events?.[eventName];
        const model =
          eventConfig && "prompt" in eventConfig
            ? resolveSpeechModel(eventConfig.model)
            : activeModel;
        handleAutoTTS(eventName, data, effective, model).catch((err) =>
          console.warn("[pi-voice] Auto-TTS error:", err),
        );
      });
      customUnsubs.push(unsub);
    }
  }

  registerCustomEvents();
}
