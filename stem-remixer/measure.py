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
import os
import sys

import numpy as np

STEP_S = 0.1           # loudness resolution
SMOOTH_S = 1.5         # loudness moving average
FLOOR_DB = -90.0
MOVE_DB = 6.0          # a rise or drop is at least this
HOLD_S = 2.0           # and holds this long
HELD_DB = 4.5          # no point of the new level falls back nearer than this
SETTLED_DB = 4.0       # a level has settled when 2 s of it span less than this
LOOK_AHEAD_S = 15.0    # a slow swell can take this long
FADE_MIN_S = 2.0       # a decline shorter than this is an ending, not a fade
FADE_DEPTH_DB = 20.0   # a fade goes at least this far down
MIN_BPM, MAX_BPM = 60.0, 180.0
ONSET_HOP_S = 0.01
ONSET_WINDOW_S = 0.046 # onset STFT window (2048 at 44.1 or 48 kHz): long enough to keep steady chords steady
REFINE_WINDOW_S = 0.023
ONSET_BANDS = 40
ONSET_BLOCK = 1024     # frames of the onset STFT worked out at once
ONSET_FLOOR = 1e-12    # band power floor: -120 dB below full scale
ONSET_RANGE_DB = 60.0  # and no lower than this below the file's own level
MIN_PEAK = 0.6         # onsets must stand this far (dB per band) above the typical flux
MIN_PERIODICITY = 0.2  # normalised autocorrelation at the beat period
MIN_CONTRAST = 2.0     # beats must stand this far above the onsets between them
CONTRAST_BEATS = 4     # judged over this many beats either side
SHORT_RUN = 3          # fewer beats than this on their own is chance, not a beat
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
    """Rises, drops and the fade in a smoothed loudness curve.

    From each point, the median of the 2 s before is compared with each 2 s
    window up to 15 s ahead. A rise (or drop) is the first window that has
    settled (it spans under 4 dB) with its median at least 6 dB above (or
    below) and no point less than 4.5 dB beyond. The move is placed where the
    curve last left the earlier level. A change still going is followed until
    it levels off (under 0.5 dB a second), and the search carries on from the
    new level, so one change, quick or slow, is reported once."""
    found = []
    hold = int(round(HOLD_S / STEP_S))
    settle = int(round(SMOOTH_S / STEP_S))
    ahead = int(round(LOOK_AHEAD_S / STEP_S))
    fade = _fade(loud)
    n = len(loud)
    if n < 2 * hold + settle:
        windows = np.zeros((0, hold))
    else:
        windows = np.lib.stride_tricks.sliding_window_view(loud, hold)   # windows[j] = loud[j:j+hold]
    med = np.median(windows, axis=1) if len(windows) else np.zeros(0)
    low = windows.min(axis=1) if len(windows) else np.zeros(0)
    high = windows.max(axis=1) if len(windows) else np.zeros(0)
    i = hold
    while i + settle + hold <= n:
        base, spread = med[i - hold], high[i - hold] - low[i - hold]
        if spread > SETTLED_DB:
            i += 1
            continue
        last = min(n - hold, i + ahead)
        js = np.arange(i + settle, last + 1)
        settled = high[js] - low[js] <= SETTLED_DB
        # Going the other way first means it's not this kind of change.
        lowest = np.minimum.accumulate(loud[i:last + 1])[js - i]
        highest = np.maximum.accumulate(loud[i:last + 1])[js - i]
        rise = settled & (med[js] - base >= MOVE_DB) & (low[js] - base >= HELD_DB) \
            & (lowest >= base - SETTLED_DB)
        drop = settled & (base - med[js] >= MOVE_DB) & (base - high[js] >= HELD_DB) \
            & (highest <= base + SETTLED_DB)
        hit = np.nonzero(rise | drop)[0]
        if len(hit) == 0:
            i += 1
            continue
        j = int(js[hit[0]])
        kind = "rise" if rise[hit[0]] else "drop"
        sign = 1.0 if kind == "rise" else -1.0
        # Follow a slow swell until it stops moving, for the full change.
        second = int(round(1.0 / STEP_S))
        while j + second <= n - hold and sign * (med[j + second] - med[j]) > 0.5:
            j += second
        span = loud[i:j + 1]
        near = np.nonzero(span <= base + 1.0 if kind == "rise" else span >= base - 1.0)[0]
        start = i + (int(near[-1]) + 1 if len(near) else 0)
        t = start * STEP_S
        if not (kind == "drop" and fade is not None and t >= fade * STEP_S - HOLD_S):
            found.append({"t": round(t, 2), "kind": kind, "db": round(float(med[j] - base), 1)})
        i = j + hold   # carry on from the new level
    if fade is not None:
        found.append({"t": round(fade * STEP_S, 2), "kind": "fade",
                      "db": round(float(loud[-1] - loud[fade]), 1)})
    return sorted(found, key=lambda m: m["t"])


# ------------------------------------------------------------------ beats

def _bands(n_fft: int, rate: int) -> np.ndarray:
    """(bins, bands) matrix summing an rfft's power into ~40 log-spaced bands
    from 30 Hz up to 16 kHz (or Nyquist); bands with no bins are left out."""
    freqs = np.fft.rfftfreq(n_fft, 1.0 / rate)
    top = min(16000.0, rate / 2)
    edges = np.geomspace(30.0, top, ONSET_BANDS + 1)
    which = np.digitize(freqs, edges) - 1
    matrix = np.zeros((len(freqs), ONSET_BANDS))
    inside = (which >= 0) & (which < ONSET_BANDS)
    matrix[np.nonzero(inside)[0], which[inside]] = 1.0
    return matrix[:, matrix.sum(axis=0) > 0]


def _floor(mono: np.ndarray) -> float:
    """Band power floor, set from the whole file's level (a cheap first
    pass), so leakage far below the music doesn't count as onsets."""
    return max(ONSET_FLOOR, 2.0 * float(np.mean(mono ** 2)) * 10 ** (-ONSET_RANGE_DB / 10))


def onset_envelope(mono: np.ndarray, rate: int) -> tuple:
    """Half-wave-rectified flux of the band levels (dB), averaged over the
    bands, every ~10 ms. Worked out a block at a time, against a fixed
    reference (full scale), so only the band levels are kept.
    Returns (envelope, hop in samples, window in samples)."""
    hop = max(1, int(round(rate * ONSET_HOP_S)))
    n_fft = 1 << int(np.round(np.log2(max(2, rate * ONSET_WINDOW_S))))
    if len(mono) < n_fft + hop:
        return np.zeros(0), hop, n_fft
    frames = 1 + (len(mono) - n_fft) // hop
    window = np.hanning(n_fft)
    bands = _bands(n_fft, rate)
    scale = 4.0 / (window.sum() ** 2)   # a full-scale sine in one band reads 0 dB
    floor = _floor(mono)
    flux = np.zeros(frames)
    previous = None
    for first in range(0, frames, ONSET_BLOCK):
        idx = (np.arange(first, min(frames, first + ONSET_BLOCK)) * hop)[:, None] + np.arange(n_fft)
        power = np.abs(np.fft.rfft(mono[idx] * window, axis=1)) ** 2 @ bands
        level = 10 * np.log10(np.maximum(power * scale, floor))
        if previous is not None:
            level = np.vstack([previous, level])
        rises = np.maximum(0.0, np.diff(level, axis=0)).mean(axis=1)
        flux[first + (previous is None):first + (previous is None) + len(rises)] = rises
        previous = level[-1:]
    return flux, hop, n_fft


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
    return _keep_supported(beats, norm)


def _keep_supported(beats: np.ndarray, norm: np.ndarray) -> np.ndarray:
    """Drop beats with no onsets of their own: the tracker carries its grid
    through quiet or beatless stretches (an ambient intro, say).

    Each beat's strength is the strongest onset within two frames of it; its
    background is the 75th percentile of the same measure away from beats,
    within two periods. Around each beat (CONTRAST_BEATS either side) the
    mean strength must stand MIN_CONTRAST times above the median background,
    which an accented or soft beat still does and a grid laid over noise or a
    pad doesn't. Weak beats at the very ends go too (silence before the first
    onset or after the last), as does any stretch of fewer than SHORT_RUN
    beats left between dropped ones."""
    if len(beats) < 2:
        return beats[:0]
    near = np.lib.stride_tricks.sliding_window_view(np.pad(norm, 2), 5).max(axis=1)
    strength = near[beats]
    reference = np.percentile(strength, 80)
    if reference <= 0:
        return beats[:0]
    period = max(1, int(np.median(np.diff(beats))))
    away = np.ones(len(norm), bool)
    for b in beats:
        away[max(0, b - 3):b + 4] = False
    background = np.empty(len(beats))
    for k, b in enumerate(beats):
        lo, hi = max(0, b - 2 * period), b + 2 * period + 1
        values = near[lo:hi][away[lo:hi]]
        background[k] = np.percentile(values, 75) if len(values) else 0.0
    background = np.maximum(background, 0.05 * reference)
    side = CONTRAST_BEATS
    contrast = np.array([strength[max(0, k - side):k + side + 1].mean()
                         / np.median(background[max(0, k - side):k + side + 1])
                         for k in range(len(beats))])
    keep = contrast >= MIN_CONTRAST
    strong = np.nonzero(keep & (strength >= 0.5 * reference))[0]
    if len(strong) == 0:
        return beats[:0]
    keep[:strong[0]] = False
    keep[strong[-1] + 1:] = False
    edges = np.flatnonzero(np.diff(np.concatenate([[0], keep.astype(int), [0]])))
    for first, last in zip(edges[::2], edges[1::2]):
        if last - first < SHORT_RUN:
            keep[first:last] = False
    return beats[keep]


def _refine(mono: np.ndarray, rate: int, times: np.ndarray, reach_s: float,
            floor: float) -> np.ndarray:
    """Move each beat to the sharpest band-level rise nearby, measured with a
    window half the size of the tracking one, every millisecond. (The long
    window finds the beat; the short one places it.)"""
    n_fft = 1 << int(np.round(np.log2(max(2, rate * REFINE_WINDOW_S))))
    lag, step = n_fft // 2, max(1, int(round(rate * 0.001)))
    window = np.hanning(n_fft)
    bands = _bands(n_fft, rate)
    scale = 4.0 / (window.sum() ** 2)

    def level(centres):
        idx = (centres - n_fft // 2)[:, None] + np.arange(n_fft)
        power = np.abs(np.fft.rfft(mono[idx] * window, axis=1)) ** 2 @ bands
        return 10 * np.log10(np.maximum(power * scale, floor))

    reach = int(round(reach_s * rate))
    out = []
    for t in times:
        centre = int(round(t * rate))
        centres = np.arange(centre - reach, centre + reach + 1, step)
        centres = centres[(centres - lag - n_fft // 2 >= 0) & (centres + n_fft // 2 <= len(mono))]
        if len(centres) == 0:
            out.append(t)
            continue
        rise = np.maximum(0.0, level(centres) - level(centres - lag)).mean(axis=1)
        out.append(centres[int(np.argmax(rise))] / rate)
    return np.array(out)


def beats(mono: np.ndarray, rate: int) -> tuple:
    """(beat times in seconds, bpm), or ([], None) with no clear beat."""
    env, hop, n_fft = onset_envelope(mono, rate)
    if len(env) == 0 or np.percentile(env, 99) - np.median(env) < MIN_PEAK:
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
    times = np.unique(np.round(_refine(mono, rate, times, n_fft / rate, _floor(mono)), 3))
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
        try:
            x, rate = sf.read(argv[0], dtype="float32", always_2d=True)
        except Exception as exc:
            _emit({"error": f"Couldn't read {os.path.basename(argv[0])} as audio. {exc}"})
            return 1
        result = analyse(x, rate, lambda f, text: _emit({"progress": f, "text": text}))
    except Exception as exc:   # report anything as JSON, for the caller
        _emit({"error": f"Could not measure {os.path.basename(argv[0])}: {exc}"})
        return 1
    _emit({"done": True, **result})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
