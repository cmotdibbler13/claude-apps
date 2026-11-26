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
"""

import difflib
import json
import math
import os
import re
import shutil
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
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
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


def decode_with_peak(path):
    """(samples, 16000, peak_dbfs, clipped). The peak is read from the original
    16-bit samples at their own rate, since resampling moves peaks."""
    samples, rate = decode(path)
    raw = np.frombuffer(_run_ffmpeg(["-f", "s16le"], path), dtype="<i2")
    if raw.size:
        hi, lo = int(raw.max()), int(raw.min())
        peak = max(abs(hi), abs(lo))
        full_scale = hi >= 32767 or lo <= -32768
    else:
        peak, full_scale = 0, False
    peak_dbfs = _db_amp(peak / 32768.0)
    return samples, rate, peak_dbfs, bool(full_scale or peak_dbfs > CLIP_PEAK_DBFS)


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
    speech_end_s and flags (cut_off by energy, clipping, pause, noise).
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

    # 10 ms frames: voiced speech and its end.
    n10 = max(1, int(round(FRAME_S * rate)))
    f10 = _frames(x, n10)
    db10 = _frame_db(f10)
    loud = db10 > VOICED_DBFS
    voiced = loud & (_zcr(f10) < VOICED_MAX_ZCR)
    end_idx = _speech_end(voiced, loud, FRAME_S)
    speech_end_s = None
    if end_idx is not None:
        speech_end_s = end_idx * n10 / float(rate)
        if duration - speech_end_s < CUT_OFF_TAIL_S or _sharp_drop(x, rate, speech_end_s):
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
    if noise_dbfs > NOISE_MAX_DBFS:
        flags.append(flag("noise", f"room noise at {round(noise_dbfs)} dBFS"))

    return {
        "duration_s": round(duration, 3),
        "peak_dbfs": round(max(peak_dbfs, FLOOR_DBFS), 1),
        "noise_dbfs": round(noise_dbfs, 1),
        "speech_end_s": None if speech_end_s is None else round(speech_end_s, 3),
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


def _pieces(word):
    """[(token, display)] for one word: the word's own spelling is shown when
    it is a single token, otherwise the expanded token (1854 -> eighteen ...)."""
    pieces = _tokens(word)
    shown = _clean_word(word)
    return [(p, shown if len(pieces) == 1 else p) for p in pieces]


def _timed_tokens(words):
    """[(token, display, start, end)] for the transcript's words."""
    return _without_number_and([(p, d, float(s), float(e))
                                for w, s, e in words for p, d in _pieces(w)])


def _expected_tokens(text):
    """[(token, display)] for the line, keeping the line's own spelling."""
    return _without_number_and([pd for w in _spoken_lines(text).split()
                                for pd in _pieces(w)])


def _quote(items):
    return " ".join(items)


def word_flags(expected_text, transcript_words, audio_end_s):
    """misread flags (misread, missed, added words) from a word diff of the
    line against the transcript, plus a cut_off flag when the line's last word
    is missing or ends within 0.1 s of the end of the audio."""
    exp = _expected_tokens(expected_text)
    got = _timed_tokens(transcript_words or [])
    a, b = [t[0] for t in exp], [t[0] for t in got]
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    flags = []
    last_missing = False
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
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
                meant = meant[:-1]
            at = got[j1 - 1][3] if j1 > 0 else 0.0
            flags.append(flag("misread", f'may have missed "{_quote(meant)}"', at))
        elif op == "insert":
            flags.append(flag("misread", f'may have added "{_quote(said)}"', got[j1][2]))

    if exp:
        last_end = got[-1][3] if got else 0.0
        if last_missing or (got and audio_end_s - last_end < CUT_OFF_TAIL_S):
            flags.insert(0, flag("cut_off", f'last word "{exp[-1][1]}" cut off',
                                 last_end if got else None))
    return flags


# ---------------------------------------------------------- the transcriber ----

class Transcriber:
    """Protocol: transcribe(samples, rate) -> (text, [(word, start_s, end_s)])."""

    def transcribe(self, samples, rate):  # pragma: no cover - interface
        raise NotImplementedError


class WhisperTranscriber(Transcriber):
    """faster-whisper, loaded on first use. device "auto" tries CUDA, then CPU
    int8. Any import or load failure is a CheckError("Checks unavailable: …")."""

    def __init__(self, model="medium.en", device="auto"):
        self.model_name = model or DEFAULT_SETTINGS["check_model"]
        self.device = (device or "auto").lower()
        self._model = None
        self._on_cuda = False

    @property
    def loaded(self):
        return self._model is not None

    def _attempts(self):
        if self.device == "cuda":
            return [("cuda", "float16")]
        if self.device == "cpu":
            return [("cpu", "int8")]
        return [("cuda", "float16"), ("cpu", "int8")]

    def load(self):
        if self._model is not None:
            return
        try:
            from faster_whisper import WhisperModel
        except Exception as e:  # ImportError, or a broken install
            raise CheckError(f"Checks unavailable: faster-whisper is not installed ({e})") from None
        err = None
        for device, compute in self._attempts():
            try:
                self._model = WhisperModel(self.model_name, device=device,
                                           compute_type=compute)
                self._on_cuda = device == "cuda"
                return
            except Exception as e:
                err = e
        raise CheckError(f"Checks unavailable: could not load the speech model "
                         f"{self.model_name} ({err})")

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
            if self._on_cuda and self.device == "auto":
                self._model = None
                self.device = "cpu"
                self.load()
                return self._run(samples)
            raise CheckError(f"transcription failed: {e}") from None


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
    samples, rate, peak_dbfs, clipped = decode_with_peak(path)
    text, words = transcriber.transcribe(samples, rate)
    words = [(str(w), float(s), float(e)) for w, s, e in (words or [])]
    audio = analyse(samples, rate, peak_dbfs=peak_dbfs, clipped=clipped, words=words)
    flags = order_flags(audio["flags"] + word_flags(line_text, words, audio["duration_s"]))
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
