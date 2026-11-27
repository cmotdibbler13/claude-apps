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

The command (main) joins a film's takes:

  python voiceover_join.py --script <line script> --takes <dir> --out <dir>
      [--allow-flagged] [--pauses <json>] [--model medium.en] [--device auto]

It prints one JSON object per line: {"progress": 0..1, "text": ...} while it
works, then {"done": true, ...} or {"error": ...}. Exit codes: 0 done, 2
refused (bad arguments, missing takes, a take with no speech), 1 failed.
"""

import argparse
import csv
import json
import math
import os
import re
import sys
from datetime import datetime

import numpy as np

import line_script
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
TITLE_HOLD_S = 6.0   # the title card at the end of the cold open (the first section)
LIMIT = 0.84
LIMIT_ATTACK_MS = 2.0
LIMIT_RELEASE_MS = 50.0

SILENT_PART_S = 0.5      # a take with no speech, joined with --allow-flagged
TRANSCRIBE_RATE = take_checks.RATE   # whisper wants 16 kHz
RESAMPLE_TAPS = 127
RESAMPLE_CUTOFF_HZ = 7200.0

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

def _voice_mask(x, rate, db):
    """10 ms frames that are the voice (or a soft consonant): above
    max(-45 dBFS, the room's noise + 12 dB), take_checks' voice rule."""
    return db > max(VOICE_MIN_DBFS, _noise_dbfs(x, rate) + VOICE_OVER_NOISE_DB)


CLICK_GAP_S = 0.10   # a key click stands apart from the speech by at least this


def _voice_span(x, rate):
    """(first, last) 10 ms frame indexes (last exclusive) of the voice, or
    None. Every sound above the voice threshold counts, however soft or
    short, so quiet last words and the gaps between words never shorten it.
    The only thing left out is a key click: a burst under 40 ms at either end
    that is not voiced (broadband) and stands at least 0.1 s clear of the
    rest."""
    n, db, loud, voiced = _voiced(x, rate)
    runs = _runs(_voice_mask(x, rate, db))
    if not runs:
        return None
    max_click = int(round(TRANSIENT_MAX_S / FRAME_S))
    min_gap = int(round(CLICK_GAP_S / FRAME_S))

    def click(run, gap):
        # Under 40 ms is too short for any word, voiced or not.
        a, b = run
        return b - a < max_click and gap >= min_gap

    for _ in range(2):   # a press and a release
        if len(runs) > 1 and click(runs[-1], runs[-1][0] - runs[-2][1]):
            runs.pop()
        if len(runs) > 1 and click(runs[0], runs[1][0] - runs[0][1]):
            runs.pop(0)
    first, last = runs[0][0], runs[-1][1]
    # A click pressed while the last sound was still dying away: a loud,
    # unvoiced burst under 40 ms at the very end, at least 10 dB above the
    # 100 ms before it. The voice ends where the burst starts.
    a = last
    while a > first and last - a < max_click and loud[a - 1] and not voiced[a - 1]:
        a -= 1
    if a < last and a - first >= min_gap:
        before = db[max(first, a - min_gap):a]
        if len(before) and db[a:last].max() >= np.median(before) + 10.0:
            last = a
    return first, last


def trim_take(x, rate=RATE):
    """Trim a take's head and tail. Returns (y, info) with
    info = {head_s, tail_s, speech}: the seconds cut from the start and the
    end, and whether any voiced frame was found. A take with no voiced frame
    comes back unchanged.

    The voice runs from the first to the last 10 ms frame above
    max(-45 dBFS, noise + 12 dB) (take_checks' voice rule), leaving out only
    a key click (see _voice_span). The head keeps 0.05 s before it with a
    5 ms fade-in; the tail keeps 0.15 s after it with a 30 ms fade-out.
    Cutting is cautious on purpose: a little room tone is cheap, a lost word
    is not."""
    x = _as_float(x)
    n, db, loud, voiced = _voiced(x, rate)
    span = _voice_span(x, rate) if voiced.any() else None
    if span is None:
        return x, {"head_s": 0.0, "tail_s": 0.0, "speech": False}
    first, last = span

    start = max(0, first * n - int(round(HEAD_KEEP_S * rate)))
    stop = min(len(x), last * n + int(round(TAIL_KEEP_S * rate)))
    y = x[start:stop].copy()
    fade_in = min(len(y), int(round(FADE_IN_S * rate))) if start > 0 else 0
    if fade_in:
        y[:fade_in] *= np.linspace(0.0, 1.0, fade_in)
    fade = min(len(y), int(round(FADE_OUT_S * rate))) if stop < len(x) else 0
    if fade:
        y[len(y) - fade:] *= np.linspace(1.0, 0.0, fade)
    return y, {"head_s": start / rate, "tail_s": (len(x) - stop) / rate,
               "speech": True}


def tighten_stalls(x, rate=RATE):
    """Shorten every gap of true silence (quieter than -30 dBFS and below the
    voice threshold) longer than 0.6 s, inside the voice, to 0.3 s (a 5 ms
    equal-power crossfade inside the gap hides the splice). Returns
    (y, stalls) with stalls = [{at_s, from_s, to_s}]; at_s is where the gap
    starts in the input."""
    x = _as_float(x)
    n, db, loud, voiced = _voiced(x, rate)
    span = _voice_span(x, rate) if voiced.any() else None
    if span is None:
        return x, []
    first, end_idx = span
    # Only true silence: quieter than -30 dBFS AND below the voice threshold,
    # so a softly spoken word inside a long pause is never taken for one.
    floor = min(PAUSE_DBFS, max(VOICE_MIN_DBFS, _noise_dbfs(x, rate) + VOICE_OVER_NOISE_DB))
    quiet = db < floor
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
        while s0 - ms >= (a - 1) * n and _rms_dbfs(x[s0 - ms:s0]) < floor:
            s0 -= ms
        while s1 + ms <= (b + 1) * n and _rms_dbfs(x[s1:s1 + ms]) < floor:
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


PAUSE_SEARCH_S = 0.15   # how far from the asked time a pause may move to a quiet spot
PAUSE_WINDOW_S = 0.010


def insert_pauses(x, pauses, rate=RATE):
    """Add silence inside a part. pauses = [{at_s, add_s}], at_s in the part's
    time before any insertion. Each pause moves to the quietest 10 ms window
    centred within 0.15 s of at_s (the nearest one on a tie), the part is
    split there (the left side fades out and the right side in over 5 ms,
    equal power) and add_s of zeros goes between. Returns (y, tight) where
    tight lists the at_s (before insertion) of the pauses whose quietest spot
    is still voice, so the cut lands in speech."""
    x = _as_float(x)
    pauses = sorted(pauses or [], key=lambda p: p["at_s"])
    if not pauses or not len(x):
        return x, []
    win = max(1, int(round(PAUSE_WINDOW_S * rate)))
    half = win // 2
    xfade = int(round(STALL_XFADE_S * rate))
    sums = np.concatenate([[0.0], np.cumsum(x ** 2)])
    threshold = max(VOICE_MIN_DBFS, _noise_dbfs(x, rate) + VOICE_OVER_NOISE_DB)
    step = max(1, int(round(0.001 * rate)))
    reach = int(round(PAUSE_SEARCH_S * rate))
    cuts, tight = [], []
    for p in pauses:
        want = int(round(float(p["at_s"]) * rate))
        lo = min(max(want - reach, half), max(len(x) - (win - half), half))
        hi = max(min(want + reach, len(x) - (win - half)), lo)
        centres = np.arange(lo, hi + 1, step)
        power = (sums[centres + (win - half)] - sums[centres - half]) / win
        order = np.lexsort((np.abs(centres - want), power))
        best = int(centres[order[0]])
        if 10 * math.log10(max(float(power[order[0]]), 1e-20)) >= threshold:
            tight.append(float(p["at_s"]))
        cuts.append((best, int(round(float(p["add_s"]) * rate))))
    theta = np.linspace(0.0, np.pi / 2, xfade) if xfade else np.zeros(0)
    x = x.copy()
    pieces, pos = [], 0
    for best, add in cuts:
        best = max(best, pos)
        left = x[pos:best]
        k = min(xfade, len(left))
        if k:
            left[len(left) - k:] *= np.cos(theta[:k])
        pieces += [left, np.zeros(add)]
        pos = best
        k = min(xfade, len(x) - best)
        if k:
            x[best:best + k] *= np.sin(theta[:k])
    pieces.append(x[pos:])
    return np.concatenate(pieces), tight


def build_clip(parts, rate=RATE, inside=None, after=None):
    """Join a clip's sentence parts: each at -13.5 dB RMS, then its inside
    pauses (inside[i], a list of {at_s, add_s}), then 0.55 s of silence plus
    after[i] before the next part, then the limiter. Returns the audio, or
    (audio, tight) when inside is given, with tight[i] the at_s list of the
    pauses of part i that cut into speech."""
    if not parts:
        return (np.zeros(0), []) if inside is not None else np.zeros(0)
    pieces, tight = [], []
    for i, p in enumerate(parts):
        if i:
            extra = after[i - 1] if after and after[i - 1] else 0.0
            pieces.append(np.zeros(int(round((SENTENCE_GAP_S + extra) * rate))))
        p = set_rms(p, PART_RMS_DB)
        if inside is not None:
            p, t = insert_pauses(p, inside[i], rate)
            tight.append(t)
        pieces.append(p)
    y = limit(np.concatenate(pieces), rate)
    return (y, tight) if inside is not None else y


def level_clip(x, rate=RATE, target_db=CLIP_RMS_DB, ref=None):
    """Gain plus the same limiter, repeated until the clip's RMS is within
    0.5 dB (aiming for 0.05 dB) of -13.8 dB. With ref (the same clip without
    its inserted pauses), the gain is found on ref and then applied, with the
    limiter, to x: the silence a pause adds never raises the voice's level."""
    x = _as_float(x)
    r = x if ref is None else _as_float(ref)
    level = rms_db(r)
    if level <= FLOOR_DBFS:
        return x
    aim = target_db
    y = limit(r * 10 ** ((aim - level) / 20.0), rate)
    for _ in range(8):
        err = target_db - rms_db(y)
        if abs(err) < 0.05:
            break
        aim += err
        y = limit(r * 10 ** ((aim - level) / 20.0), rate)
    if ref is None:
        return y
    return limit(x * 10 ** ((aim - level) / 20.0), rate)


# ----------------------------------------------------------------- assembly ----

def assemble(clips, sections, project="", rate=RATE, title_hold_s=None, after=None):
    """Lay clips end to end in script order. clips = [(clip_id, audio)],
    sections = the section of each clip. 0.6 s between clips in a section,
    1.2 s across a section change, and a 0.5 s tail. With title_hold_s, the
    first section change (the end of the cold open, where the title card
    sits) gets that gap instead of 1.2 s. Returns (x, timings)
    with timings = [{clip, section, name, start_s, end_s}], where name is
    <project>_<clip>. after[i] seconds are added to the gap after clip i."""
    if len(clips) != len(sections):
        raise ValueError("one section per clip")
    pieces, timings, pos, changes = [], [], 0, 0
    for i, ((clip, audio), section) in enumerate(zip(clips, sections)):
        if i:
            gap = CLIP_GAP_S
            if section != sections[i - 1]:
                changes += 1
                gap = title_hold_s if (changes == 1 and title_hold_s is not None) else SECTION_GAP_S
            if after and after[i - 1]:
                gap += after[i - 1]
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


# --------------------------------------------------------------- transcript ----

def resample_16k(x, rate=RATE):
    """48 kHz to 16 kHz for the transcriber: a windowed-sinc low-pass at
    7.2 kHz (Blackman, 127 taps), then every third sample. float32."""
    x = _as_float(x)
    factor = int(round(rate / TRANSCRIBE_RATE))
    if factor * TRANSCRIBE_RATE != rate:
        raise ValueError(f"can only resample whole multiples of {TRANSCRIBE_RATE} Hz")
    if factor == 1 or not len(x):
        return x.astype(np.float32)
    n = np.arange(RESAMPLE_TAPS) - (RESAMPLE_TAPS - 1) / 2
    fc = RESAMPLE_CUTOFF_HZ / rate
    h = 2 * fc * np.sinc(2 * fc * n) * np.blackman(RESAMPLE_TAPS)
    h /= h.sum()
    y = np.convolve(x, h, mode="same")
    return y[::factor].astype(np.float32)


def transcript_for(parts_with_offsets, transcriber, rate=RATE, on_part=None):
    """The word transcript of a voiceover. parts_with_offsets is
    [(sentence id, 48 kHz audio of that part as it is in the voiceover,
    its start in the voiceover in seconds)]. Each part is transcribed on its
    own (at 16 kHz) and its word times are moved to voiceover time, kept
    inside the part. A part of pure digital silence is not transcribed. on_part(i, sentence id) is called after each part.

    Returns {"sentences": [{sentence, text, start, end}],
             "words": [{word, start, end, sentence}]}."""
    sentences, words = [], []
    for i, (sentence, audio, offset) in enumerate(parts_with_offsets):
        audio = _as_float(audio)
        start = float(offset)
        end = start + len(audio) / rate
        if np.any(audio):
            text, found = transcriber.transcribe(resample_16k(audio, rate),
                                                 TRANSCRIBE_RATE)
        else:
            text, found = "", []   # digital silence: whisper would invent words
        sentences.append({"sentence": sentence, "text": (text or "").strip(),
                          "start": round(start, 3), "end": round(end, 3)})
        for word, w0, w1 in found or []:
            word = str(word).strip()
            if not word:
                continue
            a = min(max(start + float(w0), start), end)
            b = min(max(start + float(w1), a), end)
            words.append({"word": word, "start": round(a, 3), "end": round(b, 3),
                          "sentence": sentence})
        if on_part:
            on_part(i, sentence)
    return {"sentences": sentences, "words": words}


# ------------------------------------------------------------------ outputs ----

CSV_HEADER = ["clip", "section", "name", "start_s", "end_s", "timecode"]


def timecode(seconds):
    """MM:SS.cc (minutes can run past 99)."""
    cs = int(round(float(seconds) * 100))
    minutes, rest = divmod(cs, 6000)
    return f"{minutes:02d}:{rest // 100:02d}.{rest % 100:02d}"


def output_names(project):
    """{kind: file name} for the three outputs."""
    return {"wav": f"{project}_voiceover.wav",
            "csv": f"{project}_voiceover_timings.csv",
            "transcript": f"{project}_voiceover_transcript.json"}


def write_wav24(path, x, rate=RATE):
    """Mono 24-bit PCM WAV."""
    import wave
    pcm = np.round(np.clip(_as_float(x), -1.0, 1.0) * 8388607).astype("<i4")
    data = pcm.view(np.uint8).reshape(-1, 4)[:, :3].tobytes()
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(3)
        w.setframerate(rate)
        w.writeframes(data)


def write_timings(path, timings):
    with open(path, "w", encoding="utf-8", newline="") as fh:
        out = csv.writer(fh, lineterminator="\n")
        out.writerow(CSV_HEADER)
        for t in timings:
            out.writerow([t["clip"], t["section"], t["name"], f"{t['start_s']:.3f}",
                          f"{t['end_s']:.3f}", timecode(t["start_s"])])


def write_json(path, data):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)


def aside_names(out_dir, names, now=None):
    """{final path: path to move it to} for the outputs already in out_dir:
    <name>.old-<YYYYmmdd-HHMMSS>.<ext>, with -2, -3 ... added when a set from
    the same second is already there. One suffix for the whole set."""
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    present = [n for n in names if os.path.exists(os.path.join(out_dir, n))]
    if not present:
        return {}
    n = 1
    while True:
        tag = stamp if n == 1 else f"{stamp}-{n}"
        moves = {}
        for name in present:
            base, ext = os.path.splitext(name)
            moves[os.path.join(out_dir, name)] = os.path.join(out_dir, f"{base}.old-{tag}{ext}")
        if not any(os.path.exists(p) for p in moves.values()):
            return moves
        n += 1


class OutputLocked(OSError):
    """An output could not be moved or replaced (open in another program)."""

    def __init__(self, name):
        super().__init__(f"Couldn't write {name}: it may be open in another program "
                         "(Excel, your editor). Close it and run again.")
        self.name = name


def _remove_quietly(path):
    try:
        os.remove(path)
    except OSError:
        pass


def write_outputs(out_dir, project, x, timings, transcript):
    """Write the three outputs to temp names, move any earlier outputs aside,
    then rename the temps into place. Returns ({kind: path}, [moved-aside
    paths]). Nothing earlier is ever deleted.

    If a move or a swap fails (Windows refuses while the CSV is open in
    Excel, say), every step done so far is undone: the new files are
    removed, the earlier outputs go back under their names, the temps are
    deleted, and OutputLocked names the file."""
    os.makedirs(out_dir, exist_ok=True)
    names = output_names(project)
    finals = {k: os.path.join(out_dir, n) for k, n in names.items()}
    temps = {k: p + ".tmp" for k, p in finals.items()}
    try:
        write_wav24(temps["wav"], x)
        write_timings(temps["csv"], timings)
        write_json(temps["transcript"], transcript)
    except BaseException:
        for p in temps.values():
            _remove_quietly(p)
        raise
    moves = aside_names(out_dir, names.values())
    moved, placed = [], []
    try:
        for src, dst in moves.items():
            step = src
            os.rename(src, dst)   # never over an existing file
            moved.append((src, dst))
        for k in finals:
            step = finals[k]
            os.replace(temps[k], finals[k])
            placed.append(finals[k])
    except OSError:
        for path in reversed(placed):
            _remove_quietly(path)          # our new file, not an earlier one
        for src, dst in reversed(moved):
            if not os.path.exists(src):
                try:
                    os.rename(dst, src)
                except OSError:
                    pass                   # it stays safe under its .old name
        for p in temps.values():
            _remove_quietly(p)
        raise OutputLocked(os.path.basename(step)) from None
    return finals, sorted(moves.values())


# ------------------------------------------------------------------ command ----

class Refused(Exception):
    """The join will not run: printed as {"error": ...} with exit 2."""

    def __init__(self, message, **extra):
        super().__init__(message)
        self.extra = extra


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Refused(message)


def _emit(obj):
    print(json.dumps(obj), flush=True)


def _progress(fraction, text):
    _emit({"progress": round(min(max(fraction, 0.0), 1.0), 4), "text": text})


def _take_files(takes_dir, skip_dir=None):
    """Every file under takes_dir, top folder first, in name order."""
    skip = os.path.normcase(os.path.abspath(skip_dir)) if skip_dir else None
    files = []
    for root, dirs, names in os.walk(takes_dir):
        dirs.sort()
        if skip:
            dirs[:] = [d for d in dirs
                       if os.path.normcase(os.path.abspath(os.path.join(root, d))) != skip]
        files += [os.path.join(root, n) for n in sorted(names)]
    return files


def _parser():
    p = _Parser(prog="voiceover_join.py",
                description="Join a line script's takes into one voiceover, with "
                            "timings and a word transcript.")
    p.add_argument("--script", required=True, help="the line script")
    p.add_argument("--takes", required=True, help="the folder of takes")
    p.add_argument("--out", required=True, help="the folder for the voiceover files")
    p.add_argument("--allow-flagged", action="store_true",
                   help="join takes with no speech found instead of refusing")
    p.add_argument("--title-hold", type=float, default=TITLE_HOLD_S,
                   help="seconds of silence after the cold open for the title card (default 6)")
    p.add_argument("--pauses", default=None,
                   help="a JSON file of extra silence: {\"inside\": {id: [{at_s, add_s}]}, "
                        "\"after\": {id: seconds}}")
    p.add_argument("--model", default=None,
                   help="speech model (default: autocue_settings.json, else medium.en)")
    p.add_argument("--device", default=None,
                   help="auto, cuda or cpu (default: autocue_settings.json, else auto)")
    return p


def _make_transcriber(args):
    settings = take_checks.load_settings(os.path.dirname(os.path.abspath(__file__)))
    return take_checks.WhisperTranscriber(args.model or settings["check_model"],
                                          args.device or settings["check_device"])


def _read_pauses(path):
    """(inside, after) from a --pauses file: {id: [{at_s, add_s}]} and
    {id: seconds}; missing keys mean none, non-positive pauses are dropped."""
    if not path:
        return {}, {}
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            raise ValueError("not an object")
        def good(v):
            return math.isfinite(v) and v > 0
        inside = {str(k): [{"at_s": max(0.0, float(p["at_s"])), "add_s": float(p["add_s"])}
                           for p in v
                           if math.isfinite(float(p["at_s"])) and good(float(p["add_s"]))]
                  for k, v in (data.get("inside") or {}).items()}
        after = {str(k): float(v) for k, v in (data.get("after") or {}).items()
                 if good(float(v))}
    except OSError as e:
        raise Refused(f"Could not read the pauses file: {e}") from None
    except (ValueError, TypeError, KeyError, AttributeError) as e:
        raise Refused(f"The pauses file is not valid: {e}") from None
    return ({k: v for k, v in inside.items() if v}, after)


def join(args, transcriber=None):
    """Run the join for parsed arguments. Returns the done JSON (a dict).
    Raises Refused, take_checks.CheckError or OSError."""
    try:
        project, lines = line_script.parse_line_script(args.script)
    except OSError as e:
        raise Refused(f"Could not read the line script: {e}") from None
    if not lines:
        raise Refused("The line script has no lines")
    if not os.path.isdir(args.takes):
        raise Refused(f"Takes folder not found: {args.takes}")

    inside_map, after_map = _read_pauses(args.pauses)
    plan = plan_join((project, lines), _take_files(args.takes, args.out), project=project)
    if plan["missing"]:
        raise Refused("Missing takes: " + ", ".join(plan["missing"]))

    ids = [i for c in plan["clips"] for i in c["ids"]]
    total = 2 * len(ids)
    parts, tightened, silent = {}, [], []
    for n, line_id in enumerate(ids):
        try:
            x = decode48(plan["files"][line_id])
        except take_checks.CheckError as e:
            raise take_checks.CheckError(f"Could not read take {line_id}: {e}") from None
        y, info = trim_take(highpass(x), RATE)
        if not info["speech"]:
            silent.append(line_id)
            y = np.zeros(int(round(SILENT_PART_S * RATE)))   # never boosted
        y, stalls = tighten_stalls(y, RATE)
        for st in stalls:
            tightened.append({"id": line_id, "at_s": round(st["at_s"] + info["head_s"], 3),
                              "from_s": round(st["from_s"], 3),
                              "to_s": round(st["to_s"], 3)})
        parts[line_id] = y
        _progress((n + 1) / total, f"Processed take {line_id}")
    if silent and not args.allow_flagged:
        raise Refused("No speech found in takes: " + ", ".join(silent), silent=silent)

    clips, tight, clip_after = [], [], []
    n_inside = n_after = 0
    for c in plan["clips"]:
        ins = [list(inside_map.get(i, [])) for i in c["ids"]]
        aft = [after_map.get(i, 0.0) for i in c["ids"]]
        audio, found = build_clip([parts[i] for i in c["ids"]], inside=ins, after=aft[:-1])
        # The level is set on the clip as it is without its pauses (see level_clip).
        ref = None
        if any(ins) or any(aft[:-1]):
            ref = build_clip([parts[i] for i in c["ids"]])
        clips.append((c["clip"], level_clip(audio, ref=ref)))
        clip_after.append(aft[-1])
        n_inside += sum(len(p) for p in ins)
        # an after on the film's last line is never applied (no gap follows it)
        last_clip = c is plan["clips"][-1]
        n_after += sum(1 for a in (aft[:-1] if last_clip else aft) if a)
        for line_id, at_list in zip(c["ids"], found):
            tight += [{"id": line_id, "at_s": round(a, 3)} for a in at_list]
    x, timings = assemble(clips, [c["section"] for c in plan["clips"]], project=project,
                          title_hold_s=args.title_hold, after=clip_after)

    # Where each sentence part sits in the voiceover (build_clip and
    # level_clip keep lengths, so the offsets follow from the part lengths,
    # the silence inserted inside them and the gaps after them).
    placed = []
    for c, t in zip(plan["clips"], timings):
        pos = int(round(t["start_s"] * RATE))
        for k, line_id in enumerate(c["ids"]):
            added = sum(int(round(float(p["add_s"]) * RATE))
                        for p in inside_map.get(line_id, []))
            m = len(parts[line_id]) + added
            placed.append((line_id, x[pos:pos + m], pos / RATE))
            extra = after_map.get(line_id, 0.0) if k < len(c["ids"]) - 1 else 0.0
            pos += m + int(round((SENTENCE_GAP_S + extra) * RATE))

    if transcriber is None:
        transcriber = _make_transcriber(args)
    if not getattr(transcriber, "loaded", True):
        _progress(len(ids) / total, "Loading the speech model")
    transcript = transcript_for(
        placed, transcriber,
        on_part=lambda i, sid: _progress((len(ids) + i + 1) / total, f"Transcribed {sid}"))

    paths, moved = write_outputs(args.out, project, x, timings, transcript)
    done = {"done": True, "wav": paths["wav"], "csv": paths["csv"],
            "transcript": paths["transcript"], "length_s": round(len(x) / RATE, 3),
            "tightened": tightened, "extra": plan["extra"], "clips": len(clips),
            "silent": silent, "duplicates": plan["duplicates"], "moved_aside": moved,
            "tight": tight, "pauses": {"inside": n_inside, "after": n_after}}
    used = getattr(transcriber, "device_used", None)
    if used:
        done["transcribed_on"] = used
    return done


def main(argv=None, transcriber=None):
    """The command line. transcriber replaces whisper (tests). Returns the
    exit code: 0 done, 2 refused, 1 failed."""
    try:
        args = _parser().parse_args(sys.argv[1:] if argv is None else argv)
        _emit(join(args, transcriber))
        return 0
    except Refused as e:
        _emit({"error": str(e), **e.extra})
        return 2
    except SystemExit as e:   # argparse's own exits: --help, or an error
        if e.code in (0, None):
            return 0
        _emit({"error": "Bad arguments (see --help)"})
        return 2
    except take_checks.CheckError as e:
        _emit({"error": str(e)})
        return 1
    except OutputLocked as e:
        _emit({"error": str(e)})
        return 1
    except OSError as e:
        _emit({"error": f"Could not write the voiceover: {e}"})
        return 1
    except Exception as e:   # Studio reads stdout: always end with a JSON line
        _emit({"error": f"The join failed: {type(e).__name__}: {e}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
