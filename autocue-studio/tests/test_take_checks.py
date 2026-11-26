"""Tests for take_checks: synthetic audio and a stub transcriber, no voices."""

import io
import json
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
        self.assertEqual(r["version"], take_checks.VERSION)
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
        take.quiet(0.15)  # clear of the 0.1 s rule, inside the 0.3 s drop-rule window
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
            def __init__(self, name, device, compute_type, **kw):
                calls.append((name, device, compute_type))
                if device == "cuda":
                    raise RuntimeError("no CUDA")

        fake = mock.Mock(WhisperModel=FakeModel)
        with mock.patch.dict("sys.modules", {"faster_whisper": fake}):
            t = take_checks.WhisperTranscriber("small.en", "auto", probe=lambda: True)
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


# ------------------------------------------------------- fix round 1 ----

def fade_word(fade_s):
    """A burst that stops with a short linear fade (a natural sharp stop)."""
    def burst(seconds, amp=0.3):
        sig = cut_word(seconds, amp)
        n = int(round(fade_s * RATE))
        sig[-n:] *= np.linspace(1.0, 0.0, n)
        return sig
    return burst


class DropRuleOnlyNearEnd(TakeTestCase):
    def _take(self, fade_s, tail_s):
        take = Take().quiet(0.3)
        take.say("the").say("road").say("to")
        take.say("Skaill", seconds=0.4, gap=0, burst=fade_word(fade_s))
        return take.quiet(tail_s)

    def test_sharp_stop_then_room_tone_is_fine(self):
        for fade in (0.01, 0.03, 0.05):
            with self.subTest(fade=fade):
                r = self.check(self._take(fade, 0.6), "The road to Skaill.")
                self.assertNotIn("cut_off", kinds(r), r["flags"])
                self.assertTrue(r["ok"])

    def test_sharp_stop_near_the_end_is_cut_off(self):
        for fade in (0.01, 0.03, 0.05):
            with self.subTest(fade=fade):
                r = self.check(self._take(fade, 0.15), "The road to Skaill.")
                self.assertEqual(kinds(r), ["cut_off"], r["flags"])

    def test_window_constant(self):
        self.assertEqual(take_checks.DROP_RULE_MAX_TAIL_S, 0.3)


def same(line, heard_text):
    return take_checks.word_flags(line, timed(heard_text), 100.0)


class BritishSpellingsMatch(unittest.TestCase):
    def test_families(self):
        cases = [
            ("The colour of the harbour.", "the color of the harbor"),
            ("His favourite neighbours.", "his favorite neighbors"),
            ("They organised it.", "they organized it"),
            ("Civilisation and realising it.", "civilization and realizing it"),
            ("The centre, a metre wide.", "the center a meter wide"),
            ("The theatre's fibres.", "the theater's fibers"),
            ("They travelled, modelling and cancelled.", "they traveled modeling and canceled"),
            ("A grey sky.", "a gray sky"),
            ("The programme.", "the program"),
            ("The defence.", "the defense"),
            ("Ten per cent.", "ten percent"),
            ("Ten per cent.", "10%"),
            ("10%", "ten percent"),
            ("We co-operate.", "we cooperate"),
            ("We co operate.", "we cooperate"),
        ]
        for line, heard in cases:
            with self.subTest(line=line, heard=heard):
                self.assertEqual(same(line, heard), [])

    def test_near_spelling_one_to_one(self):
        self.assertEqual(same("The Thames at Wapping.", "the thames at whapping"), [])

    def test_short_word_swaps_are_misreads(self):
        for meant, said in [("the", "them"), ("an", "and"), ("to", "too"),
                            ("no", "not"), ("he", "her")]:
            with self.subTest(meant=meant, said=said):
                flags = same(f"We saw {meant} boat.", f"we saw {said} boat")
                self.assertEqual([f["text"] for f in flags],
                                 [f'may have misread: "{said}" for "{meant}"'])

    def test_real_differences_still_flagged(self):
        for line, heard in [("It let it.", "he let it"), ("The road.", "the rode"),
                            ("In 1854.", "in 1845")]:
            with self.subTest(line=line):
                self.assertEqual([f["kind"] for f in same(line, heard)], ["misread"])


class NumbersByValue(unittest.TestCase):
    def test_counts_and_years(self):
        for heard in ["About 1,500 people", "about fifteen hundred people",
                      "about one thousand five hundred people", "About 1500 people"]:
            with self.subTest(heard=heard):
                self.assertEqual(same("About 1500 people.", heard), [])
        self.assertEqual(same("About 1,500 people.", "about fifteen hundred people"), [])
        self.assertEqual(same("In 2005.", "in two thousand and five"), [])
        self.assertEqual(same("In 1854, 47 men.", "in eighteen fifty-four forty-seven men"), [])
        self.assertEqual(same("The 23rd.", "the twenty-third"), [])

    def test_display_keeps_the_written_form(self):
        flags = same("About 1500 people.", "about 1600 people")
        self.assertEqual([f["text"] for f in flags], ['may have misread: "1600" for "1500"'])


class TailHallucination(TakeTestCase):
    def test_thank_you_after_room_tone_is_ignored(self):
        take = Take().quiet(0.3)
        for w in ["the", "road", "to", "Skaill"]:
            take.say(w)
        take.quiet(1.2)
        end = take.t
        heard = take.words + [("Thank", end - 0.6, end - 0.35), ("you.", end - 0.35, end - 0.01)]
        r = self.check(take, "The road to Skaill.", heard)
        self.assertEqual(r["flags"], [])
        self.assertTrue(r["ok"])

    def test_last_word_stretched_to_the_end(self):
        take = Take().quiet(0.3)
        for w in ["the", "road", "to", "Skaill"]:
            take.say(w)
        take.quiet(0.5)
        heard = take.words[:-1] + [("Skaill.", take.words[-1][1], take.t - 0.02)]
        r = self.check(take, "The road to Skaill.", heard)
        self.assertNotIn("cut_off", kinds(r), r["flags"])

    def test_word_flags_takes_voice_end(self):
        heard = timed("the road to Skaill")
        end_of_skaill = heard[3][2]
        heard += [("Thank", end_of_skaill + 0.6, end_of_skaill + 0.9),
                  ("you.", end_of_skaill + 0.9, end_of_skaill + 1.2)]
        flags = take_checks.word_flags("The road to Skaill.", heard, end_of_skaill + 2.0,
                                       voice_end_s=end_of_skaill)
        self.assertEqual(flags, [])


class FakeSegment:
    def __init__(self, text, words):
        self.text = text
        self.words = [mock.Mock(word=w, start=s, end=e) for w, s, e in words]


class WhisperFallbacks(unittest.TestCase):
    def _fake(self, behaviour):
        made = []

        class FakeModel:
            def __init__(self, name, device, compute_type, **kw):
                made.append(device)
                behaviour.get(("init", device), lambda: None)()
                self.device = device

            def transcribe(self, samples, **kw):
                behaviour.get(("run", self.device), lambda: None)()
                seg = FakeSegment(" Hello there.", [(" Hello", 0.1, 0.4), (" there.", 0.4, 0.8)])
                return iter([seg]), None

        return mock.Mock(WhisperModel=FakeModel), made

    @staticmethod
    def _raise(msg):
        def f():
            raise RuntimeError(msg)
        return f

    def test_cuda_fails_at_transcribe_time(self):
        fake, made = self._fake({("run", "cuda"): self._raise("cudnn missing")})
        with mock.patch.dict("sys.modules", {"faster_whisper": fake}):
            t = take_checks.WhisperTranscriber("medium.en", "auto", probe=lambda: True)
            text, words = t.transcribe(np.zeros(1600, np.float32), 16000)
        self.assertEqual(made, ["cuda", "cpu"])
        self.assertEqual(text, "Hello there.")
        self.assertEqual(words, [("Hello", 0.1, 0.4), ("there.", 0.4, 0.8)])

    def test_cpu_retry_failing_is_a_check_error(self):
        fake, _ = self._fake({("run", "cuda"): self._raise("cudnn missing"),
                              ("run", "cpu"): self._raise("out of memory")})
        with mock.patch.dict("sys.modules", {"faster_whisper": fake}):
            t = take_checks.WhisperTranscriber("medium.en", "auto", probe=lambda: True)
            with self.assertRaises(CheckError) as cm:
                t.transcribe(np.zeros(1600, np.float32), 16000)
        self.assertIn("out of memory", str(cm.exception))

    def test_failed_load_is_cached_until_reset(self):
        fail = {"on": True}

        def maybe():
            if fail["on"]:
                raise RuntimeError("download failed")

        fake, made = self._fake({("init", "cuda"): maybe, ("init", "cpu"): maybe})
        with mock.patch.dict("sys.modules", {"faster_whisper": fake}):
            t = take_checks.WhisperTranscriber("medium.en", "auto", probe=lambda: True)
            with self.assertRaises(CheckError) as first:
                t.load()
            with self.assertRaises(CheckError) as second:
                t.load()
            self.assertEqual(str(first.exception), str(second.exception))
            self.assertTrue(str(first.exception).startswith("Checks unavailable: "))
            self.assertEqual(made, ["cuda", "cpu"])  # not tried again
            fail["on"] = False
            t.reset()
            t.load()
            self.assertTrue(t.loaded)


class CudaProbe(unittest.TestCase):
    """device "auto" probes CUDA in a subprocess first: a broken CUDA/cuDNN
    install can kill the process inside ctranslate2, which must not be the app."""

    def _load(self, device, probe):
        made = []

        class FakeModel:
            def __init__(self, name, device, compute_type, **kw):
                made.append((device, compute_type))

        with mock.patch.dict("sys.modules", {"faster_whisper": mock.Mock(WhisperModel=FakeModel)}):
            t = take_checks.WhisperTranscriber("medium.en", device, probe=probe)
            t.load()
        return t, made

    def test_probe_success_tries_cuda(self):
        _, made = self._load("auto", lambda: True)
        self.assertEqual(made, [("cuda", "float16")])

    def test_probe_failure_uses_cpu_only(self):
        _, made = self._load("auto", lambda: False)
        self.assertEqual(made, [("cpu", "int8")])

    def test_cpu_setting_does_not_probe(self):
        probe = mock.Mock(return_value=True)
        _, made = self._load("cpu", probe)
        probe.assert_not_called()
        self.assertEqual(made, [("cpu", "int8")])

    def test_probe_once_per_session(self):
        probe = mock.Mock(return_value=False)
        t, _ = self._load("auto", probe)
        with mock.patch.dict("sys.modules", {"faster_whisper": mock.Mock()}):
            t.reset()
            t.load()
        self.assertEqual(probe.call_count, 1)

    def test_no_probe_without_faster_whisper(self):
        probe = mock.Mock(return_value=True)
        t = take_checks.WhisperTranscriber("medium.en", "auto", probe=probe)
        with mock.patch.dict("sys.modules", {"faster_whisper": None}):
            with self.assertRaises(CheckError):
                t.load()
        probe.assert_not_called()

    def test_probe_cuda_subprocess(self):
        import subprocess
        seen = {}

        def run(cmd, **kw):
            seen["cmd"], seen["kw"] = cmd, kw
            return subprocess.CompletedProcess(cmd, 0)

        self.assertTrue(take_checks.probe_cuda(run=run))
        self.assertEqual(seen["cmd"][-1], "--probe-cuda")
        self.assertTrue(seen["cmd"][-2].endswith("take_checks.py"))
        self.assertEqual(seen["kw"]["timeout"], 180)

    def test_probe_cuda_failures(self):
        import subprocess

        def exits_1(cmd, **kw):
            return subprocess.CompletedProcess(cmd, 1)

        def crashes(cmd, **kw):  # e.g. 0xC0000005 from a bad cuDNN
            return subprocess.CompletedProcess(cmd, 3221225477)

        def times_out(cmd, **kw):
            raise subprocess.TimeoutExpired(cmd, kw["timeout"])

        def cannot_start(cmd, **kw):
            raise OSError("no python")

        for run in (exits_1, crashes, times_out, cannot_start):
            self.assertFalse(take_checks.probe_cuda(run=run), run.__name__)


class FfmpegTimeout(TakeTestCase):
    def test_timeout_is_a_check_error(self):
        import subprocess
        path = Take().quiet(0.2).write(self.path())
        real = subprocess.run
        seen = {}

        def slow(cmd, **kw):
            seen["timeout"] = kw.get("timeout")
            raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))

        with mock.patch.object(take_checks.subprocess, "run", side_effect=slow):
            with self.assertRaises(CheckError) as cm:
                take_checks.decode(path)
        self.assertEqual(seen["timeout"], 60)
        self.assertIn("timed out", str(cm.exception))
        self.assertIs(subprocess.run, real)


# ------------------------------------------------------ final review ----

QUIET_AMP = 10 ** (-26 / 20.0) * np.sqrt(2)  # a 200 Hz word at -26 dB RMS


class QuietLastWord(TakeTestCase):
    """A last word softer than the -24 dBFS voiced threshold, after a pause,
    is still the voice: it must not be dropped as a tail hallucination."""

    def _take(self, burst=word, tail_s=0.4):
        take = Take().quiet(0.3)
        take.say("One").say("two", gap=0)
        take.quiet(0.3)
        take.say("Skaill", seconds=0.4, gap=0, burst=burst, amp=QUIET_AMP)
        return take.quiet(tail_s)

    def test_quiet_final_word_after_a_gap_is_not_cut_off(self):
        take = self._take()
        r = self.check(take, "One two Skaill.")
        self.assertNotIn("cut_off", kinds(r), r["flags"])
        self.assertTrue(r["ok"], r["flags"])

    def test_voice_end_follows_the_quiet_word(self):
        take = self._take()
        path = take.write(self.path())
        samples, rate = take_checks.decode(path)
        a = take_checks.analyse(samples, rate)
        skaill_end = take.words[-1][2]
        self.assertLess(a["speech_end_s"], take.words[1][2] + 0.05)
        self.assertAlmostEqual(a["voice_end_s"], skaill_end, delta=0.08)

    def test_truncated_quiet_last_word_is_still_cut_off(self):
        take = self._take(burst=cut_word, tail_s=0.03)
        words = take.words[:-1] + [("Skaill", take.words[-1][1], take.t - 0.03)]
        r = self.check(take, "One two Skaill.", words)
        self.assertEqual(kinds(r).count("cut_off"), 1, r["flags"])
        self.assertFalse(r["ok"])
        self.assertEqual(r["flags"][0]["text"], 'last word "Skaill" cut off')

    def test_click_after_the_quiet_word_is_ignored(self):
        take = self._take(tail_s=0.5)
        take.add(_rng.uniform(-0.9, 0.9, int(0.02 * RATE)))
        words = take.words + [("you.", take.t - 0.1, take.t - 0.01)]
        r = self.check(take, "One two Skaill.", words)
        self.assertEqual(r["flags"], [])


class NativeRateAnalysis(TakeTestCase):
    """The energy/ZCR/noise analysis runs on the take's own samples (s16le
    / 32768 at the file's rate); only Whisper gets the 16 kHz decode."""

    def test_decode_with_peak_gives_native_samples(self):
        take = Take().quiet(0.2).say("road").quiet(0.3)
        path = take.write(self.path())
        d = take_checks.decode_with_peak(path)
        self.assertEqual(d.rate, 16000)
        self.assertEqual(d.native_rate, RATE)
        self.assertEqual(d.native.dtype, np.float32)
        x = np.concatenate(take.parts)
        pcm = np.clip(np.round(x * 32767), -32768, 32767)
        np.testing.assert_allclose(d.native, pcm / 32768.0, atol=1e-6)
        self.assertAlmostEqual(len(d.samples) / d.rate, take.t, delta=0.01)

    def test_check_take_analyses_at_the_native_rate(self):
        take = Take().quiet(0.3).say("road").quiet(0.4)
        path = take.write(self.path())
        seen = {}
        real = take_checks.analyse

        def spy(samples, rate, **kw):
            seen["rate"], seen["n"] = rate, len(samples)
            return real(samples, rate, **kw)

        class Heard(StubTranscriber):
            def transcribe(self, samples, rate):
                seen["whisper_rate"] = rate
                return super().transcribe(samples, rate)

        with mock.patch.object(take_checks, "analyse", side_effect=spy):
            take_checks.check_take(path, "Road.", Heard(take.words))
        self.assertEqual(seen["rate"], RATE)
        self.assertEqual(seen["n"], int(round(take.t * RATE)))
        self.assertEqual(seen["whisper_rate"], 16000)


class WhisperLoadOptions(unittest.TestCase):
    """CPU threads, no progress bars, and whether loading means downloading."""

    def _fake(self):
        made = []

        class FakeModel:
            def __init__(self, name, **kw):
                made.append((name, kw))

        return mock.Mock(WhisperModel=FakeModel), made

    def test_cpu_uses_at_most_half_the_cores_up_to_4(self):
        for cores, want in ((16, 4), (8, 4), (6, 3), (2, 1), (1, 1), (None, 2)):
            with self.subTest(cores=cores):
                fake, made = self._fake()
                with mock.patch.dict("sys.modules", {"faster_whisper": fake}), \
                        mock.patch.object(take_checks.os, "cpu_count", return_value=cores):
                    take_checks.WhisperTranscriber("small.en", "cpu").load()
                self.assertEqual(made, [("small.en", {"device": "cpu", "compute_type": "int8",
                                                      "cpu_threads": want})])

    def test_cuda_gets_no_cpu_threads(self):
        fake, made = self._fake()
        with mock.patch.dict("sys.modules", {"faster_whisper": fake}):
            t = take_checks.WhisperTranscriber("small.en", "cuda")
            t.load()
        self.assertEqual(made, [("small.en", {"device": "cuda", "compute_type": "float16"})])
        self.assertEqual(t.device_used, "cuda (float16)")

    def test_progress_bars_off_before_import(self):
        seen = {}

        class Module:
            @property
            def WhisperModel(self):
                seen["env"] = os.environ.get("HF_HUB_DISABLE_PROGRESS_BARS")
                return lambda *a, **kw: object()

        env = {k: v for k, v in os.environ.items() if k != "HF_HUB_DISABLE_PROGRESS_BARS"}
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.dict("sys.modules", {"faster_whisper": Module()}):
            take_checks.WhisperTranscriber("small.en", "cpu").load()
        self.assertEqual(seen["env"], "1")
        with mock.patch.dict(os.environ, {"HF_HUB_DISABLE_PROGRESS_BARS": "0"}), \
                mock.patch.dict("sys.modules", {"faster_whisper": Module()}):
            take_checks.WhisperTranscriber("small.en", "cpu").load()
        self.assertEqual(seen["env"], "0")  # a user's own setting wins

    def test_will_download_only_when_not_cached(self):
        calls = []

        def cached(name, local_files_only=False):
            calls.append((name, local_files_only))
            return "/cache/" + name

        def missing(name, local_files_only=False):
            raise RuntimeError("LocalEntryNotFoundError")

        t = take_checks.WhisperTranscriber("medium.en", "auto")
        with mock.patch.dict("sys.modules", {"faster_whisper": mock.Mock(download_model=cached)}):
            self.assertFalse(t.will_download())
        self.assertEqual(calls, [("medium.en", True)])
        with mock.patch.dict("sys.modules", {"faster_whisper": mock.Mock(download_model=missing)}):
            self.assertTrue(t.will_download())
        with mock.patch.dict("sys.modules", {"faster_whisper": None}):
            self.assertTrue(t.will_download())
        with tempfile.TemporaryDirectory() as d:   # a model folder on disk
            self.assertFalse(take_checks.WhisperTranscriber(d, "cpu").will_download())

    def test_cli_says_which_device_it_used(self):
        class Fake:
            device_used = "cpu (int8, 4 threads)"

            def __init__(self, *a):
                pass

        err = io.StringIO()
        out = io.StringIO()
        with mock.patch.object(take_checks, "WhisperTranscriber", Fake), \
                mock.patch.object(take_checks, "check_take", return_value={"ok": True}), \
                mock.patch("sys.stderr", err), mock.patch("sys.stdout", out):
            self.assertEqual(take_checks.main(["take.wav", "Line."]), 0)
        self.assertEqual(err.getvalue(), "Checked on cpu (int8, 4 threads)\n")
        self.assertEqual(json.loads(out.getvalue()), {"ok": True})


if __name__ == "__main__":
    unittest.main()


class SpaceGroupedNumbers(unittest.TestCase):
    """Whisper writes thousands with a space between digit groups ("3 100"),
    sometimes as separate words; Jon's scripts spell them out."""

    LINE = "People lived here from around three thousand one hundred BC to two thousand five hundred BC."

    def flags_for(self, heard):
        words = [(w, i * 0.4, i * 0.4 + 0.3) for i, w in enumerate(heard.split())]
        return [f["text"] for f in take_checks.word_flags(self.LINE, words, len(words) * 0.4 + 1.0)]

    def test_space_grouped_thousands_match_words(self):
        self.assertEqual(self.flags_for("People lived here from around 3 100 BC to 2 500 BC."), [])

    def test_non_breaking_and_thin_spaces(self):
        self.assertEqual(self.flags_for("People lived here from around 3 100 BC to 2 500 BC."), [])

    def test_grouped_digits_in_one_whisper_word(self):
        words = [("People", 0, .3), ("lived", .4, .7), ("here", .8, 1.1), ("from", 1.2, 1.5),
                 ("around", 1.6, 1.9), (" 3 100", 2.0, 2.6), ("BC", 2.7, 3.0), ("to", 3.1, 3.3),
                 (" 2 500", 3.4, 4.0), ("BC.", 4.1, 4.4)]
        self.assertEqual([f["text"] for f in take_checks.word_flags(self.LINE, words, 5.5)], [])

    def test_millions_grouped(self):
        line = "About one million two hundred thousand people."
        words = [(w, i * 0.4, i * 0.4 + 0.3) for i, w in enumerate("About 1 200 000 people.".split())]
        self.assertEqual([f["text"] for f in take_checks.word_flags(line, words, 4.0)], [])

    def test_wrong_number_still_flagged(self):
        self.assertTrue(any("misread" in f for f in self.flags_for("People lived here from around 3 200 BC to 2 500 BC.")))

    def test_separate_small_numbers_not_joined(self):
        # "3 100-metre" style: a 1-3 digit word then a word that is not exactly three digits stays apart
        line = "He ran 3 races."
        words = [(w, i * 0.4, i * 0.4 + 0.3) for i, w in enumerate("He ran 3 races.".split())]
        self.assertEqual([f["text"] for f in take_checks.word_flags(line, words, 3.0)], [])


class SpokenNumberForms(unittest.TestCase):
    """The ways Jon writes numbers in a script against the ways Whisper writes them."""

    CASES = [
        ("About a hundred people lived there.", "About 100 people lived there."),
        ("In ten sixty six the Normans came.", "In 1066 the Normans came."),
        ("In the eighteen fifties.", "In the 1850s."),
        ("Through the nineteen nineties.", "Through the 1990s."),
        ("Two and a half thousand years.", "2,500 years."),
        ("It cost five pounds.", "It cost £5."),
        ("Three point five metres.", "3.5 metres."),
        ("The fortieth anniversary.", "The 40th anniversary."),
        ("One in a thousand.", "One in 1,000."),
        ("About one and a half million people.", "About 1.5 million people."),
        ("Half a million tonnes.", "500,000 tonnes."),
        ("About one million two hundred thousand people.", "About 1,200,000 people."),
        ("Around ten thousand years ago.", "Around 10,000 years ago."),
        ("Some six hundred years.", "Some 600 years."),
        ("In AD forty seven.", "In AD 47."),
        ("Nineteen oh five.", "1905."),
        ("Two thousand and five.", "2005."),
    ]

    def flags(self, line, heard):
        words = [(w, i * 0.4, i * 0.4 + 0.3) for i, w in enumerate(heard.split())]
        return [f["text"] for f in take_checks.word_flags(line, words, len(words) * 0.4 + 1.0)]

    def test_said_right_is_not_flagged(self):
        for line, heard in self.CASES:
            with self.subTest(heard=heard):
                self.assertEqual(self.flags(line, heard), [])

    def test_wrong_numbers_still_flagged(self):
        for line, heard in [
            ("In ten sixty six the Normans came.", "In 1067 the Normans came."),
            ("Two and a half thousand years.", "3,500 years."),
            ("Three point five metres.", "3.7 metres."),
            ("In the eighteen fifties.", "In the 1860s."),
            ("It cost five pounds.", "It cost £6."),
        ]:
            with self.subTest(heard=heard):
                self.assertTrue(any("misread" in f for f in self.flags(line, heard)))


class DecadeWithApostrophe(unittest.TestCase):
    def test_1920s_with_apostrophe(self):
        line = "Then, in the nineteen twenties, another storm damaged it."
        heard = "Then, in the 1920's, another storm damaged it."
        words = [(w, i * 0.4, i * 0.4 + 0.3) for i, w in enumerate(heard.split())]
        self.assertEqual([f["text"] for f in take_checks.word_flags(line, words, len(words) * 0.4 + 1.0)], [])


class BreathHeardAsAWord(unittest.TestCase):
    """Whisper often turns the opening breath into "A", "And" or "So", and
    keeps the odd "um"; neither is a misread of the line."""

    LINE = "Few records were kept, finds were carried off, and by the late eighteen sixties the digging had stopped."

    def flags(self, heard):
        words = [(w, i * 0.4, i * 0.4 + 0.3) for i, w in enumerate(heard.split())]
        return [f["text"] for f in take_checks.word_flags(self.LINE, words, len(words) * 0.4 + 1.0)]

    def test_leading_a_from_the_breath_is_ignored(self):
        self.assertEqual(self.flags("A few records were kept, finds were carried off, and by the late 1860s the digging had stopped."), [])

    def test_leading_and_or_so_is_ignored(self):
        self.assertEqual(self.flags("And few records were kept, finds were carried off, and by the late 1860s the digging had stopped."), [])
        self.assertEqual(self.flags("So few records were kept, finds were carried off, and by the late 1860s the digging had stopped."), [])

    def test_filler_anywhere_is_ignored(self):
        self.assertEqual(self.flags("Few records were kept, um, finds were carried off, and by the late 1860s the digging had stopped."), [])

    def test_real_extra_word_still_flagged(self):
        self.assertTrue(any("added" in f for f in self.flags(
            "Few records were kept, finds were quickly carried off, and by the late 1860s the digging had stopped.")))

    def test_two_extra_leading_words_still_flagged(self):
        self.assertTrue(any("added" in f for f in self.flags(
            "A very few records were kept, finds were carried off, and by the late 1860s the digging had stopped.")))

    def test_line_that_really_starts_with_a(self):
        line = "A storm came in the night."
        words = [(w, i * 0.4, i * 0.4 + 0.3) for i, w in enumerate("Storm came in the night.".split())]
        self.assertTrue(any("missed" in f for f in [f["text"] for f in take_checks.word_flags(line, words, 3.0)]))
