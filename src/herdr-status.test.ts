import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  boundedRecentText,
  decidePaneRename,
  parseAnnouncement,
  parseStatusEvent,
  stablePathKey,
} from "./herdr-status.ts";

describe("Herdr spoken status pure logic", () => {
  it("parses Herdr status envelopes and rejects malformed events", () => {
    assert.deepEqual(
      parseStatusEvent(
        JSON.stringify({
          event: "pane.agent_status_changed",
          data: { pane_id: "w1:p2", agent_status: "blocked" },
        }),
      ),
      { paneId: "w1:p2", status: "blocked", cancellation: false },
    );
    assert.equal(parseStatusEvent("not json"), null);
    assert.equal(parseStatusEvent(JSON.stringify({ data: { pane_id: "x" } })), null);
    assert.deepEqual(
      parseStatusEvent(JSON.stringify({ event: "pane.focused", data: { pane_id: "w1:p2" } })),
      { paneId: "w1:p2", cancellation: true },
    );
  });

  it("bounds recent pane text by lines and UTF-8 bytes", () => {
    const text = Array.from({ length: 100 }, (_, index) => `${index}:${"ä".repeat(300)}`).join(
      "\n",
    );
    const bounded = boundedRecentText(text);
    assert.ok(bounded.split("\n").length <= 80);
    assert.ok(Buffer.byteLength(bounded, "utf8") <= 12 * 1024);
    assert.match(bounded, /^8\d:|^9\d:/u);
  });

  it("requires strict announcement JSON and word lengths", () => {
    const valid = {
      announcement: "Der Agent hat alle Tests erfolgreich abgeschlossen und wartet jetzt.",
      title: "Alle Tests abgeschlossen",
      rename: true,
    };
    assert.deepEqual(parseAnnouncement(JSON.stringify(valid)), valid);
    assert.equal(parseAnnouncement(`prefix ${JSON.stringify(valid)}`), null);
    assert.equal(
      parseAnnouncement(JSON.stringify({ ...valid, announcement: "Viel zu kurz." })),
      null,
    );
  });

  it("never overwrites manual pane titles", () => {
    assert.deepEqual(decidePaneRename("Mein Titel", "Neuer Auto Titel", true), {
      rename: false,
      state: { manualLocked: true },
    });
    assert.equal(
      decidePaneRename("Manuell geändert", "Neuer Auto Titel", true, {
        lastAutoTitle: "Alter Auto Titel",
      }).state.manualLocked,
      true,
    );
    assert.equal(
      decidePaneRename("Alter Auto Titel", "Neuer Auto Titel", false, {
        lastAutoTitle: "Alter Auto Titel",
      }).rename,
      false,
    );
    assert.equal(decidePaneRename(undefined, "Erster Auto Titel", false).rename, true);
  });

  it("uses stable SHA-256 keys", () => {
    assert.equal(stablePathKey("same"), stablePathKey("same"));
    assert.notEqual(stablePathKey("same"), stablePathKey("other"));
    assert.equal(stablePathKey("same").length, 64);
  });
});
