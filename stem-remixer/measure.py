"""Stem Remixer: measure a score, so a fit can be planned around it.

    measure.py <audio>

Prints JSON lines: {"progress": 0..1, "text": ...} while it works, then
{"done": true, "duration_s", "loud", "beats", "bpm", "moves"}, or
{"error": ...} with a non-zero exit.

- loud: the loudness in dBFS (RMS) every 0.1 s, smoothed over 1.5 s.
- beats: beat times in seconds, and bpm, from an onset envelope (spectral
  flux) and its autocorrelation. A score with no clear beat gives no beats
  and a bpm of null.
- moves: {"t", "kind", "db"}. A rise or drop is a change of 6 dB or more in
  the smoothed loudness that holds for 2 s; the fade is where the final
  decline to silence starts.

Pure NumPy; analyse(x, rate) does the work and can be tested on its own.
"""

import json
import sys

import numpy as np

STEP_S = 0.1           # loudness resolution
SMOOTH_S = 1.5         # loudness moving average
FLOOR_DB = -90.0
MOVE_DB = 6.0          # a rise or drop is at least this
HOLD_S = 2.0           # and holds this long
FADE_MIN_S = 2.0       # a decline shorter than this is an ending, not a fade
FADE_DEPTH_DB = 20.0   # a fade goes at least this far down
MIN_BPM, MAX_BPM = 60.0, 180.0
ONSET_HOP_S = 0.01
MIN_ONSET_DB = 0.5     # the strongest onsets must lift the spectrum this much (dB, per bin)
MIN_PERIODICITY = 0.2  # normalised autocorrelation at the beat period
TIGHTNESS = 100.0      # how strictly beats keep to the period


def _mono(x) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 2:
        x = x.mean(axis=1) if x.shape[1] else np.zeros(len(x))
    return np.nan_to_num(x)


def _moving_average(values: np.ndarray, width: int) -> np.ndarray:
    """Centred moving average; near the ends, of what there is."""
    if len(values) == 0 or width <= 1:
        return values.copy()
    kernel = np.ones(width)
    total = np.convolve(values, kernel, mode="same")
    count = np.convolve(np.ones(len(values)), kernel, mode="same")
    return total / count


# --------------------------------------------------------------- loudness

def loudness(mono: np.ndarray, rate: int) -> np.ndarray:
    """RMS dBFS every 0.1 s, smoothed over 1.5 s."""
    step = max(1, int(round(rate * STEP_S)))
    count = int(np.ceil(len(mono) / step))
    if count == 0:
        return np.zeros(0)
    padded = np.zeros(count * step)
    padded[:len(mono)] = mono
    blocks = padded.reshape(count, step)
    used = np.full(count, step)
    used[-1] = len(mono) - (count - 1) * step
    rms = np.sqrt((blocks ** 2).sum(axis=1) / used)
    db = np.maximum(FLOOR_DB, 20 * np.log10(np.maximum(rms, 1e-12)))
    return _moving_average(db, int(round(SMOOTH_S / STEP_S)))


def _fade(loud: np.ndarray):
    """Index where the final decline to silence starts, or None."""
    if len(loud) == 0:
        return None
    top = loud.max()
    if top <= FLOOR_DB + 1 or loud[-1] > top - FADE_DEPTH_DB:
        return None   # silent throughout, or it doesn't end quiet
    sounding = np.nonzero(loud > max(FLOOR_DB + 1, top - 60))[0]
    j = int(sounding[-1])
    look = int(round(1.0 / STEP_S))
    # Walk back while the level a second earlier was still clearly higher.
    while j - look >= 0 and loud[j - look] > loud[j] + 1.0:
        j -= 1
    if (len(loud) - j) * STEP_S < FADE_MIN_S or loud[j] - loud[-1] < FADE_DEPTH_DB:
        return None
    return j


def moves(loud: np.ndarray) -> list:
    """Rises, drops and the fade in a smoothed loudness curve."""
    found = []
    hold = int(round(HOLD_S / STEP_S))
    settle = int(round(SMOOTH_S / STEP_S))
    fade = _fade(loud)
    candidates = []
    for i in range(hold, len(loud) - settle - hold + 1):
        before = loud[i - hold:i]
        after = loud[i + settle:i + settle + hold]
        base = np.median(before)
        if after.min() - base >= MOVE_DB:
            kind = "rise"
        elif base - after.max() >= MOVE_DB:
            kind = "drop"
        else:
            continue
        candidates.append((i, kind, after.mean() - before.mean()))
    # Each run of neighbouring candidates of one kind is one move, placed
    # where the change across the gap is biggest.
    runs = []
    for i, kind, change in candidates:
        if runs and runs[-1][-1][1] == kind and i - runs[-1][-1][0] <= 1:
            runs[-1].append((i, kind, change))
        else:
            runs.append([(i, kind, change)])
    for run in runs:
        i, kind, change = max(run, key=lambda c: abs(c[2]))
        t = (i + settle / 2) * STEP_S
        if kind == "drop" and fade is not None and t >= fade * STEP_S - HOLD_S:
            continue   # that's the fade
        found.append({"t": round(t, 2), "kind": kind, "db": round(float(change), 1)})
    if fade is not None:
        found.append({"t": round(fade * STEP_S, 2), "kind": "fade",
                      "db": round(float(loud[-1] - loud[fade]), 1)})
    return sorted(found, key=lambda m: m["t"])


# ------------------------------------------------------------------ beats

def onset_envelope(mono: np.ndarray, rate: int) -> tuple:
    """Positive spectral flux in dB, averaged over the bins, every ~10 ms.
    Returns (envelope, hop in samples, window in samples)."""
    hop = max(1, int(round(rate * ONSET_HOP_S)))
    n_fft = 1 << int(np.ceil(np.log2(max(2, rate * 0.023))))
    if len(mono) < n_fft + hop:
        return np.zeros(0), hop, n_fft
    frames = 1 + (len(mono) - n_fft) // hop
    window = np.hanning(n_fft)
    mags = []
    for first in range(0, frames, 2048):   # in blocks, to keep memory down
        idx = (np.arange(first, min(frames, first + 2048)) * hop)[:, None] + np.arange(n_fft)
        mags.append(np.abs(np.fft.rfft(mono[idx] * window, axis=1)))
    mag = np.concatenate(mags)
    top = mag.max()
    if top <= 1e-9:
        return np.zeros(frames), hop, n_fft
    db = 20 * np.log10(np.maximum(mag, top * 1e-4))   # an 80 dB range
    flux = np.maximum(0.0, np.diff(db, axis=0)).mean(axis=1)
    return np.concatenate([[0.0], flux]), hop, n_fft


def _period(env: np.ndarray, hop_s: float):
    """The beat period in frames (fractional), or None if there's no clear one."""
    short, long_ = 60.0 / MAX_BPM / hop_s, 60.0 / MIN_BPM / hop_s
    if len(env) < 2 * long_ + 2:
        return None
    centred = env - env.mean()
    size = 1 << int(np.ceil(np.log2(2 * len(env))))
    spectrum = np.fft.rfft(centred, size)
    ac = np.fft.irfft(spectrum * np.conj(spectrum), size)[:len(env)]
    if ac[0] <= 0:
        return None
    ac = ac / ac[0]
    lags = np.arange(int(np.floor(short)), int(np.ceil(long_)) + 1)
    lags = lags[(lags >= 1) & (lags < len(ac) - 1)]
    bpm = 60.0 / (lags * hop_s)
    prior = np.exp(-0.5 * np.log2(bpm / 120.0) ** 2)   # mildly prefer moderate tempos
    best = int(lags[np.argmax(ac[lags] * prior)])
    if ac[best] < MIN_PERIODICITY:
        return None
    a, b, c = ac[best - 1], ac[best], ac[best + 1]
    bend = a - 2 * b + c
    shift = 0.5 * (a - c) / bend if bend < 0 else 0.0
    return best + float(np.clip(shift, -0.5, 0.5))


def _track(env: np.ndarray, period: float) -> np.ndarray:
    """Beat frames by dynamic programming: onsets that keep to the period."""
    n = len(env)
    norm = env / (env.std() or 1.0)
    score = norm.copy()
    back = np.full(n, -1)
    low, high = int(round(period / 2)), int(round(period * 2))
    for t in range(low, n):
        first = max(0, t - high)
        prev = np.arange(first, t - low + 1)
        if len(prev) == 0:
            continue
        penalty = -TIGHTNESS * np.log((t - prev) / period) ** 2
        candidate = score[prev] + penalty
        k = int(np.argmax(candidate))
        if candidate[k] > 0:
            score[t] = norm[t] + candidate[k]
            back[t] = prev[k]
    # Finish on the best-scoring onset in the last period.
    tail = np.arange(max(0, n - int(round(period))), n)
    t = int(tail[np.argmax(score[tail])])
    beats = []
    while t >= 0:
        beats.append(t)
        t = back[t]
    beats = np.array(beats[::-1])
    # Drop weak beats at the ends (silence before the first onset or after the last).
    strong = norm[beats] > 0.5 * np.median(norm[beats]) if len(beats) else beats
    if len(beats) and strong.any():
        keep = np.nonzero(strong)[0]
        beats = beats[keep[0]:keep[-1] + 1]
    return beats


def _refine(mono: np.ndarray, rate: int, times: np.ndarray, reach_s: float) -> np.ndarray:
    """Move each beat to the sharpest rise in a 2 ms energy envelope nearby."""
    step = max(1, int(round(rate * 0.002)))
    count = len(mono) // step
    if count < 4:
        return times
    energy = (mono[:count * step].reshape(count, step) ** 2).mean(axis=1)
    db = 10 * np.log10(np.maximum(energy, 1e-10))
    rise = np.concatenate([[0.0], np.diff(db)])
    reach = int(round(reach_s * rate / step))
    out = []
    for t in times:
        centre = int(round(t * rate / step))
        lo, hi = max(1, centre - reach), min(count, centre + reach + 1)
        if hi <= lo:
            out.append(t)
            continue
        out.append((lo + int(np.argmax(rise[lo:hi]))) * step / rate)
    return np.array(out)


def beats(mono: np.ndarray, rate: int) -> tuple:
    """(beat times in seconds, bpm), or ([], None) with no clear beat."""
    env, hop, n_fft = onset_envelope(mono, rate)
    if len(env) == 0 or np.percentile(env, 99) < MIN_ONSET_DB:
        return [], None
    hop_s = hop / rate
    detrended = np.maximum(0.0, env - _moving_average(env, int(round(0.5 / hop_s))))
    period = _period(detrended, hop_s)
    if period is None:
        return [], None
    frames = _track(detrended, period)
    if len(frames) < 4:
        return [], None
    # A frame's window is centred half a window after its first sample.
    times = (frames * hop + n_fft / 2) / rate
    times = np.unique(np.round(_refine(mono, rate, times, n_fft / rate), 3))
    gaps = np.diff(times)
    gaps = gaps[(gaps > 0.75 * period * hop_s) & (gaps < 1.25 * period * hop_s)]
    bpm = 60.0 / float(np.median(gaps)) if len(gaps) else 60.0 / (period * hop_s)
    return [float(t) for t in times], round(bpm, 2)


# ---------------------------------------------------------------- analyse

def analyse(x, rate: int, progress=None) -> dict:
    """Everything measure.py reports, for audio x ((n,) or (n, channels))."""
    say = progress or (lambda fraction, text: None)
    mono = _mono(x)
    rate = int(rate)
    say(0.1, "Measuring loudness")
    loud = loudness(mono, rate)
    say(0.3, "Finding the beat")
    beat_times, bpm = beats(mono, rate)
    say(0.9, "Finding the big moves")
    return {"duration_s": round(len(mono) / rate, 3) if rate else 0.0,
            "loud": [round(float(v), 1) for v in loud],
            "beats": beat_times, "bpm": bpm, "moves": moves(loud)}


def _emit(obj) -> None:
    print(json.dumps(obj), flush=True)


def main(argv) -> int:
    if len(argv) != 1:
        _emit({"error": "Usage: measure.py <audio>"})
        return 2
    try:
        import soundfile as sf
        _emit({"progress": 0.0, "text": "Loading the score"})
        x, rate = sf.read(argv[0], dtype="float32", always_2d=True)
        result = analyse(x, rate, lambda f, text: _emit({"progress": f, "text": text}))
    except Exception as exc:   # report anything as JSON, for the caller
        _emit({"error": f"Could not measure {argv[0]}: {exc}"})
        return 1
    _emit({"done": True, **result})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
