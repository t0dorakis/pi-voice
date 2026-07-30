/**
 * Unit tests for extensions/text.ts — pure helpers, no pi runtime needed.
 *
 * Run with: node --import jiti/register extensions/text.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanTextForSpeech,
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

describe("cleanTextForSpeech", () => {
  it("drops fenced code blocks entirely", () => {
    assert.equal(cleanTextForSpeech("before ```\nconst x = 1;\n``` after"), "before after");
    assert.equal(cleanTextForSpeech("```js\ncode only\n```"), "");
  });

  it("keeps inline code text but drops the backticks", () => {
    assert.equal(cleanTextForSpeech("run `npm test` now"), "run npm test now");
  });

  it("speaks link labels and image alt text, not URLs", () => {
    assert.equal(cleanTextForSpeech("see [the docs](https://example.com)"), "see the docs");
    assert.equal(cleanTextForSpeech("![architecture diagram](https://x/img.png)"), "architecture diagram");
  });

  it("unwraps emphasis without eating snake_case or math", () => {
    assert.equal(cleanTextForSpeech("**bold** and *italic* and __strong__ and _em_"), "bold and italic and strong and em");
    assert.equal(cleanTextForSpeech("voice_idx and a_b_c stay"), "voice_idx and a_b_c stay");
    assert.equal(cleanTextForSpeech("~~deleted~~ kept"), "deleted kept");
  });

  it("strips structural markdown at line starts", () => {
    assert.equal(cleanTextForSpeech("## Title\n\nbody"), "Title\n\nbody");
    assert.equal(cleanTextForSpeech("> quoted words"), "quoted words");
    assert.equal(cleanTextForSpeech("- first\n- second"), "first\nsecond");
    assert.equal(cleanTextForSpeech("1. one\n2. two"), "one\ntwo");
  });

  it("collapses the whitespace it leaves behind", () => {
    assert.equal(cleanTextForSpeech("a  **b**   c"), "a b c");
  });

  it("passes plain prose through untouched", () => {
    assert.equal(
      cleanTextForSpeech("The quick brown fox (a fox!) jumps over 3.5 lazy dogs."),
      "The quick brown fox (a fox!) jumps over 3.5 lazy dogs.",
    );
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
