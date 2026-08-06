import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const HERDR_MODEL = "gpt-5.6-luna";
export const ELIGIBLE_STATUSES = new Set(["idle", "done", "blocked"]);

export interface HerdrStatusEvent {
  paneId: string;
  status?: string;
  cancellation: boolean;
}

export interface PaneAgentSession {
  agent?: string;
  kind?: string;
  value?: string;
}

export interface HerdrPane {
  pane_id: string;
  workspace_id?: string;
  cwd?: string;
  focused: boolean;
  agent?: string;
  agent_status?: string;
  label?: string;
  title?: string;
  agent_session?: PaneAgentSession;
}

export interface HerdrWorkspace {
  workspace_id: string;
  label: string;
  pane_count: number;
}

export interface Announcement {
  announcement: string;
  title: string;
  rename: boolean;
}

export interface PaneTitleState {
  lastAutoTitle?: string;
  manualLocked?: boolean;
}

export interface RenameDecision {
  rename: boolean;
  state: PaneTitleState;
}

export interface PiTitleUpdate {
  sessionPath: string;
  title: string;
  previousAutoTitle?: string;
}

export function parseStatusEvent(raw: string | undefined): HerdrStatusEvent | null {
  if (!raw) return null;
  try {
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    const data =
      envelope.data && typeof envelope.data === "object"
        ? (envelope.data as Record<string, unknown>)
        : envelope;
    const paneId = data.pane_id;
    if (typeof paneId !== "string" || !paneId) return null;
    if (envelope.event === "pane.focused" || envelope.event === "pane.closed") {
      return { paneId, cancellation: true };
    }
    const status = data.agent_status;
    if (envelope.event !== "pane.agent_status_changed" || typeof status !== "string") return null;
    return { paneId, status, cancellation: status === "working" };
  } catch {
    return null;
  }
}

export function parsePaneResponse(raw: string): HerdrPane | null {
  try {
    const value = JSON.parse(raw) as { result?: { pane?: unknown } };
    const pane = value.result?.pane as Partial<HerdrPane> | undefined;
    if (!pane || typeof pane.pane_id !== "string" || typeof pane.focused !== "boolean") {
      return null;
    }
    for (const field of [
      pane.workspace_id,
      pane.cwd,
      pane.agent,
      pane.agent_status,
      pane.label,
      pane.title,
    ]) {
      if (field !== undefined && typeof field !== "string") return null;
    }
    return pane as HerdrPane;
  } catch {
    return null;
  }
}

export function parseWorkspaceResponse(raw: string): HerdrWorkspace | null {
  try {
    const value = JSON.parse(raw) as { result?: { workspace?: unknown } };
    const workspace = value.result?.workspace as Partial<HerdrWorkspace> | undefined;
    if (
      !workspace ||
      typeof workspace.workspace_id !== "string" ||
      typeof workspace.label !== "string" ||
      typeof workspace.pane_count !== "number"
    ) {
      return null;
    }
    return workspace as HerdrWorkspace;
  } catch {
    return null;
  }
}

export function isDefaultWorkspaceLabel(label: string, cwd: string | undefined): boolean {
  if (!cwd) return false;
  const normalized = cwd.replace(/\/+$/u, "");
  return label === normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function boundedRecentText(text: string, maxLines = 80, maxBytes = 12 * 1024): string {
  const lines = text.replaceAll("\0", "").split(/\r?\n/).slice(-maxLines);
  let value = lines.join("\n").trim();
  while (Buffer.byteLength(value, "utf8") > maxBytes && lines.length > 1) {
    lines.shift();
    value = lines.join("\n").trim();
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    const bytes = Buffer.from(value, "utf8");
    value = bytes
      .subarray(bytes.length - maxBytes)
      .toString("utf8")
      .replace(/^\uFFFD+/, "");
  }
  return value;
}

function words(value: string): string[] {
  return value.trim().split(/\s+/u).filter(Boolean);
}

function hasAsciiControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function parseAnnouncement(raw: string): Announcement | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value.announcement !== "string" ||
      typeof value.title !== "string" ||
      typeof value.rename !== "boolean"
    ) {
      return null;
    }
    const announcement = value.announcement.trim();
    const title = value.title.trim();
    if (words(announcement).length < 8 || words(announcement).length > 12) return null;
    if (words(title).length < 2 || words(title).length > 6) return null;
    if (
      announcement.length > 240 ||
      title.length > 100 ||
      hasAsciiControlCharacter(announcement + title)
    ) {
      return null;
    }
    return { announcement, title, rename: value.rename };
  } catch {
    return null;
  }
}

export function decidePaneRename(
  existingTitle: string | undefined,
  requestedTitle: string,
  modelRename: boolean,
  previous: PaneTitleState = {},
): RenameDecision {
  const existing = existingTitle?.trim() || undefined;
  const state = { ...previous };
  if (state.manualLocked) return { rename: false, state };
  if (existing && !state.lastAutoTitle) {
    return { rename: false, state: { ...state, manualLocked: true } };
  }
  if (existing && state.lastAutoTitle && existing !== state.lastAutoTitle) {
    return { rename: false, state: { ...state, manualLocked: true } };
  }
  const initial = !existing;
  if (!initial && !modelRename) return { rename: false, state };
  return {
    rename: true,
    state: { lastAutoTitle: requestedTitle, manualLocked: false },
  };
}

export function stablePathKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function atomicWriteJson(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = resolve(
    dirname(path),
    `.${stablePathKey(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(temporary, path);
}

export function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function piTitleUpdatePath(directory: string, sessionPath: string): string {
  return resolve(directory, `${stablePathKey(sessionPath)}.json`);
}
