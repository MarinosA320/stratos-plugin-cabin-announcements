#!/usr/bin/env python3
"""
Generate every cabin-announcement clip for the plugin.

  python3 scripts/generate_audio.py [--voices DIR]

Reads scripts/announcements.json, synthesises each line with Piper TTS, runs
it through a "cabin PA" chain (band-limited speaker, light compression, a short
cabin reverb), and writes:

  assets/audio/<id>.<lang>.mp3      one file per announcement per language
  assets/audio/chime_pa.mp3         hi-lo passenger chime
  assets/audio/chime_crew.mp3       single crew-call chime
  src/shared/clips.generated.ts     durations + transcripts for the plugin

Want real recordings instead? Drop your own MP3 over assets/audio/<id>.<lang>.mp3
and run `python3 scripts/generate_audio.py --durations-only` so the plugin
knows the new lengths.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.io import wavfile

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts" / "announcements.json"
OUT_DIR = ROOT / "assets" / "audio"
GEN_TS = ROOT / "src" / "shared" / "clips.generated.ts"

SR = 22050

# Voice per (speaker, language). All voices are Piper models from
# github.com/rhasspy/piper/releases/tag/v0.0.2 — see README for licences.
VOICES = {
    ("purser", "en"): ("en-gb-southern_english_female-low", 1.06),
    ("captain", "en"): ("en-gb-alan-low", 1.04),
    ("purser", "el"): ("el-gr-rapunzelina-low", 1.05),
    ("captain", "el"): ("el-gr-rapunzelina-low", 1.12),
}


# ── audio helpers ────────────────────────────────────────────────────────────
def load_wav(path: Path) -> np.ndarray:
    sr, data = wavfile.read(path)
    x = data.astype(np.float32)
    if data.dtype == np.int16:
        x /= 32768.0
    if x.ndim > 1:
        x = x.mean(axis=1)
    if sr != SR:
        x = signal.resample_poly(x, SR, sr).astype(np.float32)
    return x


def tts(text: str, voice: str, length_scale: float, voices_dir: Path) -> np.ndarray:
    model = voices_dir / voice / f"{voice}.onnx"
    if not model.exists():
        sys.exit(f"Missing voice model: {model}")
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "out.wav"
        subprocess.run(
            [
                sys.executable, "-m", "piper",
                "-m", str(model),
                "-f", str(out),
                "--length-scale", str(length_scale),
                "--sentence-silence", "0.45",
            ],
            input=text.encode("utf-8"),
            check=True,
            capture_output=True,
        )
        return load_wav(out)


def cabin_pa(x: np.ndarray, seed: int) -> np.ndarray:
    """Make clean TTS sound like it is coming out of an aircraft PA speaker."""
    # 1. Small ceiling speaker: band-limit to ~250 Hz – 4.5 kHz with a presence bump.
    sos = signal.butter(2, [250, 4500], btype="bandpass", fs=SR, output="sos")
    y = signal.sosfilt(sos, x)
    b, a = signal.iirpeak(2200, 1.2, fs=SR)
    y = y + 0.35 * signal.lfilter(b, a, y)

    # 2. Gentle compression / saturation (PA amplifiers run hot).
    y = y / (np.max(np.abs(y)) + 1e-9)
    y = np.tanh(1.8 * y) / np.tanh(1.8)

    # 3. Short cabin reverb: a long metal tube full of seats — short and damped.
    rng = np.random.default_rng(seed)
    n = int(0.28 * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal(n) * np.exp(-t / 0.06)
    ir = signal.sosfilt(signal.butter(1, 3000, fs=SR, output="sos"), ir)
    ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
    wet = signal.fftconvolve(y, ir)[: len(y)]
    y = 0.86 * y + 0.14 * wet

    return y.astype(np.float32)


def bell(freq: float, dur: float, amp: float = 1.0) -> np.ndarray:
    """A soft two-partial chime tone (sounds like an airliner cabin chime)."""
    t = np.arange(int(dur * SR)) / SR
    env = np.exp(-t / (dur * 0.33)) * (1 - np.exp(-t / 0.004))
    tone = (
        np.sin(2 * np.pi * freq * t)
        + 0.22 * np.sin(2 * np.pi * freq * 2.0 * t) * np.exp(-t / 0.25)
        + 0.06 * np.sin(2 * np.pi * freq * 3.01 * t) * np.exp(-t / 0.12)
    )
    return (amp * env * tone).astype(np.float32)


def chime_pa() -> np.ndarray:
    hi = bell(784.0, 1.6)            # G5
    lo = bell(622.3, 2.0)            # D#5 – the classic hi-lo "ding-dong"
    gap = int(0.55 * SR)
    out = np.zeros(gap + len(lo), dtype=np.float32)
    out[: len(hi)] += hi
    out[gap:] += lo
    return out


def chime_crew() -> np.ndarray:
    return bell(880.0, 1.5)


def normalise(x: np.ndarray, target_rms_db: float = -19.0, peak_db: float = -1.0) -> np.ndarray:
    rms = np.sqrt(np.mean(x ** 2)) + 1e-9
    y = x * (10 ** (target_rms_db / 20) / rms)
    peak = np.max(np.abs(y)) + 1e-9
    lim = 10 ** (peak_db / 20)
    if peak > lim:
        y *= lim / peak
    return y.astype(np.float32)


def pad(x: np.ndarray, before: float = 0.15, after: float = 0.35) -> np.ndarray:
    return np.concatenate([
        np.zeros(int(before * SR), np.float32), x, np.zeros(int(after * SR), np.float32)
    ])


def write_mp3(x: np.ndarray, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        wav = Path(td) / "x.wav"
        wavfile.write(wav, SR, (np.clip(x, -1, 1) * 32767).astype(np.int16))
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav),
             "-ac", "1", "-ar", str(SR), "-codec:a", "libmp3lame", "-b:a", "64k", str(path)],
            check=True,
        )


def mp3_duration_ms(path: Path) -> int:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return int(round(float(out) * 1000))


def download_voices(voices_dir: Path) -> None:
    import io, tarfile, urllib.request
    base = "https://github.com/rhasspy/piper/releases/download/v0.0.2/voice-{}.tar.gz"
    for voice in sorted({v for v, _ in VOICES.values()}):
        if (voices_dir / voice / f"{voice}.onnx").exists():
            continue
        print(f"  ↓ downloading voice {voice}")
        data = urllib.request.urlopen(base.format(voice)).read()
        (voices_dir / voice).mkdir(parents=True, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(data)) as tf:
            tf.extractall(voices_dir / voice)


# ── main ─────────────────────────────────────────────────────────────────────
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--voices", default=str(ROOT / ".voices"),
                    help="Folder with Piper voices (downloaded automatically if missing)")
    ap.add_argument("--durations-only", action="store_true",
                    help="Don't synthesise; just re-measure existing MP3s and rewrite clips.generated.ts")
    ap.add_argument("--only", nargs="*", help="Only regenerate these announcement ids")
    args = ap.parse_args()
    voices_dir = Path(args.voices)
    if not args.durations_only:
        download_voices(voices_dir)

    spec = json.loads(SCRIPTS.read_text(encoding="utf-8"))["announcements"]

    if not args.durations_only:
        write_mp3(normalise(pad(chime_pa(), 0.05, 0.1), -20), OUT_DIR / "chime_pa.mp3")
        write_mp3(normalise(pad(chime_crew(), 0.05, 0.1), -20), OUT_DIR / "chime_crew.mp3")

        for i, a in enumerate(spec):
            if args.only and a["id"] not in args.only:
                continue
            for lang in ("el", "en"):
                if lang not in a:
                    continue
                voice, ls = VOICES[(a["speaker"], lang)]
                raw = tts(a[lang], voice, ls, voices_dir)
                clip = normalise(pad(cabin_pa(raw, seed=i)))
                path = OUT_DIR / f"{a['id']}.{lang}.mp3"
                write_mp3(clip, path)
                print(f"  ✓ {path.relative_to(ROOT)}  ({len(clip) / SR:.1f}s)")

    # Emit the TypeScript manifest the plugin reads at runtime.
    chimes = {
        "pa": {"file": "assets/audio/chime_pa.mp3", "durationMs": mp3_duration_ms(OUT_DIR / "chime_pa.mp3")},
        "crew": {"file": "assets/audio/chime_crew.mp3", "durationMs": mp3_duration_ms(OUT_DIR / "chime_crew.mp3")},
    }
    clips = {}
    for a in spec:
        entry = {"speaker": a["speaker"], "chime": a["chime"], "parts": {}}
        for lang in ("el", "en"):
            if lang in a:
                p = OUT_DIR / f"{a['id']}.{lang}.mp3"
                entry["parts"][lang] = {
                    "file": f"assets/audio/{a['id']}.{lang}.mp3",
                    "durationMs": mp3_duration_ms(p),
                    "text": a[lang],
                }
        clips[a["id"]] = entry

    GEN_TS.parent.mkdir(parents=True, exist_ok=True)
    GEN_TS.write_text(
        "// AUTO-GENERATED by scripts/generate_audio.py — do not edit by hand.\n"
        "// Edit scripts/announcements.json and re-run the generator instead.\n\n"
        "import type { ClipManifest } from \"./types\";\n\n"
        f"export const CHIMES = {json.dumps(chimes, ensure_ascii=False, indent=2)} as const;\n\n"
        f"export const CLIPS: ClipManifest = {json.dumps(clips, ensure_ascii=False, indent=2)};\n",
        encoding="utf-8",
    )
    total = sum(f.stat().st_size for f in OUT_DIR.glob("*.mp3"))
    print(f"\nWrote {GEN_TS.relative_to(ROOT)} · audio total {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
