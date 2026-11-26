"""Stem Remixer: render a fit plan for a score, exactly as the app plays it.

    fit.py <score> <plan.json> <out.wav>

The plan is {"steps": [{"from_s", "to_s", "tempo", "xfade_s"}, ...]}: spans of
the score in seconds, each at its own tempo, crossfading for xfade_s seconds
into the next. Identical steps share one saved section; the chain is the
steps in order. The score is the one stem ("score") of a Mixer, the chain is
rendered with render_chain (what Play chain plays), resampled to 48 kHz if
need be and written as a float WAV.

Prints JSON lines: {"progress": 0..1, "text": ...} while it works, then
{"done": true, "out", "length_s"} (plus "turned_down": factor if the mix was
turned down to avoid clipping), or {"error": ...} with a non-zero exit.
"""

import json
import math
import os
import sys

import numpy as np

from mixer import MAX_TEMPO, MIN_LOOP_SECONDS, MIN_TEMPO, Mixer, Stem

OUT_RATE = 48000


def _number(step: dict, key: str, number: int, default=None) -> float:
    value = step.get(key, default)
    if value is None:
        raise ValueError(f"Step {number} has no {key}.")
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"Step {number} has a {key} that is not a number.") from None
    if not math.isfinite(value):
        raise ValueError(f"Step {number} has a {key} that is not a number.")
    return value


def plan_to_sections(plan, rate: int, length=None) -> tuple:
    """(sections, chain) for Mixer.sections and Mixer.set_chain from a fit
    plan. Times become frames at `rate`. Steps with the same span, tempo and
    crossfade share a section. With `length` (the score's frames), spans are
    kept inside the score. Raises ValueError, naming the step, on a bad plan."""
    steps = plan.get("steps") if isinstance(plan, dict) else None
    if not isinstance(steps, list) or not steps:
        raise ValueError("The plan has no steps.")
    sections, chain, seen = [], [], {}
    for number, step in enumerate(steps, 1):
        if not isinstance(step, dict):
            raise ValueError(f"Step {number} is not a step.")
        first = _number(step, "from_s", number)
        last = _number(step, "to_s", number)
        tempo = _number(step, "tempo", number, 1.0)
        xfade = _number(step, "xfade_s", number, 0.0)
        if first < 0 or last - first < MIN_LOOP_SECONDS:
            raise ValueError(f"Step {number} must run forwards for at least {MIN_LOOP_SECONDS} s.")
        if not MIN_TEMPO <= tempo <= MAX_TEMPO:
            raise ValueError(f"Step {number} has a tempo outside {MIN_TEMPO} to {MAX_TEMPO}.")
        if xfade < 0:
            raise ValueError(f"Step {number} has a negative crossfade.")
        start, end = int(round(first * rate)), int(round(last * rate))
        if length is not None:
            end = min(end, int(length) - 1)
            if end - start < MIN_LOOP_SECONDS * rate:
                raise ValueError(f"Step {number} starts after the score ends.")
        key = (start, end, tempo, xfade)
        if key not in seen:
            seen[key] = len(sections)
            sections.append({"name": f"Fit {len(sections) + 1}", "start": start, "end": end,
                             "tempo": tempo, "xfade": xfade})
        chain.append(seen[key])
    return sections, chain


def build_mixer(x, rate: int, plan) -> Mixer:
    """A Mixer with the score as its one stem and the plan as its chain."""
    mixer = Mixer([Stem("score", x)], rate)
    mixer.sections, chain = plan_to_sections(plan, rate, length=mixer.length)
    mixer.set_chain(chain)
    return mixer


def resample(audio: np.ndarray, rate: int, out_rate: int) -> np.ndarray:
    """Band-limited resample (FFT), (n, channels) float32. The result has
    round(n * out_rate / rate) frames."""
    audio = np.asarray(audio, dtype=np.float32)
    if rate == out_rate or len(audio) == 0:
        return audio
    wanted = int(round(len(audio) * out_rate / rate))
    g = math.gcd(int(rate), int(out_rate))
    up, down = out_rate // g, rate // g
    # Pad with silence so the ends don't wrap round into each other, to a
    # length that maps to a whole number of output frames.
    padded = int(np.ceil((len(audio) + rate // 10) / down)) * down
    size = padded * up // down
    out = np.empty((wanted, audio.shape[1]), dtype=np.float32)
    keep = min(padded, size) // 2 + 1
    for channel in range(audio.shape[1]):
        spectrum = np.fft.rfft(audio[:, channel], padded)
        resized = np.zeros(size // 2 + 1, dtype=np.complex128)
        resized[:keep] = spectrum[:keep]
        if size < padded and size % 2 == 0:
            resized[-1] = resized[-1].real   # the new Nyquist bin
        out[:, channel] = (np.fft.irfft(resized, size) * (size / padded))[:wanted]
    return out


def render_plan(x, rate: int, plan, out_rate: int = OUT_RATE) -> tuple:
    """(audio at out_rate, turned_down_by) for the plan over score x."""
    audio, factor = build_mixer(x, rate, plan).render_chain()
    return resample(audio, int(rate), int(out_rate)), factor


def _emit(obj) -> None:
    print(json.dumps(obj), flush=True)


def main(argv) -> int:
    if len(argv) != 3:
        _emit({"error": "Usage: fit.py <score> <plan.json> <out.wav>"})
        return 2
    score, plan_path, out = argv
    temp = f"{out}.tmp-{os.getpid()}.wav"
    try:
        import soundfile as sf
        _emit({"progress": 0.0, "text": "Reading the plan"})
        with open(plan_path, encoding="utf-8") as handle:
            plan = json.load(handle)
        _emit({"progress": 0.1, "text": "Loading the score"})
        x, rate = sf.read(score, dtype="float32", always_2d=True)
        _emit({"progress": 0.3, "text": "Rendering the fit"})
        mixer = build_mixer(x, rate, plan)
        audio, factor = mixer.render_chain()
        if rate != OUT_RATE:
            _emit({"progress": 0.7, "text": "Resampling to 48 kHz"})
            audio = resample(audio, rate, OUT_RATE)
        _emit({"progress": 0.9, "text": "Writing the fit"})
        sf.write(temp, audio, OUT_RATE, format="WAV", subtype="FLOAT")
        os.replace(temp, out)
    except Exception as exc:   # report anything as JSON, for the caller
        if os.path.exists(temp):
            os.remove(temp)
        _emit({"error": f"Could not fit the score: {exc}"})
        return 1
    done = {"done": True, "out": out, "length_s": round(len(audio) / OUT_RATE, 4)}
    if factor < 1.0:
        done["turned_down"] = factor
    _emit(done)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
