/**
 * Pure text helpers for pi-voice.
 *
 * No pi runtime, no fs, no network — strings in, strings out — so every
 * function here is unit-testable in isolation (see text.test.ts).
 */

export const SPEED_VALUES = [
  "0.5",
  "0.75",
  "1.0",
  "1.25",
  "1.5",
  "1.75",
  "2.0",
  "2.25",
  "2.5",
  "2.75",
  "3.0",
] as const;

export function speedToIndex(speed: number): number {
  const idx = SPEED_VALUES.findIndex((s) => Number.parseFloat(s) === speed);
  return idx >= 0 ? idx : 0;
}

/** Human-readable "(language gender)" hint for a Kokoro voice id like af_heart. */
export function voiceHint(name: string): string {
  const langMap: Record<string, string> = {
    a: "American",
    b: "British",
    j: "Japanese",
    z: "Mandarin",
    e: "Spanish",
    f: "French",
    h: "Hindi",
    i: "Italian",
    p: "Brazilian",
  };
  const genderMap: Record<string, string> = { f: "female", m: "male" };
  const lang = langMap[name[0]] ?? "";
  const gender = genderMap[name[1]] ?? "";
  if (lang && gender) return `${lang} ${gender}`;
  if (gender) return gender;
  return lang;
}

/**
 * Extract last_message text from event data.
 * Handles both single-message events (turn_end, message_end)
 * and multi-message events (agent_end).
 */
// biome-ignore lint/suspicious/noExplicitAny: event shape varies by event type
export function extractLastMessage(event: any): string {
  // agent_end has event.messages (array)
  if (event.messages && Array.isArray(event.messages) && event.messages.length > 0) {
    const lastMsg = event.messages[event.messages.length - 1];
    return extractTextContent(lastMsg?.content);
  }
  // turn_end, message_end have event.message
  return extractTextContent(event.message?.content);
}

// biome-ignore lint/suspicious/noExplicitAny: content items have varying shapes
export function extractTextContent(content: any[] | undefined): string {
  if (!content) return "";
  return (
    content
      // biome-ignore lint/suspicious/noExplicitAny: type guard filters unknown content items
      .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
  );
}

/**
 * Strip markdown syntax so the synthesizer speaks words, not symbols.
 * Fenced code blocks are dropped entirely (spoken code is noise); inline
 * code keeps its text; links/images keep their label/alt. Applied
 * server-side to every /tts request so all clients benefit.
 */
export function cleanTextForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks (dropped)
    .replace(/`([^`]+)`/g, "$1") // inline code keeps its text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images keep alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links keep their label
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // heading markers
    .replace(/^\s*>\s?/gm, "") // blockquote markers
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "") // list bullets / numbering
    .replace(/(^|[\s([{])\*\*\*([^*\n]+?)\*\*\*(?=$|[\s.,!?;:)}\]])/g, "$1$2")
    .replace(/(^|[\s([{])\*\*([^*\n]+?)\*\*(?=$|[\s.,!?;:)}\]])/g, "$1$2")
    .replace(/(^|[\s([{])\*([^*\n]+?)\*(?=$|[\s.,!?;:)}\]])/g, "$1$2")
    .replace(/(^|[\s([{])___([^_\n]+?)___(?=$|[\s.,!?;:)}\]])/g, "$1$2")
    .replace(/(^|[\s([{])__([^_\n]+?)__(?=$|[\s.,!?;:)}\]])/g, "$1$2")
    .replace(/(^|[\s([{])_([^_\n]+?)_(?=$|[\s.,!?;:)}\]])/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1") // strikethrough
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, "") // horizontal rules
    .replace(/[ \t]{2,}/g, " ") // collapse leftover spacing
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
