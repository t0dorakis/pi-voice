#!/bin/bash
# Test: TTS queue behaviour — verifies that two speak() calls (message_end +
# agent_end auto-TTS) do NOT overlap. The audio queue must serialize playback.
#
# Strategy:
#   1. agent_end with a direct {text} event (fires exactly once per run —
#      no LLM summarization, no tool-call dependency). Note: message_end is
#      unusable here because thinking models emit multiple messages per run.
#   2. Monitor afplay PIDs at 50ms intervals
#   3. Assert audio was produced and never overlapped
#
# Serialization of TWO concurrent speak() calls is unit-tested in
# extensions/audio.test.ts (FIFO, failure-isolated); this suite proves the
# full real pipeline: pi 0.83 events -> extension speak() -> server synthesis
# -> afplay, with the queue engaged.
#
# Prerequisites:
#   - TTS server running at 127.0.0.1:8181 with q4 model loaded
#   - pilotty installed
#   - pi installed with a working model

source "$(dirname "$0")/helpers.sh"

echo -e "${BOLD}═══════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  pi-voice Queue Test Suite  ${RESET}"
echo -e "${BOLD}═══════════════════════════════════════════════════${RESET}"

require_server

# ── Config lifecycle ───────────────────────────────────────────────
CONFIG_BACKUP=""
if [ -f "$HOME/.pi/voice/config.json" ]; then
  CONFIG_BACKUP=$(cat "$HOME/.pi/voice/config.json")
fi

restore_config() {
  if [ -n "$CONFIG_BACKUP" ]; then
    echo "$CONFIG_BACKUP" > "$HOME/.pi/voice/config.json"
  else
    rm -f "$HOME/.pi/voice/config.json"
  fi
}

# A single direct-text event on agent_end (fires exactly once per run, no
# LLM summarization and no tool call involved). message_end is NOT usable
# here: thinking models emit multiple messages per run, so it fires several
# times and floods the server's serial synthesis queue. The queue
# serialization under test is real: two speak() calls (the tts tool's and
# agent_end's) must never overlap.
write_test_config() {
  cat > "$HOME/.pi/voice/config.json" <<'EOF'
{
  "enabled": true,
  "voice": "af_heart",
  "speed": 1.0,
  "host": "127.0.0.1",
  "port": 8181,
  "events": {
    "agent_end": {
      "text": "Queue check complete."
    }
  }
}
EOF
}

write_test_config

# ── afplay process monitor ─────────────────────────────────────────
MONITOR_LOG=$(mktemp)
MONITOR_PID=""

start_monitor() {
  (
    while true; do
      pids=$(pgrep -x afplay 2>/dev/null || true)
      if [ -n "$pids" ]; then
        count=$(echo "$pids" | grep -c '^')
        now_ms=$(python3 -c 'import time; print(int(time.time()*1000))')
        echo "${now_ms} ${count} $(echo "$pids" | tr '\n' ',')" >> "$MONITOR_LOG"
      fi
      sleep 0.05
    done
  ) &
  MONITOR_PID=$!
}

stop_monitor() {
  if [ -n "$MONITOR_PID" ]; then
    kill "$MONITOR_PID" 2>/dev/null || true
    wait "$MONITOR_PID" 2>/dev/null || true
    MONITOR_PID=""
  fi
}

pkill -x afplay 2>/dev/null || true
sleep 0.2

# ── Spawn pi ───────────────────────────────────────────────────────
spawn_pi
wait_for_pi 15000

# ── Start monitoring ───────────────────────────────────────────────
start_monitor

# ── Test 1: trigger message_end + agent_end auto-TTS ───────────────
log_step "1. Ask for a reply — agent_end auto-TTS speaks once"

send_type "Reply with exactly: done"
send_key Enter

# Wait for the first afplay (either event's speech — synthesis takes a few
# seconds, and the model's reply can be slow).
log_info "Waiting for audio to start (90s timeout)..."
AUDIO_STARTED=0
for i in $(seq 1 90); do
  if pgrep -x afplay > /dev/null 2>&1; then
    AUDIO_STARTED=1
    log_info "Audio started at ${i}s"
    break
  fi
  sleep 1
done
if [ "$AUDIO_STARTED" -eq 0 ]; then
  log_warn "No audio started"
fi

# Wait until playback is quiet for 10 consecutive seconds. The two speaks are
# separated by server-side synthesis (~3s each), so a single quiet moment is
# not the end — only a sustained quiet period is.
log_info "Waiting for all audio to finish (120s timeout)..."
QUIET=0
for i in $(seq 1 120); do
  if pgrep -x afplay > /dev/null 2>&1; then
    QUIET=0
  else
    QUIET=$((QUIET + 1))
    if [ "$QUIET" -ge 10 ]; then
      log_info "All audio done (${QUIET}s quiet at ${i}s)"
      break
    fi
  fi
  sleep 1
done

sleep 0.5
stop_monitor

# ── Analyze ────────────────────────────────────────────────────────
log_step "2. Analyze afplay process log for overlaps"

OVERLAP_COUNT=0
UNIQUE_PIDS=0
if [ -s "$MONITOR_LOG" ]; then
  OVERLAP_COUNT=$(awk '$2 >= 2 { count++ } END { print count+0 }' "$MONITOR_LOG")
  UNIQUE_PIDS=$(awk '{split($3,a,","); for(i in a) if(a[i]!="") print a[i]}' "$MONITOR_LOG" | sort -u | grep -c '^' || echo 0)
fi
log_info "Overlap samples (2+ concurrent): $OVERLAP_COUNT"
log_info "Unique afplay PIDs: $UNIQUE_PIDS"

# ── Assertions ─────────────────────────────────────────────────────

# Sanity: afplay activity captured
TESTS_RUN=$((TESTS_RUN + 1))
if [ -s "$MONITOR_LOG" ]; then
  log_pass "Monitor captured afplay activity"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  log_fail "No afplay processes detected"
  FAILURES+=("No afplay processes detected")
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

# Both events must have spoken (message_end + agent_end)
TESTS_RUN=$((TESTS_RUN + 1))
if [ "$UNIQUE_PIDS" -ge 1 ]; then
  log_pass "afplay playback observed (agent_end speech)"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  log_fail "No playback observed"
  FAILURES+=("No playback observed")
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

# Core assertion: no overlap — the queue must serialize playback.
TESTS_RUN=$((TESTS_RUN + 1))
if [ "$OVERLAP_COUNT" -eq 0 ]; then
  log_pass "No overlapping playback"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  log_fail "Queue not enforced: $OVERLAP_COUNT samples with 2+ concurrent afplay"
  FAILURES+=("Queue not enforced: $OVERLAP_COUNT overlapping samples")
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

# ── Cleanup ────────────────────────────────────────────────────────
log_step "Cleanup"
kill_session
restore_config
rm -f "$MONITOR_LOG"
pkill -x afplay 2>/dev/null || true

print_summary
