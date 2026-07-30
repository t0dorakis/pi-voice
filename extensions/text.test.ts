/**
 * Unit tests for extensions/text.ts — pure helpers, no pi runtime needed.
 *
 * Run with: node --import jiti/register extensions/text.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractLastMessage,
  extractTextContent,
  SPEED_VALUES,
  speedToIndex,
  voiceHint,
} from "./text.ts";

describe("speedToIndex", () => {
  it("finds the exact speed in SPEED_VALUES", () => {
    assert.equal(speedToIndex(1.0), SPEED_VALUES.indexOf("1.0"));
    assert.equal(speedToIndex(0.5), 0);
    assert.equal(speedToIndex(3.0), SPEED_VALUES.length - 1);
  });

  it("returns 0 for unknown speeds (safe default)", () => {
    assert.equal(speedToIndex(0.9), 0);
    assert.equal(speedToIndex(99), 0);
    assert.equal(speedToIndex(Number.NaN), 0);
  });
});

describe("voiceHint", () => {
  it("maps language + gender prefixes", () => {
    assert.equal(voiceHint("af_heart"), "American female");
    assert.equal(voiceHint("am_adam"), "American male");
    assert.equal(voiceHint("bf_emma"), "British female");
    assert.equal(voiceHint("jf_alpha"), "Japanese female");
    assert.equal(voiceHint("zm_yunxi"), "Mandarin male");
    assert.equal(voiceHint("pf_dora"), "Brazilian female");
  });

  it("degrades gracefully for unknown prefixes", () => {
    assert.equal(voiceHint("xf_unknown"), "female");
    assert.equal(voiceHint("ax_weird"), "American");
    assert.equal(voiceHint("xx"), "");
    assert.equal(voiceHint(""), "");
  });
});

describe("extractTextContent", () => {
  it("joins text parts and drops non-text parts", () => {
    const content = [
      { type: "text", text: "first" },
      { type: "thinking", text: "hidden" },
      { type: "toolCall", id: "1" },
      { type: "text", text: "second" },
    ];
    assert.equal(extractTextContent(content), "first\nsecond");
  });

  it("returns empty string for missing/empty content", () => {
    assert.equal(extractTextContent(undefined), "");
    assert.equal(extractTextContent([]), "");
  });
});

describe("extractLastMessage", () => {
  it("reads agent_end-style events (messages array, last message)", () => {
    const event = {
      messages: [
        { role: "user", content: [{ type: "text", text: "question" }] },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
      ],
    };
    assert.equal(extractLastMessage(event), "answer");
  });

  it("reads turn_end/message_end-style events (single message)", () => {
    const event = {
      message: { role: "assistant", content: [{ type: "text", text: "turn text" }] },
    };
    assert.equal(extractLastMessage(event), "turn text");
  });

  it("returns empty string when there is nothing to say", () => {
    assert.equal(extractLastMessage({}), "");
    assert.equal(extractLastMessage({ messages: [] }), "");
    assert.equal(extractLastMessage({ message: { content: [] } }), "");
  });
});
