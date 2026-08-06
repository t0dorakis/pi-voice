from __future__ import annotations

import hmac
import io
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np
from langdetect import DetectorFactory, LangDetectException, detect
from mlx_audio.tts.utils import load_model
from scipy.io import wavfile

VOICE_DIR = Path.home() / ".pi" / "voice"
CONFIG_PATH = VOICE_DIR / "config.json"
STATE_DIR = VOICE_DIR / "chatterbox"
TOKEN_PATH = STATE_DIR / "auth-token"
PID_PATH = STATE_DIR / "server.pid"
SUPPORTED_LANGUAGES = {
    "ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it",
    "ja", "ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh",
}
LANGUAGE_ALIASES = {"zh-cn": "zh", "zh-tw": "zh", "nb": "no"}
DetectorFactory.seed = 0


def load_config() -> dict:
    root = json.loads(CONFIG_PATH.read_text())
    config = root.get("chatterbox", {})
    return {
        "host": config.get("host", "127.0.0.1"),
        "port": int(config.get("port", 8182)),
        "model": config.get("model", "mlx-community/chatterbox-multilingual-v3"),
        "referenceAudio": config.get(
            "referenceAudio", str(VOICE_DIR / "references" / "default.wav")
        ),
        "language": config.get("language", "auto"),
        "fallbackLanguage": config.get("fallbackLanguage", "en"),
        "exaggeration": float(config.get("exaggeration", 0.1)),
        "idleTimeoutMinutes": float(config.get("idleTimeoutMinutes", 30)),
    }


CONFIG = load_config()
HOST = CONFIG["host"]
if HOST not in {"127.0.0.1", "localhost", "::1"}:
    raise ValueError("Chatterbox must bind to a loopback host.")
PORT = CONFIG["port"]
MODEL_ID = CONFIG["model"]
REFERENCE_AUDIO = str(Path(CONFIG["referenceAudio"]).expanduser())
DEFAULT_LANGUAGE = CONFIG["fallbackLanguage"]
EXAGGERATION = CONFIG["exaggeration"]
IDLE_TIMEOUT_SECONDS = CONFIG["idleTimeoutMinutes"] * 60
AUTH_TOKEN = TOKEN_PATH.read_text().strip()
if not AUTH_TOKEN:
    raise ValueError(f"Authentication token is empty: {TOKEN_PATH}")

if not Path(REFERENCE_AUDIO).is_file():
    raise FileNotFoundError(f"Reference audio not found: {REFERENCE_AUDIO}")

print(f"[chatterbox] Loading {MODEL_ID} ...", flush=True)
model = load_model(MODEL_ID)
print(f"[chatterbox] Preparing voice reference {REFERENCE_AUDIO} ...", flush=True)
conditionals = model.prepare_conditionals(REFERENCE_AUDIO, model.sample_rate, EXAGGERATION)
print("[chatterbox] Model and voice reference ready.", flush=True)

last_activity = time.monotonic()
synthesizing = False
state_lock = threading.Lock()


def touch(*, active: bool | None = None) -> None:
    global last_activity, synthesizing
    with state_lock:
        last_activity = time.monotonic()
        if active is not None:
            synthesizing = active


def detect_language(text: str) -> str:
    configured = CONFIG["language"]
    if configured != "auto":
        return configured
    detection_text = re.sub(r"```[\s\S]*?```|`[^`]*`|https?://\S+", " ", text)
    try:
        detected = detect(detection_text)
        language = LANGUAGE_ALIASES.get(detected, detected)
    except LangDetectException:
        return DEFAULT_LANGUAGE
    return language if language in SUPPORTED_LANGUAGES else DEFAULT_LANGUAGE


def chunk_text(text: str, limit: int = 600) -> list[str]:
    text = text.strip()
    if len(text) <= limit:
        return [text]
    chunks: list[str] = []
    remaining = text
    while len(remaining) > limit:
        window = remaining[: limit + 1]
        split_at = max(
            window.rfind(". "), window.rfind("! "), window.rfind("? "),
            window.rfind("\n"), window.rfind(" "),
        )
        split_at = limit if split_at < limit // 2 else split_at + 1
        chunks.append(remaining[:split_at].strip())
        remaining = remaining[split_at:].strip()
    if remaining:
        chunks.append(remaining)
    return chunks


def synthesize(text: str, language: str) -> tuple[int, np.ndarray]:
    segments: list[np.ndarray] = []
    sample_rate = int(model.sample_rate)
    silence = np.zeros(int(sample_rate * 0.12), dtype=np.float32)
    for index, chunk in enumerate(chunk_text(text)):
        result = next(
            model.generate(
                text=chunk,
                conds=conditionals,
                lang_code=language,
                exaggeration=EXAGGERATION,
                verbose=False,
            )
        )
        if index:
            segments.append(silence)
        segments.append(np.asarray(result.audio, dtype=np.float32).reshape(-1))
    audio = np.concatenate(segments)
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 1.0:
        audio = audio / peak
    return sample_rate, (audio * 32767).astype(np.int16)


class Handler(BaseHTTPRequestHandler):
    server_version = "PiVoiceChatterbox/1.0"

    def authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        return hmac.compare_digest(supplied, f"Bearer {AUTH_TOKEN}")

    def require_auth(self) -> bool:
        if self.authorized():
            return True
        self.send_json(401, {"error": "Unauthorized"})
        return False

    def log_message(self, format: str, *args: object) -> None:
        print(f"[chatterbox] {self.address_string()} {format % args}", flush=True)

    def send_json(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self) -> None:
        if not self.require_auth():
            return
        if self.path == "/health":
            touch()
            self.send_json(200, {
                "status": "ok", "backend": "chatterbox", "modelLoaded": True,
                "model": MODEL_ID, "synthesizing": synthesizing,
            })
            return
        self.send_json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if not self.require_auth():
            return
        if self.path == "/shutdown":
            self.send_json(200, {"status": "shutting down"})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if self.path != "/tts":
            self.send_json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 1_000_000:
                self.send_json(400, {"error": "Invalid request size"})
                return
            payload = json.loads(self.rfile.read(length))
            text = str(payload.get("text", "")).strip()
            if not text:
                self.send_json(400, {"error": "Missing or empty text"})
                return
            requested = payload.get("language", "auto")
            language = detect_language(text) if requested == "auto" else requested
            if language not in SUPPORTED_LANGUAGES:
                language = DEFAULT_LANGUAGE
            print(f"[chatterbox] Synthesizing {len(text)} chars in {language}", flush=True)
            touch(active=True)
            sample_rate, audio = synthesize(text, language)
            output = io.BytesIO()
            wavfile.write(output, sample_rate, audio)
            body = output.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-TTS-Language", language)
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                print("[chatterbox] Client disconnected; discarded stale audio.", flush=True)
        except Exception as error:
            print(f"[chatterbox] Synthesis error: {error}", flush=True)
            self.send_json(500, {"error": str(error)})
        finally:
            touch(active=False)


def monitor_idle(server: HTTPServer) -> None:
    if IDLE_TIMEOUT_SECONDS <= 0:
        return
    while True:
        time.sleep(min(30, max(1, IDLE_TIMEOUT_SECONDS / 4)))
        with state_lock:
            idle_for = time.monotonic() - last_activity
            active = synthesizing
        if not active and idle_for >= IDLE_TIMEOUT_SECONDS:
            print(f"[chatterbox] Idle for {idle_for:.0f}s; shutting down.", flush=True)
            server.shutdown()
            return


if __name__ == "__main__":
    # MLX streams are thread-local, so inference stays on the model-loading thread.
    server = HTTPServer((HOST, PORT), Handler)
    threading.Thread(target=monitor_idle, args=(server,), daemon=True).start()
    print(f"[chatterbox] Listening on http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        try:
            if PID_PATH.read_text().strip() == str(os.getpid()):
                PID_PATH.unlink()
        except (FileNotFoundError, OSError):
            pass
