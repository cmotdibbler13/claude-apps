"""Tests for take_checks: synthetic audio and a stub transcriber, no voices."""

import os
import tempfile
import unittest
import wave
from unittest import mock

import numpy as np

import take_checks
from take_checks import CheckError

RATE = 44100  # like real takes: 44.1 kHz 16-bit mono
_rng = np.random.default_rng(1234)


# ---------------------------------------------------------------- signals ----

def room(seconds, dbfs=-60.0):
    """White-noise room tone at an RMS level in dBFS."""
    n = int(round(seconds * RATE))
    return _rng.standard_normal(n) * (10 ** (dbfs / 20.0))


def word(seconds, amp=0.3):
    """A speech-like burst: a 200 Hz tone with a noise-modulated envelope,
    20 ms attack and 60 ms release (well above -24 dBFS, ZCR far below 0.12)."""
    n = int(round(seconds * RATE))
    t = np.arange(n) / RATE
    env = np.ones(n)
    a, r = int(0.02 * RATE), int(0.06 * RATE)
    env[:a] = 0.5 - 0.5 * np.cos(np.pi * np.arange(a) / a)
    env[n - r:] = 0.5 + 0.5 * np.cos(np.pi * np.arange(r) / r)
    wobble = np.convolve(_rng.standard_normal(n), np.ones(441) / 441, "same")
    wobble = 1.0 + 0.3 * wobble / (np.abs(wobble).max() + 1e-9)
    return amp * env * wobble * np.sin(2 * np.pi * 200 * t)


def cut_word(seconds, amp=0.3):
    """A burst that stops dead (no release), as if the take was stopped."""
    n = int(round(seconds * RATE))
    t = np.arange(n) / RATE
    env = np.ones(n)
    a = int(0.02 * RATE)
    env[:a] = 0.5 - 0.5 * np.cos(np.pi * np.arange(a) / a)
    return amp * env * np.sin(2 * np.pi * 200 * t)


class Take:
    """Builds a take piece by piece and remembers where the words are."""

    def __init__(self, floor_dbfs=-60.0):
        self.floor = floor_dbfs
        self.parts = []
        self.words = []  # (text, start, end) as a transcriber would give

    @property
    def t(self):
        return sum(len(p) for p in self.parts) / RATE

    def say(self, text, seconds=0.3, gap=0.12, burst=word, amp=0.3):
        start = self.t
        sig = burst(seconds, amp)
        self.parts.append(sig + room(seconds, self.floor))
        self.words.append((text, start, start + seconds))
        if gap:
            self.quiet(gap)
        return self

    def quiet(self, seconds):
        self.parts.append(room(seconds, self.floor))
        return self

    def add(self, sig):
        self.parts.append(np.asarray(sig, dtype=float))
        return self

    def write(self, path):
        x = np.concatenate(self.parts)
        pcm = np.clip(np.round(x * 32767), -32768, 32767).astype("<i2")
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(pcm.tobytes())
        return path


class StubTranscriber:
    def __init__(self, words):
        self.words = list(words)

    def transcribe(self, samples, rate):
        return " ".join(w for w, _, _ in self.words), list(self.words)


def kinds(result):
    return [f["kind"] for f in result["flags"]]


class TakeTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def path(self, name="take.wav"):
        return os.path.join(self._tmp.name, name)

    def check(self, take, line, words=None):
        path = take.write(self.path())
        stub = StubTranscriber(take.words if words is None else words)
        return take_checks.check_take(path, line, stub)


# ------------------------------------------------------------- the audio ----

class CleanEndOk(TakeTestCase):
    def test_quiet_tail_is_not_cut_off(self):
        take = Take().quiet(0.3)
        for w in ["the", "road", "to", "Skaill"]:
            take.say(w)
        take.quiet(0.4)
        r = self.check(take, "The road to Skaill.")
        self.assertNotIn("cut_off", kinds(r))
        self.assertTrue(r["ok"], r["flags"])
        self.assertEqual(r["flags"], [])
        self.assertEqual(r["version"], 1)
        self.assertAlmostEqual(r["duration_s"], take.t, delta=0.02)


class AbruptEndFlagged(TakeTestCase):
    def test_speech_to_the_last_30ms(self):
        take = Take().quiet(0.3)
        take.say("the").say("road").say("to")
        take.say("Skaill", seconds=0.4, gap=0, burst=cut_word)
        take.quiet(0.03)
        # The transcriber hears the word, so only the energy test can catch it.
        words = take.words[:-1] + [("Skaill", take.words[-1][1], take.t - 0.25)]
        r = self.check(take, "The road to Skaill.", words)
        self.assertEqual(kinds(r).count("cut_off"), 1, r["flags"])
        self.assertFalse(r["ok"])

    def test_drop_of_18db_at_end_of_speech(self):
        take = Take().quiet(0.3)
        take.say("the").say("road").say("to")
        take.say("Skaill", seconds=0.4, gap=0, burst=cut_word)
        take.quiet(0.5)  # well clear of the file's end: only the drop test
        r = self.check(take, "The road to Skaill.")
        self.assertEqual(kinds(r), ["cut_off"], r["flags"])
        self.assertEqual(r["flags"][0]["text"], "ends too abruptly")


class ClickIgnored(TakeTestCase):
    def test_space_key_click_after_room_tone(self):
        clicks = {
            "broadband": _rng.uniform(-0.9, 0.9, int(0.02 * RATE)),
            # a low thump looks voiced by zero-crossing rate: the 40 ms
            # transient rule has to catch it
            "thump": 0.8 * np.sin(2 * np.pi * 150 * np.arange(int(0.02 * RATE)) / RATE),
        }
        for name, click in clicks.items():
            with self.subTest(click=name):
                take = Take().quiet(0.3)
                for w in ["the", "road", "to", "Skaill"]:
                    take.say(w)
                take.quiet(0.5).add(click)
                r = self.check(take, "The road to Skaill.")
                self.assertNotIn("cut_off", kinds(r), r["flags"])
                self.assertTrue(r["ok"], r["flags"])


class ClippingFlagged(TakeTestCase):
    def test_full_scale_samples(self):
        take = Take().quiet(0.3)
        take.say("the").say("road", amp=1.4).say("to").say("Skaill")
        take.quiet(0.4)
        r = self.check(take, "The road to Skaill.")
        self.assertEqual(kinds(r), ["clipping"], r["flags"])
        self.assertEqual(r["flags"][0]["text"], "clipping: re-record a little quieter")
        self.assertFalse(r["ok"])
        self.assertGreater(r["peak_dbfs"], -0.3)

    def test_peak_just_under_the_limit_is_fine(self):
        take = Take().quiet(0.3)
        take.say("the").say("road", amp=0.65).say("to").quiet(0.4)
        r = self.check(take, "The road to.")
        self.assertNotIn("clipping", kinds(r))


class NoiseNote(TakeTestCase):
    def test_floor_at_minus_45(self):
        take = Take(floor_dbfs=-45.0).quiet(0.3)
        for w in ["the", "road", "to", "Skaill"]:
            take.say(w)
        take.quiet(0.4)
        r = self.check(take, "The road to Skaill.")
        self.assertEqual(kinds(r), ["noise"], r["flags"])
        self.assertTrue(r["ok"])
        self.assertGreater(r["noise_dbfs"], -55)
        self.assertRegex(r["flags"][0]["text"], r"^room noise at -\d+ dBFS$")

    def test_quiet_room_has_no_note(self):
        take = Take().quiet(0.3).say("road").quiet(0.4)
        r = self.check(take, "Road.")
        self.assertLess(r["noise_dbfs"], -55)
        self.assertNotIn("noise", kinds(r))


class PauseNote(TakeTestCase):
    def test_gap_of_0_8_s(self):
        take = Take().quiet(0.3)
        take.say("the").say("road", gap=0)
        gap_start = take.t
        take.quiet(0.8)
        take.say("to").say("Skaill").quiet(0.4)
        r = self.check(take, "The road to Skaill.")
        self.assertEqual(kinds(r), ["pause"], r["flags"])
        self.assertTrue(r["ok"])
        f = r["flags"][0]
        self.assertAlmostEqual(f["at_s"], gap_start, delta=0.1)
        self.assertRegex(f["text"], r'^pause of 0\.[89] s after "road"$')

    def test_short_gaps_are_not_pauses(self):
        take = Take().quiet(0.3)
        take.say("the", gap=0.4).say("road", gap=0.4).say("to").quiet(0.4)
        r = self.check(take, "The road to.")
        self.assertNotIn("pause", kinds(r))


# ----------------------------------------------------------- the words ----

def timed(text, start=0.3, step=0.4, dur=0.3):
    return [(w, start + i * step, start + i * step + dur)
            for i, w in enumerate(text.split())]


class NumberWordsMatch(unittest.TestCase):
    def test_normalise(self):
        n = take_checks.normalise_words
        self.assertEqual(n("In 1854,"), ["in", "eighteen", "fifty", "four"])
        self.assertEqual(n("2013"), ["twenty", "thirteen"])
        self.assertEqual(n("47"), ["forty", "seven"])
        self.assertEqual(n("the 1st day"), ["the", "first", "day"])
        self.assertEqual(n("the 23rd"), ["the", "twenty", "third"])
        self.assertEqual(n("2005"), n("two thousand and five"))
        self.assertEqual(n("1900"), ["nineteen", "hundred"])
        self.assertEqual(n("1905"), ["nineteen", "oh", "five"])
        self.assertEqual(n("1,200 men"), n("one thousand two hundred men"))
        self.assertEqual(n("320"), n("three hundred and twenty"))
        self.assertEqual(n("Eighteen fifty-four!"), ["eighteen", "fifty", "four"])
        self.assertEqual(n("Don’t — stop"), ["don't", "stop"])

    def test_digits_against_words(self):
        line = "In 1854, 47 men died on the 1st day."
        heard = timed("In eighteen fifty-four, forty-seven men died on the first day.")
        self.assertEqual(take_checks.word_flags(line, heard, 10.0), [])

    def test_and_is_still_a_word(self):
        heard = timed("bread butter")
        flags = take_checks.word_flags("Bread and butter.", heard, 10.0)
        self.assertEqual([f["text"] for f in flags], ['may have missed "and"'])

    def test_pronunciation_notes_ignored(self):
        line = "The road to Skaill.\n> Skaill: say 'Skale'"
        self.assertEqual(take_checks.word_flags(line, timed("the road to Skaill"), 10.0), [])


class MissedWordFlagged(unittest.TestCase):
    def test_missed_added_and_misread(self):
        line = "It let the water through the old sluice."
        heard = timed("He let the water through the the sluice.")
        flags = take_checks.word_flags(line, heard, 10.0)
        texts = [f["text"] for f in flags]
        self.assertTrue(all(f["kind"] == "misread" for f in flags), flags)
        self.assertIn('may have misread: "He" for "It"', texts)
        self.assertIn('may have misread: "the" for "old"', texts)
        self.assertEqual(flags[0]["at_s"], heard[0][1])

    def test_missed_word(self):
        heard = timed("the road Skaill")
        flags = take_checks.word_flags("The road to Skaill.", heard, 10.0)
        self.assertEqual(flags, [{"kind": "misread", "text": 'may have missed "to"',
                                  "at_s": heard[1][2]}])

    def test_added_word(self):
        heard = timed("the long road to Skaill")
        flags = take_checks.word_flags("The road to Skaill.", heard, 10.0)
        self.assertEqual([f["text"] for f in flags], ['may have added "long"'])
        self.assertEqual(flags[0]["at_s"], heard[1][1])


class LastWordMissingIsCutOff(TakeTestCase):
    def test_missing_last_word(self):
        heard = timed("the road to")
        flags = take_checks.word_flags("The road to Skaill.", heard, 3.0)
        self.assertEqual([(f["kind"], f["text"]) for f in flags],
                         [("cut_off", 'last word "Skaill" cut off')])

    def test_last_word_ending_at_the_file_end(self):
        heard = timed("the road to Skaill")
        end = heard[-1][2]
        flags = take_checks.word_flags("The road to Skaill.", heard, end + 0.05)
        self.assertEqual([(f["kind"], f["text"]) for f in flags],
                         [("cut_off", 'last word "Skaill" cut off')])
        self.assertEqual(take_checks.word_flags("The road to Skaill.", heard, end + 0.4), [])

    def test_in_check_take_only_one_cut_off(self):
        take = Take().quiet(0.3)
        take.say("the").say("road").say("to")
        take.say("Skaill", seconds=0.4, gap=0, burst=cut_word).quiet(0.03)
        heard = take.words[:-1]
        r = self.check(take, "The road to Skaill.", heard)
        self.assertEqual(kinds(r), ["cut_off"], r["flags"])
        self.assertEqual(r["flags"][0]["text"], 'last word "Skaill" cut off')


# ----------------------------------------------------- severity and order ----

class OkSeverity(TakeTestCase):
    def test_notes_only_is_ok(self):
        take = Take(floor_dbfs=-45.0).quiet(0.3)
        take.say("the").say("road", gap=0).quiet(0.8).say("to").say("Skaill").quiet(0.4)
        r = self.check(take, "The road to Skaill.")
        self.assertEqual(sorted(kinds(r)), ["noise", "pause"], r["flags"])
        self.assertTrue(r["ok"])

    def test_misread_is_not_ok(self):
        take = Take().quiet(0.3)
        for w in ["the", "road", "to", "Skaill"]:
            take.say(w)
        take.quiet(0.4)
        heard = [("the", *take.words[0][1:]), ("rode", *take.words[1][1:])] + take.words[2:]
        r = self.check(take, "The road to Skaill.", heard)
        self.assertEqual(kinds(r), ["misread"])
        self.assertFalse(r["ok"])
        self.assertEqual(r["transcript"], "the rode to Skaill")


class FlagOrder(TakeTestCase):
    def test_every_kind_in_display_order(self):
        take = Take(floor_dbfs=-45.0).quiet(0.3)
        take.say("the", amp=1.4).say("road", gap=0).quiet(0.8).say("to")
        take.say("Skaill", seconds=0.4, gap=0, burst=cut_word).quiet(0.03)
        heard = [("a", *take.words[0][1:])] + take.words[1:3]  # misread, last word missing
        r = self.check(take, "The road to Skaill.", heard)
        self.assertEqual(kinds(r), ["cut_off", "misread", "clipping", "pause", "noise"],
                         r["flags"])
        self.assertFalse(r["ok"])
        for f in r["flags"]:
            self.assertEqual(set(f), {"kind", "text", "at_s"})

    def test_order_flags_dedupes_cut_off(self):
        flags = [
            {"kind": "noise", "text": "room noise at -50 dBFS", "at_s": None},
            {"kind": "cut_off", "text": "ends too abruptly", "at_s": 2.0},
            {"kind": "misread", "text": 'may have missed "to"', "at_s": 1.0},
            {"kind": "cut_off", "text": 'last word "Skaill" cut off', "at_s": 2.0},
            {"kind": "misread", "text": 'may have missed "to"', "at_s": 1.0},
        ]
        out = take_checks.order_flags(flags)
        self.assertEqual([f["kind"] for f in out], ["cut_off", "misread", "noise"])
        self.assertEqual(out[0]["text"], 'last word "Skaill" cut off')


# ------------------------------------------------------------ decoding ----

class DecodeMissingFfmpeg(TakeTestCase):
    def test_no_ffmpeg_on_path(self):
        path = Take().quiet(0.2).write(self.path())
        empty = tempfile.mkdtemp(dir=self._tmp.name)
        with mock.patch.dict(os.environ, {"PATH": empty}):
            with self.assertRaises(CheckError) as cm:
                take_checks.decode(path)
            self.assertEqual(str(cm.exception), "ffmpeg not found")
            with self.assertRaises(CheckError):
                take_checks.decode_with_peak(path)

    def test_decode_gives_16k_float(self):
        take = Take().quiet(0.5)
        path = take.write(self.path())
        samples, rate = take_checks.decode(path)
        self.assertEqual(rate, 16000)
        self.assertEqual(samples.dtype, np.float32)
        self.assertAlmostEqual(len(samples) / rate, 0.5, delta=0.01)

    def test_unreadable_file(self):
        path = self.path("bad.wav")
        with open(path, "wb") as f:
            f.write(b"not a wav")
        with self.assertRaises(CheckError):
            take_checks.decode(path)


class Transcriber(unittest.TestCase):
    def test_whisper_missing_is_a_check_error(self):
        t = take_checks.WhisperTranscriber("medium.en", "auto")
        with mock.patch.dict("sys.modules", {"faster_whisper": None}):
            with self.assertRaises(CheckError) as cm:
                t.transcribe(np.zeros(1600, np.float32), 16000)
        self.assertTrue(str(cm.exception).startswith("Checks unavailable: "))

    def test_auto_falls_back_to_cpu_int8(self):
        calls = []

        class FakeModel:
            def __init__(self, name, device, compute_type):
                calls.append((name, device, compute_type))
                if device == "cuda":
                    raise RuntimeError("no CUDA")

        fake = mock.Mock(WhisperModel=FakeModel)
        with mock.patch.dict("sys.modules", {"faster_whisper": fake}):
            t = take_checks.WhisperTranscriber("small.en", "auto")
            t.load()
        self.assertEqual(calls, [("small.en", "cuda", "float16"), ("small.en", "cpu", "int8")])


class Settings(unittest.TestCase):
    def test_defaults_and_bad_json(self):
        with tempfile.TemporaryDirectory() as d:
            want = {"check_model": "medium.en", "check_device": "auto"}
            self.assertEqual(take_checks.load_settings(d), want)
            with open(os.path.join(d, "autocue_settings.json"), "w") as f:
                f.write("{nope")
            self.assertEqual(take_checks.load_settings(d), want)
            with open(os.path.join(d, "autocue_settings.json"), "w") as f:
                f.write('{"check_model": "small.en"}')
            self.assertEqual(take_checks.load_settings(d)["check_model"], "small.en")


if __name__ == "__main__":
    unittest.main()
