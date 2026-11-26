"""Voiceover join core for Autocue Studio's line mode.

Turns one take per line of a line script into a joined voiceover. These are
pure functions (numpy in, numpy out); the command line, the output files and
the transcript sit on top of them.

Values (the voicestudio-narration skill's own-voice values, verbatim):
  * head trim: keep 0.05 s before the first voiced frame. A voiced frame is a
    10 ms frame above -24 dBFS with a zero-crossing rate below 0.12 (at
    16 kHz; the threshold scales with the rate). First walk back over
    contiguous frames above -40 dBFS, to keep a soft first consonant; a 5 ms
    fade-in at the cut;
  * tail trim: cut 0.15 s after the last voiced frame, ignoring a broadband
    transient under about 40 ms after it, with a 30 ms fade-out. First walk
    forward over contiguous frames above max(-45 dBFS, noise + 12 dB)
    (take_checks' voice rule), to keep a soft last consonant;
  * high-pass: 80 Hz;
  * stalls: a mid-sentence gap quieter than -30 dBFS longer than 0.6 s is
    shortened to 0.3 s;
  * levels: each sentence part at -13.5 dB RMS, with 0.55 s of silence
    between sentences in a clip, then
    alimiter=limit=0.84:level=false:attack=2:release=50, at 48 kHz; each clip
    within 0.5 dB of -13.8 dB RMS (gain plus the same limiter);
  * spacing: 0.6 s between clips in a section, 1.2 s between sections, and a
    0.5 s tail.

Take files are named <project>_<id>.wav, where project is the line script's
"# name:". The clip of an id is the part before the dot ("05" for "05.2").
"""

import math
import re

import numpy as np

import take_checks
from take_checks import (FLOOR_DBFS, FRAME_S, NOISE_FRACTION, NOISE_FRAME_S,
                         PAUSE_DBFS, PAUSE_MIN_S, TRANSIENT_MAX_S,
                         VOICE_MIN_DBFS, VOICE_OVER_NOISE_DB, VOICED_DBFS,
                         VOICED_MAX_ZCR, _frame_db, _frames, _runs,
                         _speech_end, _zcr)

RATE = 48000

HEAD_KEEP_S = 0.05
HEAD_WALK_DBFS = -40.0     # soft first consonant: walk back over frames above this
FADE_IN_S = 0.005
ZCR_RATE = take_checks.RATE   # the rate VOICED_MAX_ZCR was tuned at
TAIL_KEEP_S = 0.15
FADE_OUT_S = 0.030
HIGHPASS_HZ = 80.0
STALL_TO_S = 0.3
STALL_XFADE_S = 0.005
PART_RMS_DB = -13.5
CLIP_RMS_DB = -13.8
CLIP_RMS_TOLERANCE_DB = 0.5
SENTENCE_GAP_S = 0.55
CLIP_GAP_S = 0.6
SECTION_GAP_S = 1.2
TAIL_S = 0.5
LIMIT = 0.84
LIMIT_ATTACK_MS = 2.0
LIMIT_RELEASE_MS = 50.0

TEMP_SUFFIX = ".recording.tmp.wav"
SUPERSEDED_DIR = "superseded"


def decode48(path):
    """The take as mono float32 at 48 kHz (through ffmpeg). Raises
    take_checks.CheckError when it cannot be read."""
    return take_checks.decode(path, RATE)[0]


# ------------------------------------------------------------ voiced frames ----

def _voiced(x, rate):
    """(frame length, frame dB, loud, voiced) for 10 ms frames. The ZCR
    threshold was tuned at 16 kHz; crossings per sample fall as the rate
    rises, so it is scaled by 16000 / rate to mean the same thing."""
    n = max(1, int(round(FRAME_S * rate)))
    f = _frames(x, n)
    db = _frame_db(f)
    loud = db > VOICED_DBFS
    return n, db, loud, loud & (_zcr(f) < VOICED_MAX_ZCR * ZCR_RATE / rate)


def _noise_dbfs(x, rate):
    """The room's noise floor, as in take_checks: the quietest 10 % of
    50 ms frames."""
    f50 = _frames(x, max(1, int(round(NOISE_FRAME_S * rate))))
    if not len(f50):
        return FLOOR_DBFS
    power = np.sort(np.mean(f50 ** 2, axis=1))
    p = float(np.mean(power[:max(1, int(len(power) * NOISE_FRACTION))]))
    return max(10 * math.log10(p), FLOOR_DBFS) if p > 0 else FLOOR_DBFS


def _as_float(x):
    return np.array(x, dtype=np.float64, copy=True).reshape(-1)


# ----------------------------------------------------------------- trimming ----

def trim_take(x, rate=RATE):
    """Trim a take's head and tail. Returns (y, info) with
    info = {head_s, tail_s, speech}: the seconds cut from the start and the
    end, and whether any voiced frame was found. A take with no voiced frame
    comes back unchanged.

    The head walks back from the first voiced frame over contiguous frames
    above -40 dBFS (a soft first consonant), then keeps 0.05 s more. The
    tail walks forward from the end of speech over contiguous frames above
    max(-45 dBFS, noise + 12 dB) (a soft last consonant), stopping short of
    a trailing broadband transient under 40 ms, then keeps 0.15 s more."""
    x = _as_float(x)
    n, db, loud, voiced = _voiced(x, rate)
    end_idx = _speech_end(voiced, loud, FRAME_S) if voiced.any() else None
    if end_idx is None:
        return x, {"head_s": 0.0, "tail_s": 0.0, "speech": False}

    first = int(np.argmax(voiced))
    while first > 0 and db[first - 1] > HEAD_WALK_DBFS:
        first -= 1

    voice = db > max(VOICE_MIN_DBFS, _noise_dbfs(x, rate) + VOICE_OVER_NOISE_DB)
    last = end_idx
    while last < len(voice) and voice[last]:
        last += 1
    # A click right after the soft tail: a short loud, unvoiced run at the
    # end of the walked stretch, after softer frames, is not the voice.
    if last > end_idx and loud[last - 1] and not voiced[last - 1]:
        run = last
        while run > end_idx and loud[run - 1] and not voiced[run - 1]:
            run -= 1
        if run > end_idx and (last - run) * FRAME_S < TRANSIENT_MAX_S:
            last = run

    start = max(0, first * n - int(round(HEAD_KEEP_S * rate)))
    stop = min(len(x), last * n + int(round(TAIL_KEEP_S * rate)))
    y = x[start:stop].copy()
    fade_in = min(len(y), int(round(FADE_IN_S * rate))) if start > 0 else 0
    if fade_in:
        y[:fade_in] *= np.linspace(0.0, 1.0, fade_in)
    fade = min(len(y), int(round(FADE_OUT_S * rate)))
    if fade:
        y[len(y) - fade:] *= np.linspace(1.0, 0.0, fade)
    return y, {"head_s": start / rate, "tail_s": (len(x) - stop) / rate,
               "speech": True}


def tighten_stalls(x, rate=RATE):
    """Shorten every gap quieter than -30 dBFS and longer than 0.6 s, between
    the first voiced frame and the end of speech, to 0.3 s (a 5 ms
    equal-power crossfade inside the gap hides the splice). Returns
    (y, stalls) with stalls = [{at_s, from_s, to_s}]; at_s is where the gap
    starts in the input."""
    x = _as_float(x)
    n, db, loud, voiced = _voiced(x, rate)
    end_idx = _speech_end(voiced, loud, FRAME_S) if voiced.any() else None
    if end_idx is None:
        return x, []
    first = int(np.argmax(voiced))
    quiet = db < PAUSE_DBFS
    quiet[:first] = False
    quiet[end_idx:] = False

    ms = max(1, int(round(0.001 * rate)))
    keep = int(round(STALL_TO_S * rate))
    xfade = int(round(STALL_XFADE_S * rate))
    cuts = []
    for a, b in _runs(quiet):
        if (b - a) * n < (PAUSE_MIN_S - 2 * FRAME_S) * rate:
            continue
        s0, s1 = a * n, b * n
        # The 10 ms grid can miss up to a frame of quiet at each edge.
        while s0 - ms >= (a - 1) * n and _rms_dbfs(x[s0 - ms:s0]) < PAUSE_DBFS:
            s0 -= ms
        while s1 + ms <= (b + 1) * n and _rms_dbfs(x[s1:s1 + ms]) < PAUSE_DBFS:
            s1 += ms
        if (s1 - s0) / rate > PAUSE_MIN_S + 1e-9 and s1 - s0 >= keep + xfade:
            cuts.append((s0, s1))

    pieces, pos, stalls = [], 0, []
    theta = np.linspace(0.0, np.pi / 2, xfade) if xfade else np.zeros(0)
    for s0, s1 in cuts:
        gap = x[s0:s1]
        h = keep // 2
        b_part = gap[len(gap) - (keep - h):]
        mixed = gap[h:h + xfade] * np.cos(theta) + b_part[:xfade] * np.sin(theta)
        pieces += [x[pos:s0], gap[:h], mixed, b_part[xfade:]]
        pos = s1
        stalls.append({"at_s": s0 / rate, "from_s": (s1 - s0) / rate,
                       "to_s": keep / rate})
    pieces.append(x[pos:])
    return np.concatenate(pieces), stalls


# ------------------------------------------------------------------- levels ----

def _rms_dbfs(x):
    if not len(x):
        return FLOOR_DBFS
    p = float(np.mean(np.asarray(x, dtype=np.float64) ** 2))
    return max(10.0 * math.log10(p), FLOOR_DBFS) if p > 0 else FLOOR_DBFS


def rms_db(x):
    """RMS level of the whole signal in dBFS (-120 for silence)."""
    return _rms_dbfs(x)


def set_rms(x, target_db):
    """x scaled to an RMS of target_db dBFS. Silence stays silence."""
    x = _as_float(x)
    level = rms_db(x)
    if level <= FLOOR_DBFS:
        return x
    return x * 10 ** ((target_db - level) / 20.0)


def highpass(x, rate=RATE, freq=HIGHPASS_HZ):
    """A 2nd-order Butterworth high-pass (one biquad, RBJ coefficients)."""
    x = _as_float(x)
    w0 = 2 * math.pi * freq / rate
    cosw, alpha = math.cos(w0), math.sin(w0) / (2 * (1 / math.sqrt(2)))
    a0 = 1 + alpha
    b0 = (1 + cosw) / 2 / a0
    b1 = -(1 + cosw) / a0
    b2 = b0
    a1 = -2 * cosw / a0
    a2 = (1 - alpha) / a0
    out = [0.0] * len(x)
    x1 = x2 = y1 = y2 = 0.0
    for i, v in enumerate(x.tolist()):
        y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        out[i] = y
        x2, x1, y2, y1 = x1, v, y1, y
    return np.asarray(out, dtype=np.float64)


def limit(x, rate=RATE, ceiling=LIMIT, attack_ms=LIMIT_ATTACK_MS,
          release_ms=LIMIT_RELEASE_MS):
    """A look-ahead peak limiter: the numpy counterpart of
    alimiter=limit=0.84:level=false:attack=2:release=50 (no make-up gain,
    no added delay). Every output peak is at or under the ceiling.

    The gain each sample needs is min(1, ceiling / |x|). Its minimum over the
    next attack window, held with an exponential release, is then averaged
    over the attack window, so the gain ramps down before a peak and every
    averaged value is still at or under what that sample needs."""
    x = _as_float(x)
    if not len(x):
        return x
    att = max(1, int(round(attack_ms / 1000.0 * rate)))
    peak = np.abs(x)
    with np.errstate(divide="ignore"):
        need = np.where(peak > ceiling, ceiling / np.maximum(peak, 1e-30), 1.0)
    if need.min() >= 1.0:
        return x
    padded = np.concatenate([need, np.ones(att - 1)])
    ahead = np.lib.stride_tricks.sliding_window_view(padded, att).min(axis=1)

    # Release: depth d[n] = max over k <= n of d[k] * a^(n-k), in logs.
    c = -1.0 / (release_ms / 1000.0 * rate)        # log of the release factor
    idx = np.arange(len(x), dtype=np.float64)
    with np.errstate(divide="ignore"):
        log_depth = np.log(1.0 - ahead)
    held = np.exp(idx * c + np.maximum.accumulate(log_depth - idx * c))
    gain = np.minimum(1.0 - held, ahead)

    front = np.concatenate([np.full(att - 1, gain[0]), gain])
    sums = np.concatenate([[0.0], np.cumsum(front)])
    smooth = (sums[att:] - sums[:-att]) / att
    return x * np.minimum(smooth, need)


def build_clip(parts, rate=RATE):
    """Join a clip's sentence parts: each at -13.5 dB RMS, 0.55 s of silence
    between them, then the limiter."""
    if not parts:
        return np.zeros(0)
    gap = np.zeros(int(round(SENTENCE_GAP_S * rate)))
    pieces = []
    for i, p in enumerate(parts):
        if i:
            pieces.append(gap)
        pieces.append(set_rms(p, PART_RMS_DB))
    return limit(np.concatenate(pieces), rate)


def level_clip(x, rate=RATE, target_db=CLIP_RMS_DB):
    """Gain plus the same limiter, repeated until the clip's RMS is within
    0.5 dB (aiming for 0.05 dB) of -13.8 dB."""
    x = _as_float(x)
    if rms_db(x) <= FLOOR_DBFS:
        return x
    aim = target_db
    y = limit(set_rms(x, aim), rate)
    for _ in range(8):
        err = target_db - rms_db(y)
        if abs(err) < 0.05:
            break
        aim += err
        y = limit(set_rms(x, aim), rate)
    return y


# ----------------------------------------------------------------- assembly ----

def assemble(clips, sections, project="", rate=RATE):
    """Lay clips end to end in script order. clips = [(clip_id, audio)],
    sections = the section of each clip. 0.6 s between clips in a section,
    1.2 s across a section change, and a 0.5 s tail. Returns (x, timings)
    with timings = [{clip, section, name, start_s, end_s}], where name is
    <project>_<clip>."""
    if len(clips) != len(sections):
        raise ValueError("one section per clip")
    pieces, timings, pos = [], [], 0
    for i, ((clip, audio), section) in enumerate(zip(clips, sections)):
        if i:
            gap = SECTION_GAP_S if section != sections[i - 1] else CLIP_GAP_S
            g = int(round(gap * rate))
            pieces.append(np.zeros(g))
            pos += g
        audio = _as_float(audio)
        pieces.append(audio)
        timings.append({"clip": clip, "section": section,
                        "name": f"{project}_{clip}" if project else str(clip),
                        "start_s": pos / rate, "end_s": (pos + len(audio)) / rate})
        pos += len(audio)
    pieces.append(np.zeros(int(round(TAIL_S * rate))))
    return np.concatenate(pieces), timings


# ------------------------------------------------------------------ the plan ----

def clip_of(line_id):
    """The clip a line id belongs to: the part before the dot."""
    return str(line_id).split(".", 1)[0]


def plan_join(script_lines, take_files, project=None):
    """Match a line script's ids to take files. Pure: reads no files.

    script_lines is the line list from parse_line_script (with project, its
    "# name:") or the (name, lines) pair it returns. take_files are paths or
    names. Files in a "superseded" folder, "*.recording.tmp.wav" files and
    anything that is not a .wav are ignored.

    Returns {clips: [{clip, section, ids}], missing: [ids], extra: [names],
    files: {id: path}, duplicates: [{id, files}]}. clips and missing follow
    script order; extra are the names of .wav takes that match no id
    (sorted). When two files match one id (say the same name in two
    folders), files keeps the first and duplicates lists every match."""
    if isinstance(script_lines, tuple):
        project, script_lines = (project or script_lines[0]), script_lines[1]
    ids, clips, by_clip = [], [], {}
    for ln in script_lines:
        line_id = ln["id"]
        if line_id in ids:
            continue
        ids.append(line_id)
        c = clip_of(line_id)
        if c not in by_clip:
            by_clip[c] = {"clip": c, "section": ln.get("section", ""), "ids": []}
            clips.append(by_clip[c])
        by_clip[c]["ids"].append(line_id)

    wanted = {}
    for line_id in ids:
        key = (f"{project}_{line_id}.wav" if project is not None
               else f"_{line_id}.wav").casefold()
        wanted[key] = line_id
    files, extra, matches = {}, [], {}
    for path in take_files:
        parts = [p for p in re.split(r"[\\/]", str(path)) if p]
        if not parts:
            continue
        name = parts[-1]
        low = name.casefold()
        if (not low.endswith(".wav") or low.endswith(TEMP_SUFFIX)
                or any(p.casefold() == SUPERSEDED_DIR for p in parts[:-1])):
            continue
        if project is not None:
            line_id = wanted.get(low)
        else:
            line_id = next((v for k, v in wanted.items() if low.endswith(k)), None)
        if line_id is None:
            extra.append(name)
        else:
            files.setdefault(line_id, path)
            matches.setdefault(line_id, []).append(path)
    duplicates = [{"id": i, "files": matches[i]} for i in ids
                  if len(matches.get(i, ())) > 1]
    return {"clips": clips, "missing": [i for i in ids if i not in files],
            "extra": sorted(extra), "files": files, "duplicates": duplicates}
