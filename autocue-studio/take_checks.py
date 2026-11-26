"""Take checks for Autocue Studio's line mode.

Checks one saved take against its line: a cut-off ending, a word diff against
the line text, long pauses, clipping and the room's noise floor. No UI, no
sound; it only reads the WAV (through ffmpeg) and runs the transcriber.

    python take_checks.py <wav> "<line text>"

prints the result as JSON (useful for calibrating against known takes).

Thresholds (the voicestudio-narration skill's own, own-voice values):
  * voiced frame: a 10 ms frame above -24 dBFS with a zero-crossing rate < 0.12;
  * end of speech: the last voiced frame, ignoring a transient under 40 ms
    after it (the Space-key click);
  * cut-off: end of speech within 0.1 s of the file's end, or a one-frame drop
    of more than 18 dB at 5 ms resolution from above -48 dB at the end of
    speech, or the line's last word missing from (or ending at the end of)
    the transcript;
  * pause: a run quieter than -30 dBFS lasting 0.6 s or more between the
    first and last voiced frames;
  * clipping: any sample at full scale or a peak above -0.3 dBFS;
  * noise: the quietest 10 % of 50 ms frames above -55 dBFS.

The word checks use a looser "voice end": the last 10 ms frame above
max(-45 dBFS, noise + 12 dB), whatever its zero-crossing rate, again ignoring
a trailing transient under 40 ms. A soft last word after a pause sits below
-24 dBFS but is still the voice, so transcript words up to 0.25 s after the
voice end count, and the last-word cut-off test asks whether the voice (not
just the loud speech) ran to the end.
"""

import collections
import difflib
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys

import numpy as np

RATE = 16000
VERSION = 1

FRAME_S = 0.010
VOICED_DBFS = -24.0
VOICED_MAX_ZCR = 0.12
TRANSIENT_MAX_S = 0.040
CUT_OFF_TAIL_S = 0.1
DROP_RULE_MAX_TAIL_S = 0.3   # the 18 dB drop rule only applies this close to the end
HALLUCINATION_AFTER_S = 0.25 # transcript words starting this long after the voice
SAME_WORD_RATIO = 0.8        # one-for-one words this similar count as the same,
SAME_WORD_MIN_LEN = 5        # ...when both have at least this many letters
FFMPEG_TIMEOUT_S = 60
DROP_FRAME_S = 0.005
DROP_DB = 18.0
DROP_FROM_DBFS = -48.0
PAUSE_DBFS = -30.0
PAUSE_MIN_S = 0.6
CLIP_PEAK_DBFS = -0.3
NOISE_FRAME_S = 0.050
NOISE_FRACTION = 0.10
NOISE_MAX_DBFS = -55.0
FLOOR_DBFS = -120.0
VOICE_MIN_DBFS = -45.0       # the voice end: above this...
VOICE_OVER_NOISE_DB = 12.0   # ...and this far above the room's noise

ORDER = ("cut_off", "misread", "clipping", "pause", "noise")
SEVERE = {"cut_off", "misread", "clipping"}

SETTINGS_FILE = "autocue_settings.json"
DEFAULT_SETTINGS = {"check_model": "medium.en", "check_device": "auto"}


class CheckError(Exception):
    """A check could not run (ffmpeg missing, unreadable take, no model)."""


def flag(kind, text, at_s=None):
    return {"kind": kind, "text": text,
            "at_s": None if at_s is None else round(float(at_s), 2)}


# ---------------------------------------------------------------- decoding ----

def _ffmpeg():
    exe = shutil.which("ffmpeg")
    if not exe:
        raise CheckError("ffmpeg not found")
    return exe


def _run_ffmpeg(args, path):
    cmd = [_ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", "error",
           "-i", path] + args + ["-"]
    try:
        proc = subprocess.run(
            cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=FFMPEG_TIMEOUT_S,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired:
        raise CheckError(f"ffmpeg timed out reading {os.path.basename(path)}") from None
    except FileNotFoundError:
        raise CheckError("ffmpeg not found") from None
    except OSError as e:
        raise CheckError(f"ffmpeg failed: {e}") from None
    if proc.returncode != 0:
        lines = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        reason = lines[-1] if lines else f"exit code {proc.returncode}"
        raise CheckError(f"ffmpeg could not read {os.path.basename(path)}: {reason}")
    return proc.stdout


def decode(path):
    """The take as mono float32 at 16 kHz: (samples, 16000)."""
    raw = _run_ffmpeg(["-ac", "1", "-ar", str(RATE), "-f", "f32le"], path)
    return np.frombuffer(raw, dtype="<f4").astype(np.float32), RATE


Decoded = collections.namedtuple(
    "Decoded", "samples rate peak_dbfs clipped native native_rate")


def _parse_wav(data):
    """(int16 samples as a (frames, channels) array, rate) from ffmpeg's
    piped 16-bit WAV. The sizes in a piped header can't be trusted, so the
    data chunk runs to the end of the bytes."""
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise CheckError("ffmpeg gave no WAV data")
    pos, channels, rate = 12, None, None
    while pos + 8 <= len(data):
        cid, size = data[pos:pos + 4], struct.unpack("<I", data[pos + 4:pos + 8])[0]
        body = pos + 8
        if cid == b"fmt ":
            channels, rate = struct.unpack("<HI", data[body + 2:body + 8])
        elif cid == b"data":
            if not channels or not rate:
                break
            pcm = data[body:]
            pcm = pcm[:len(pcm) - len(pcm) % (2 * channels)]
            return np.frombuffer(pcm, dtype="<i2").reshape(-1, channels), int(rate)
        pos = body + size + (size & 1)
    raise CheckError("ffmpeg gave no WAV data")


def decode_with_peak(path):
    """Decoded(samples, 16000, peak_dbfs, clipped, native, native_rate).
    samples is the 16 kHz float decode for the transcriber; native is the
    take itself as mono float32 (s16le / 32768) at its own rate, for the
    audio checks. The peak is read from the original 16-bit samples, since
    resampling moves peaks."""
    samples, rate = decode(path)
    raw, native_rate = _parse_wav(_run_ffmpeg(["-c:a", "pcm_s16le", "-f", "wav"], path))
    if raw.size:
        hi, lo = int(raw.max()), int(raw.min())
        peak = max(abs(hi), abs(lo))
        full_scale = hi >= 32767 or lo <= -32768
    else:
        peak, full_scale = 0, False
    native = (raw.astype(np.float32).mean(axis=1) / np.float32(32768.0)).astype(np.float32)
    peak_dbfs = _db_amp(peak / 32768.0)
    return Decoded(samples, rate, peak_dbfs, bool(full_scale or peak_dbfs > CLIP_PEAK_DBFS),
                   native, native_rate)


# ---------------------------------------------------------------- analysis ----

def _db_amp(a):
    return 20.0 * math.log10(a) if a > 0 else FLOOR_DBFS


def _frames(x, n):
    count = len(x) // n
    return x[:count * n].reshape(count, n) if count else np.zeros((0, n), x.dtype)


def _frame_db(frames):
    power = np.mean(frames.astype(np.float64) ** 2, axis=1)
    return 10.0 * np.log10(np.maximum(power, 10 ** (FLOOR_DBFS / 10)))


def _zcr(frames):
    if frames.shape[1] < 2:
        return np.zeros(len(frames))
    s = np.signbit(frames)
    return np.mean(s[:, 1:] != s[:, :-1], axis=1)


def _runs(mask):
    """[(start, end)) index runs where mask is true."""
    if not len(mask):
        return []
    m = np.concatenate(([False], np.asarray(mask, bool), [False]))
    edges = np.flatnonzero(m[1:] != m[:-1])
    return list(zip(edges[::2].tolist(), edges[1::2].tolist()))


def _clean_word(w):
    return w.strip().strip(".,;:!?\"'()[]“”‘’…-–—")


def _word_before(words, t):
    """The word a pause at t comes after: the last word starting before t.
    (Whisper stretches the previous word into a silence, so word starts are
    what to trust.)"""
    before = [w for w, start, _ in words or () if start < t]
    return _clean_word(before[-1]) if before else None


def _speech_end(voiced, loud, frame_s):
    """Index (exclusive) of the end of speech in 10 ms frames, or None.
    A trailing loud run shorter than 40 ms after a quiet gap is a transient
    (the Space-key click), not speech."""
    runs = _runs(voiced)
    loud_runs = _runs(loud)
    max_frames = int(round(TRANSIENT_MAX_S / frame_s))
    while runs:
        start, end = runs[-1]
        span = next(((a, b) for a, b in loud_runs if a <= start < b), (start, end))
        has_speech_before = len(runs) > 1
        if has_speech_before and span[1] - span[0] < max_frames:
            runs.pop()
            continue
        return end
    return None


def analyse(samples, rate, peak_dbfs=None, clipped=None, words=None):
    """Audio-only checks. Returns duration_s, peak_dbfs, noise_dbfs,
    speech_end_s, voice_end_s and flags (cut_off by energy, clipping, pause, noise).
    peak_dbfs/clipped come from decode_with_peak when known; words, if given,
    name the word before each pause."""
    x = np.asarray(samples, dtype=np.float32)
    duration = len(x) / float(rate)
    flags = []

    if peak_dbfs is None:
        peak = float(np.max(np.abs(x))) if len(x) else 0.0
        peak_dbfs = _db_amp(peak)
        clipped = peak >= 32767 / 32768.0 or peak_dbfs > CLIP_PEAK_DBFS
    if clipped:
        at = float(np.argmax(np.abs(x))) / rate if len(x) else None
        flags.append(flag("clipping", "clipping: re-record a little quieter", at))

    # Noise floor: the quietest 10 % of 50 ms frames.
    n50 = max(1, int(round(NOISE_FRAME_S * rate)))
    f50 = _frames(x, n50)
    if len(f50):
        power = np.sort(np.mean(f50.astype(np.float64) ** 2, axis=1))
        k = max(1, int(len(power) * NOISE_FRACTION))
        p = float(np.mean(power[:k]))
        noise_dbfs = 10 * math.log10(p) if p > 0 else FLOOR_DBFS
    else:
        noise_dbfs = FLOOR_DBFS
    noise_dbfs = max(noise_dbfs, FLOOR_DBFS)

    # 10 ms frames: voiced speech and its end.
    n10 = max(1, int(round(FRAME_S * rate)))
    f10 = _frames(x, n10)
    db10 = _frame_db(f10)
    loud = db10 > VOICED_DBFS
    voiced = loud & (_zcr(f10) < VOICED_MAX_ZCR)
    end_idx = _speech_end(voiced, loud, FRAME_S)
    speech_end_s = None
    voice_end_s = None
    voice = db10 > max(VOICE_MIN_DBFS, noise_dbfs + VOICE_OVER_NOISE_DB)
    voice_idx = _speech_end(voice, voice, FRAME_S)
    if voice_idx is not None:
        voice_end_s = voice_idx * n10 / float(rate)
    if end_idx is not None:
        speech_end_s = end_idx * n10 / float(rate)
        tail = duration - speech_end_s
        if tail < CUT_OFF_TAIL_S or (tail <= DROP_RULE_MAX_TAIL_S
                                     and _sharp_drop(x, rate, speech_end_s)):
            flags.append(flag("cut_off", "ends too abruptly", speech_end_s))

        # Pauses between the first voiced frame and the end of speech.
        first = int(np.argmax(voiced))
        quiet = db10 < PAUSE_DBFS
        quiet[:first] = False
        quiet[end_idx:] = False
        min_frames = int(math.ceil(PAUSE_MIN_S * rate / n10 - 1e-9))
        for a, b in _runs(quiet):
            if b - a >= min_frames and b < end_idx:
                start_s, length = a * n10 / rate, (b - a) * n10 / rate
                w = _word_before(words, start_s + length / 2)
                text = f"pause of {length:.1f} s" + (f' after "{w}"' if w else "")
                flags.append(flag("pause", text, start_s))

    if noise_dbfs > NOISE_MAX_DBFS:
        flags.append(flag("noise", f"room noise at {round(noise_dbfs)} dBFS"))
    if speech_end_s is not None and (voice_end_s is None or voice_end_s < speech_end_s):
        voice_end_s = speech_end_s   # a very noisy room: never before the speech

    return {
        "duration_s": round(duration, 3),
        "peak_dbfs": round(max(peak_dbfs, FLOOR_DBFS), 1),
        "noise_dbfs": round(noise_dbfs, 1),
        "speech_end_s": None if speech_end_s is None else round(speech_end_s, 3),
        "voice_end_s": None if voice_end_s is None else round(voice_end_s, 3),
        "flags": flags,
    }


def _sharp_drop(x, rate, speech_end_s):
    """A one-frame drop of more than 18 dB at 5 ms resolution, from above
    -48 dB, at the end of speech: the voice stopped dead."""
    n5 = max(1, int(round(DROP_FRAME_S * rate)))
    db5 = _frame_db(_frames(x, n5))
    end = int(round(speech_end_s * rate / n5))
    lo, hi = max(0, end - 4), min(len(db5) - 1, end + 6)
    for i in range(lo, hi):
        if db5[i] > DROP_FROM_DBFS and db5[i] - db5[i + 1] > DROP_DB:
            return True
    return False


# ------------------------------------------------------------- the words ----

_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
         "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
         "sixteen", "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
         "eighty", "ninety"]
_ORDINALS = {
    "one": "first", "two": "second", "three": "third", "five": "fifth",
    "eight": "eighth", "nine": "ninth", "twelve": "twelfth",
}
_NUMBER_WORDS = set(_ONES) | set(_TENS[2:]) | {"hundred", "thousand"}


def _under_100(n):
    if n < 20:
        return [_ONES[n]]
    tens, ones = divmod(n, 10)
    return [_TENS[tens]] + ([_ONES[ones]] if ones else [])


def _cardinal(n):
    """0-9999 in words, British style but without "and" (it is dropped from
    numbers before comparing): 320 -> three hundred twenty."""
    if n < 100:
        return _under_100(n)
    out = []
    thousands, rest = divmod(n, 1000)
    if thousands:
        out += _under_100(thousands) + ["thousand"]
    hundreds, rest = divmod(rest, 100)
    if hundreds:
        out += [_ONES[hundreds], "hundred"]
    if rest:
        out += _under_100(rest)
    return out


def _year_or_number(n):
    """4-digit years read as pairs: 1854 -> eighteen fifty four, 1900 ->
    nineteen hundred, 1905 -> nineteen oh five, 2013 -> twenty thirteen;
    2000-2009 -> two thousand (and) five."""
    if 1100 <= n <= 1999 or 2010 <= n <= 2099:
        hi, lo = divmod(n, 100)
        if lo == 0:
            return _under_100(hi) + ["hundred"]
        if lo < 10:
            return _under_100(hi) + ["oh", _ONES[lo]]
        return _under_100(hi) + _under_100(lo)
    return _cardinal(n)


def _ordinal(n):
    words = _cardinal(n)
    last = words[-1]
    if last in _ORDINALS:
        words[-1] = _ORDINALS[last]
    elif last.endswith("y"):
        words[-1] = last[:-1] + "ieth"
    else:
        words[-1] = last + "th"
    return words


_ORDINAL_RE = re.compile(r"^(\d{1,2})(st|nd|rd|th)$")
_INT_RE = re.compile(r"^\d+$")
_PUNCT_RE = re.compile(r"[^\w']+")


def _expand(token):
    m = _ORDINAL_RE.match(token)
    if m and 1 <= int(m.group(1)) <= 31:
        return _ordinal(int(m.group(1)))
    if _INT_RE.match(token):
        n = int(token)
        if len(token) == 4 and token[0] != "0":
            return _year_or_number(n)
        if n <= 9999:
            return _cardinal(n)
        return [_ONES[int(d)] for d in token]  # long numbers: digit by digit
    return [token]


def _tokens(word):
    """Normalised pieces of one written or spoken word."""
    w = word.lower().replace("’", "'").replace("‘", "'")
    w = w.replace("%", " percent ")
    out = []
    bare = w.strip(".,;:!?\"'()[]")
    if re.match(r"^\d{1,3}(,\d{3})+$", bare):        # 1,200 is a count, not a year
        n = int(bare.replace(",", ""))
        return _cardinal(n) if n <= 9999 else [_ONES[int(d)] for d in str(n)]
    for piece in re.split(r"[-‐-―/]+", w):     # hyphens and dashes
        for part in _PUNCT_RE.split(piece):
            part = part.strip("'_")
            if part:
                out.extend(_expand(part))
    return out


def _drop_number_and(tokens):
    """Remove "and" inside a number ("three hundred and twenty") so it matches
    the digits; an ordinary "and" stays a word to check."""
    keep = []
    for i, t in enumerate(tokens):
        if (t == "and" and keep and keep[-1] in ("hundred", "thousand")
                and i + 1 < len(tokens) and tokens[i + 1] in _NUMBER_WORDS):
            continue
        keep.append(t)
    return keep


def _spoken_lines(text):
    """The line text without pronunciation notes (lines starting with ">")."""
    return " ".join(l for l in text.splitlines() if not l.lstrip().startswith(">"))


def normalise_words(text):
    """Lower case, no punctuation, numbers in words, hyphens split."""
    out = []
    for word in _spoken_lines(text).split():
        out.extend(_tokens(word))
    return _drop_number_and(out)


def _without_number_and(items):
    """items are tuples whose first field is the token; drop "and" inside numbers."""
    keep = _drop_number_and([t[0] for t in items])
    out, j = [], 0
    for t in items:
        if j < len(keep) and t[0] == keep[j]:
            out.append(t)
            j += 1
    return out


# Comparing: numbers by value, British and American spellings alike.

_UNITS = {w: i for i, w in enumerate(_ONES)}
_TENS_VAL = {w: 10 * i for i, w in enumerate(_TENS) if w}


def _parse_under_100(t, i):
    """(value, next index) for 0-99 at t[i], or None."""
    if i < len(t) and t[i] in _TENS_VAL:
        v = _TENS_VAL[t[i]]
        if i + 1 < len(t) and t[i + 1] in _UNITS and 1 <= _UNITS[t[i + 1]] <= 9:
            return v + _UNITS[t[i + 1]], i + 2
        return v, i + 1
    if i < len(t) and t[i] in _UNITS:
        return _UNITS[t[i]], i + 1
    return None


def _parse_cardinal(t):
    """The whole of t as a cardinal (one thousand five hundred, fifteen
    hundred, forty seven), or None."""
    i, total = 0, 0
    first = _parse_under_100(t, 0)
    if first is None:
        return None
    v, i = first
    if i < len(t) and t[i] == "thousand":
        if v == 0:
            return None
        total, i = v * 1000, i + 1
        nxt = _parse_under_100(t, i)
        if nxt is None:
            return total if i == len(t) else None
        v, i = nxt
    if i < len(t) and t[i] == "hundred":
        if v == 0 or (total and v > 9):
            return None
        total, i = total + v * 100, i + 1
        nxt = _parse_under_100(t, i)
        if nxt is None:
            return total if i == len(t) else None
        v, i = nxt
    if total and v == 0:
        return None
    return total + v if i == len(t) else None


def _parse_year(t):
    """The whole of t as a year reading (eighteen fifty four, nineteen oh
    five, twenty thirteen), or None."""
    hi = _parse_under_100(t, 0)
    if hi is None or hi[0] < 11:
        return None
    v, i = hi
    rest = t[i:]
    if rest == ["hundred"]:
        return v * 100
    if len(rest) == 2 and rest[0] == "oh" and rest[1] in _UNITS and 1 <= _UNITS[rest[1]] <= 9:
        return v * 100 + _UNITS[rest[1]]
    lo = _parse_under_100(rest, 0)
    if lo and lo[1] == len(rest) and lo[0] >= 10:
        return v * 100 + lo[0]
    return None


_NUM_START = set(_UNITS) | set(_TENS_VAL)
_NUM_ANY = _NUM_START | {"hundred", "thousand", "oh"}


def _parse_number(t):
    v = _parse_cardinal(t)
    return v if v is not None else _parse_year(t)


def _collapse_numbers(items):
    """Runs of number words become one token holding the value, so 1500,
    1,500, fifteen hundred and one thousand five hundred all compare equal."""
    out, i = [], 0
    while i < len(items):
        if items[i][0] in _NUM_START:
            j = i
            while j < len(items) and items[j][0] in _NUM_ANY:
                j += 1
            for k in range(j, i, -1):
                v = _parse_number([t[0] for t in items[i:k]])
                if v is not None:
                    run = items[i:k]
                    shown = []
                    for t in run:
                        if not shown or shown[-1] != t[1]:
                            shown.append(t[1])
                    out.append((f"#{v}", " ".join(shown)) + tuple(_span(run)))
                    i = k
                    break
            else:
                out.append(items[i])
                i += 1
        else:
            out.append(items[i])
            i += 1
    return out


def _span(run):
    """(start, end) of a run of timed items; nothing for untimed ones."""
    return (run[0][2], run[-1][3]) if len(run[0]) > 2 else ()


_SPELLING = {
    "grey": "gray", "greys": "grays", "greyish": "grayish",
    "programme": "program", "programmes": "programs",
    "defence": "defense", "defences": "defenses", "offence": "offense",
    "offences": "offenses", "licence": "license", "licences": "licenses",
    "pretence": "pretense", "fuelled": "fueled", "fuelling": "fueling",
    "jewellery": "jewelry", "aluminium": "aluminum", "plough": "plow",
    "ploughed": "plowed", "storey": "story", "storeys": "stories",
    "manoeuvre": "maneuver", "manoeuvres": "maneuvers", "kerb": "curb",
}
_OUR_RE = re.compile(r"^(\w{2,})our(s|ed|ing|ite|ites|able|ably|er|ers|ful|hood|hoods|less|ist|ists)?$")
_ISE_RE = re.compile(r"^(\w{3,})is(e|es|ed|ing|er|ers|ation|ations|ational)$")
_RE_RE = re.compile(r"^(\w{2,}[bgt])re(s)?$")
_LL_RE = re.compile(r"^(\w*[aeiou]\w*?[aeiou]\w*?)ll(ed|ing|er|ers|or|ors)$")


def _spelling(tok):
    """One spelling for British and American forms (both sides go through it,
    so only collisions between real words matter)."""
    if tok.startswith("#"):
        return tok
    if tok in _SPELLING:
        return _SPELLING[tok]
    m = _OUR_RE.match(tok)
    if m:
        return f"{m.group(1)}or{m.group(2) or ''}"
    m = _ISE_RE.match(tok)
    if m:
        return f"{m.group(1)}iz{m.group(2)}"
    m = _RE_RE.match(tok)
    if m:
        return f"{m.group(1)}er{m.group(2) or ''}"
    m = _LL_RE.match(tok)
    if m and re.search(r"[aeiou][^aeiou]+[aeiou]", m.group(1)):
        return f"{m.group(1)}l{m.group(2)}"
    return tok


def _compare_form(items):
    items = _collapse_numbers(_without_number_and(items))
    out, i = [], 0
    while i < len(items):              # "per cent" -> "percent"
        if (items[i][0] == "per" and i + 1 < len(items) and items[i + 1][0] == "cent"):
            run = items[i:i + 2]
            out.append(("percent", f"{run[0][1]} {run[1][1]}") + tuple(_span(run)))
            i += 2
            continue
        out.append(items[i])
        i += 1
    return [(_spelling(t[0]),) + tuple(t[1:]) for t in out]


def _pieces(word):
    """[(token, display)] for one word; every piece shows the word as written."""
    shown = _clean_word(word)
    return [(p, shown) for p in _tokens(word)]


def _timed_tokens(words):
    """[(token, display, start, end)] for the transcript's words."""
    return _compare_form([(p, d, float(s), float(e))
                          for w, s, e in words for p, d in _pieces(w)])


def _expected_tokens(text):
    """[(token, display)] for the line, keeping the line's own spelling."""
    return _compare_form([pd for w in _spoken_lines(text).split() for pd in _pieces(w)])


def _quote(items):
    shown = []
    for d in items:
        if not shown or shown[-1] != d:
            shown.append(d)
    return " ".join(shown)


def _same_words(a, b):
    """A replacement that is really the same words: joined differently
    ("co operate" / "cooperate") or one near-identical word of 5+ letters
    (ratio >= 0.8); short swaps (the/them, to/too) stay misreads."""
    if "".join(a) == "".join(b):
        return True
    if (len(a) == 1 and len(b) == 1 and not (a[0].startswith("#") or b[0].startswith("#"))
            and min(len(a[0]), len(b[0])) >= SAME_WORD_MIN_LEN):
        return difflib.SequenceMatcher(None, a[0], b[0]).ratio() >= SAME_WORD_RATIO
    return False


def word_flags(expected_text, transcript_words, audio_end_s, voice_end_s=None):
    """misread flags (misread, missed, added words) from a word diff of the
    line against the transcript, plus a cut_off flag when the line's last word
    is missing, or ends within 0.1 s of the end of the audio while the voice
    itself (voice_end_s, from analyse) also ends within 0.3 s of it.

    Transcript words starting more than 0.25 s after voice_end_s are
    ignored (Whisper's tail hallucinations, "Thank you.")."""
    words = list(transcript_words or [])
    if voice_end_s is not None:
        words = [w for w in words if w[1] <= voice_end_s + HALLUCINATION_AFTER_S]
    exp = _expected_tokens(expected_text)
    got = _timed_tokens(words)
    a, b = [t[0] for t in exp], [t[0] for t in got]
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    flags = []
    last_missing = False
    last_match = None              # the transcript item heard as the last word
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal" or (op == "replace" and _same_words(a[i1:i2], b[j1:j2])):
            if i2 == len(exp):
                last_match = got[j2 - 1]
            continue
        said = [t[1] for t in got[j1:j2]]
        meant = [t[1] for t in exp[i1:i2]]
        if op == "replace":
            flags.append(flag("misread", f'may have misread: "{_quote(said)}" for '
                                         f'"{_quote(meant)}"', got[j1][2]))
        elif op == "delete":
            if i2 == len(exp) and j1 == len(got):
                last_missing = True        # the end of the line never came
                if i2 - i1 == 1:
                    continue               # the cut_off says it
                meant = [t[1] for t in exp[i1:i2 - 1]]
            at = got[j1 - 1][3] if j1 > 0 else 0.0
            flags.append(flag("misread", f'may have missed "{_quote(meant)}"', at))
        elif op == "insert":
            flags.append(flag("misread", f'may have added "{_quote(said)}"', got[j1][2]))

    if exp:
        voice_near_end = (voice_end_s is None
                          or audio_end_s - voice_end_s <= DROP_RULE_MAX_TAIL_S)
        word_at_end = (last_match is not None and voice_near_end
                       and audio_end_s - last_match[3] < CUT_OFF_TAIL_S)
        if last_missing or word_at_end:
            at = last_match[3] if last_match else (got[-1][3] if got else None)
            flags.insert(0, flag("cut_off", f'last word "{exp[-1][1]}" cut off', at))
    return flags


# ---------------------------------------------------------- the transcriber ----

class Transcriber:
    """Protocol: transcribe(samples, rate) -> (text, [(word, start_s, end_s)])."""

    def transcribe(self, samples, rate):  # pragma: no cover - interface
        raise NotImplementedError


CUDA_PROBE_TIMEOUT_S = 180
CUDA_PROBE_MODEL = "tiny.en"


def probe_cuda(run=None, timeout=CUDA_PROBE_TIMEOUT_S):
    """True if faster-whisper can load and run a model on CUDA, tried in a
    child process: a broken CUDA/cuDNN install can crash the process inside
    ctranslate2, and that must not be Autocue Studio. Any failure, crash or
    timeout is False."""
    run = run or subprocess.run
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # Windows only
    try:
        done = run([sys.executable, os.path.abspath(__file__), "--probe-cuda"],
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=timeout, creationflags=flags)
    except (OSError, subprocess.SubprocessError, ValueError):
        return False
    return done.returncode == 0


def _probe_cuda_main():
    """The child side of probe_cuda: exit 0 only if CUDA really works."""
    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(CUDA_PROBE_MODEL, device="cuda", compute_type="float16")
        segments, _info = model.transcribe(np.zeros(RATE, dtype=np.float32), language="en")
        list(segments)
    except Exception:
        return 1
    return 0


class WhisperTranscriber(Transcriber):
    """faster-whisper, loaded on first use. device "auto" tries CUDA, then CPU
    int8. Any import or load failure is a CheckError("Checks unavailable: …").
    In "auto", CUDA is only tried if probe() (a child-process trial run,
    once per session) says it works; otherwise it goes straight to the CPU."""

    def __init__(self, model="medium.en", device="auto", probe=None):
        self.model_name = model or DEFAULT_SETTINGS["check_model"]
        self.device = (device or "auto").lower()
        self._probe = probe or probe_cuda
        self._cuda_works = None  # unknown until probed
        self._model = None
        self._on_cuda = False
        self._load_error = None

    def reset(self):
        """Forget a failed load (or the loaded model) so the next use retries."""
        self._model = None
        self._on_cuda = False
        self._load_error = None

    @property
    def loaded(self):
        return self._model is not None

    def _attempts(self):
        if self.device == "cuda":
            return [("cuda", "float16")]
        if self.device == "cpu":
            return [("cpu", "int8")]
        if self._cuda_works is None:
            self._cuda_works = bool(self._probe())
        if self._cuda_works:
            return [("cuda", "float16"), ("cpu", "int8")]
        return [("cpu", "int8")]

    def load(self):
        if self._model is not None:
            return
        if self._load_error is not None:     # don't re-download on every take
            raise CheckError(str(self._load_error))
        try:
            from faster_whisper import WhisperModel
        except Exception as e:  # ImportError, or a broken install
            self._load_error = CheckError(
                f"Checks unavailable: faster-whisper is not installed ({e})")
            raise CheckError(str(self._load_error)) from None
        err = None
        for device, compute in self._attempts():
            try:
                self._model = WhisperModel(self.model_name, device=device,
                                           compute_type=compute)
                self._on_cuda = device == "cuda"
                return
            except Exception as e:
                err = e
        self._load_error = CheckError(f"Checks unavailable: could not load the speech "
                                      f"model {self.model_name} ({err})")
        raise CheckError(str(self._load_error))

    def _run(self, samples):
        segments, _info = self._model.transcribe(
            samples, language="en", beam_size=5, word_timestamps=True,
            condition_on_previous_text=False)
        segments = list(segments)
        text = " ".join(s.text.strip() for s in segments).strip()
        words = [(w.word.strip(), float(w.start), float(w.end))
                 for s in segments for w in (s.words or [])]
        return text, words

    def transcribe(self, samples, rate):
        if rate != RATE:
            raise CheckError(f"transcriber needs {RATE} Hz audio, got {rate}")
        self.load()
        samples = np.asarray(samples, dtype=np.float32)
        try:
            return self._run(samples)
        except Exception as e:
            # CUDA can load and then fail on first use (missing cuDNN DLLs).
            if not (self._on_cuda and self.device == "auto"):
                raise CheckError(f"transcription failed: {e}") from None
            self._model = None
            self.device = "cpu"
            self.load()
        try:
            return self._run(samples)
        except Exception as e:
            raise CheckError(f"transcription failed on the CPU: {e}") from None


# --------------------------------------------------------------- the check ----

def order_flags(flags):
    """Display order (cut_off, misread, clipping, pause, noise), duplicates
    removed and at most one cut_off (one naming the word is preferred)."""
    seen, out = set(), []
    for f in flags:
        key = (f["kind"], f["text"], f.get("at_s"))
        if key not in seen:
            seen.add(key)
            out.append(f)
    cut = [f for f in out if f["kind"] == "cut_off"]
    if len(cut) > 1:
        keep = next((f for f in cut if f["text"].startswith("last word")), cut[0])
        out = [f for f in out if f["kind"] != "cut_off" or f is keep]
    rank = {k: i for i, k in enumerate(ORDER)}
    return sorted(out, key=lambda f: rank.get(f["kind"], len(ORDER)))


def check_take(path, line_text, transcriber):
    """Check one take. Returns the result body (without id, file, checked_at
    and take_mtime): ok, flags, transcript, duration_s, peak_dbfs, noise_dbfs,
    version."""
    d = decode_with_peak(path)
    text, words = transcriber.transcribe(d.samples, d.rate)
    words = [(str(w), float(s), float(e)) for w, s, e in (words or [])]
    audio = analyse(d.native, d.native_rate, peak_dbfs=d.peak_dbfs, clipped=d.clipped,
                    words=words)
    flags = order_flags(audio["flags"] + word_flags(line_text, words, audio["duration_s"],
                                                      voice_end_s=audio["voice_end_s"]))
    return {
        "ok": not any(f["kind"] in SEVERE for f in flags),
        "flags": flags,
        "transcript": (text or "").strip(),
        "duration_s": audio["duration_s"],
        "peak_dbfs": audio["peak_dbfs"],
        "noise_dbfs": audio["noise_dbfs"],
        "version": VERSION,
    }


# -------------------------------------------------------------- settings/CLI ----

def load_settings(app_dir):
    """autocue_settings.json in app_dir; missing or bad JSON gives the defaults."""
    settings = dict(DEFAULT_SETTINGS)
    try:
        with open(os.path.join(app_dir, SETTINGS_FILE), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return settings
    if isinstance(data, dict):
        for key in DEFAULT_SETTINGS:
            if isinstance(data.get(key), str) and data[key].strip():
                settings[key] = data[key].strip()
    return settings


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv == ["--probe-cuda"]:
        return _probe_cuda_main()
    if len(argv) != 2:
        print('usage: python take_checks.py <wav> "<line text>"', file=sys.stderr)
        return 2
    settings = load_settings(os.path.dirname(os.path.abspath(__file__)))
    transcriber = WhisperTranscriber(settings["check_model"], settings["check_device"])
    try:
        result = check_take(argv[0], argv[1], transcriber)
    except CheckError as e:
        print(str(e), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
