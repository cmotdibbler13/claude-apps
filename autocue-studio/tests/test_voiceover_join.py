"""Tests for voiceover_join: synthetic audio only (tones, noise, silence)."""

import os
import re
import subprocess
import sys
import tempfile
import unittest
import wave

import numpy as np

import line_script
import take_checks
import voiceover_join as vj

RATE = 48000
_rng = np.random.default_rng(4321)


def noise(seconds, dbfs=-60.0):
    return _rng.standard_normal(int(round(seconds * RATE))) * 10 ** (dbfs / 20.0)


def tone(seconds, rms_dbfs=-12.0, freq=200.0):
    t = np.arange(int(round(seconds * RATE))) / RATE
    return np.sqrt(2) * 10 ** (rms_dbfs / 20.0) * np.sin(2 * np.pi * freq * t)


def silence(seconds):
    return np.zeros(int(round(seconds * RATE)))


def click(seconds=0.020, amp=0.5):
    """A full-band click: white noise at a high level."""
    return _rng.uniform(-amp, amp, int(round(seconds * RATE)))


def voiced_span(x):
    """(first, last) voiced sample bounds at 1 ms resolution: the tone."""
    n = RATE // 1000
    db = take_checks._frame_db(take_checks._frames(np.asarray(x), n))
    loud = np.flatnonzero(db > -30.0)
    return loud[0] * n / RATE, (loud[-1] + 1) * n / RATE


def gaps(x, floor_db=-40.0):
    """Lengths in seconds of quiet runs (1 ms frames) strictly inside x."""
    n = RATE // 1000
    db = take_checks._frame_db(take_checks._frames(np.asarray(x), n))
    runs = take_checks._runs(db < floor_db)
    total = len(db)
    return [(b - a) / 1000.0 for a, b in runs if a > 0 and b < total]


class TrimTakeTest(unittest.TestCase):
    def setUp(self):
        self.x = np.concatenate([noise(0.5), tone(1.0), noise(0.3), click()])
        self.y, self.info = vj.trim_take(self.x, RATE)

    def test_head_keeps_50_ms_before_the_tone(self):
        start, _ = voiced_span(self.y)
        self.assertAlmostEqual(start, 0.05, delta=0.010)
        self.assertAlmostEqual(self.info["head_s"], 0.45, delta=0.010)

    def test_tail_ends_150_ms_after_the_tone_with_a_fade(self):
        start, end = voiced_span(self.y)
        self.assertAlmostEqual(len(self.y) / RATE - end, 0.15, delta=0.010)
        self.assertAlmostEqual(end - start, 1.0, delta=0.005)
        self.assertLess(abs(self.y[-1]), 1e-4)
        # the fades only touch the first 5 ms and the last 30 ms
        fade, fade_in = int(0.03 * RATE), int(0.005 * RATE)
        head = int(round(self.info["head_s"] * RATE))
        np.testing.assert_array_equal(self.y[fade_in:-fade],
                                      self.x[head + fade_in:head + len(self.y) - fade])
        np.testing.assert_allclose(self.y[:fade_in],
                                   self.x[head:head + fade_in] * np.linspace(0, 1, fade_in))
        self.assertEqual(self.y[0], 0.0)

    def test_click_is_gone(self):
        tail = self.y[-int(0.15 * RATE):]
        self.assertLess(np.max(np.abs(tail)), 0.01)
        self.assertAlmostEqual(self.info["tail_s"], 0.15 + 0.020, delta=0.010)

    def test_a_voiced_thump_after_the_speech_is_ignored(self):
        # A short low-frequency thump looks voiced (low ZCR) but is under 40 ms.
        x = np.concatenate([noise(0.5), tone(1.0), noise(0.3), tone(0.02, -10.0, 100.0),
                            noise(0.2)])
        y, info = vj.trim_take(x, RATE)
        start, end = voiced_span(y)
        self.assertAlmostEqual(end - start, 1.0, delta=0.005)
        self.assertAlmostEqual(len(y) / RATE - end, 0.15, delta=0.010)

    def test_soft_consonants_either_side_are_kept(self):
        # hiss stands in for an "s" or "f": broadband, so never voiced
        x = np.concatenate([noise(0.5), noise(0.15, -26.0), tone(1.0, -12.0, 120.0),
                            noise(0.25, -28.0), noise(0.5)])
        y, info = vj.trim_take(x, RATE)
        hiss_start, hiss_end = 0.5, 0.5 + 0.15 + 1.0 + 0.25
        self.assertAlmostEqual(info["head_s"], hiss_start - 0.05, delta=0.010)
        self.assertAlmostEqual(len(x) / RATE - info["tail_s"], hiss_end + 0.15, delta=0.010)
        self.assertTrue(info["speech"])

    def test_a_click_right_after_the_soft_tail_does_not_extend_it(self):
        x = np.concatenate([noise(0.5), tone(1.0), noise(0.25, -28.0), click(0.030),
                            noise(0.5)])
        y, info = vj.trim_take(x, RATE)
        hiss_end = 0.5 + 1.0 + 0.25
        self.assertAlmostEqual(len(x) / RATE - info["tail_s"], hiss_end + 0.15, delta=0.005)

    def test_voiced_zcr_threshold_means_the_same_as_at_16k(self):
        # ZCR 0.12 at 16 kHz is 1920 crossings a second (a 960 Hz tone).
        # 1.5 kHz is unvoiced in take_checks; 600 Hz is voiced.
        for freq, voiced in ((1500.0, False), (600.0, True)):
            x = np.concatenate([noise(0.3), tone(0.5, -12.0, freq), noise(0.3)])
            _, info = vj.trim_take(x, RATE)
            self.assertEqual(info["speech"], voiced, freq)
            # the same answer as take_checks' own rule on a 16 kHz copy
            x16 = x[::3]
            f = take_checks._frames(x16, 160)
            tc = (take_checks._frame_db(f) > take_checks.VOICED_DBFS) & (
                take_checks._zcr(f) < take_checks.VOICED_MAX_ZCR)
            self.assertEqual(bool(tc.any()), voiced, freq)

    def test_no_speech_is_returned_unchanged(self):
        x = noise(0.5)
        y, info = vj.trim_take(x, RATE)
        np.testing.assert_array_equal(x, y)
        self.assertEqual((info["head_s"], info["tail_s"]), (0.0, 0.0))
        self.assertFalse(info["speech"])


class TightenStallsTest(unittest.TestCase):
    def test_long_gap_becomes_300_ms(self):
        x = np.concatenate([tone(0.5), silence(0.9), tone(0.5)])
        y, stalls = vj.tighten_stalls(x, RATE)
        self.assertEqual(len(stalls), 1)
        g = gaps(y)
        self.assertEqual(len(g), 1)
        self.assertAlmostEqual(g[0], 0.3, delta=0.010)
        self.assertAlmostEqual(len(y) / RATE, 1.3, delta=0.010)
        s = stalls[0]
        self.assertAlmostEqual(s["at_s"], 0.5, delta=0.010)
        self.assertAlmostEqual(s["from_s"], 0.9, delta=0.010)
        self.assertAlmostEqual(s["to_s"], 0.3, delta=0.001)

    def test_half_second_gap_is_unchanged(self):
        x = np.concatenate([tone(0.5), silence(0.5), tone(0.5)])
        y, stalls = vj.tighten_stalls(x, RATE)
        self.assertEqual(stalls, [])
        np.testing.assert_array_equal(x, y)

    def test_room_tone_gap_counts_as_quiet(self):
        x = np.concatenate([noise(0.2), tone(0.5), noise(1.2, -50), tone(0.5), noise(0.2)])
        y, stalls = vj.tighten_stalls(x, RATE)
        self.assertEqual(len(stalls), 1)
        self.assertAlmostEqual(stalls[0]["from_s"], 1.2, delta=0.010)
        self.assertAlmostEqual(len(y) / RATE, len(x) / RATE - 0.9, delta=0.010)


class LevelsTest(unittest.TestCase):
    def test_rms_db_and_set_rms(self):
        x = tone(1.0, -20.0)
        self.assertAlmostEqual(vj.rms_db(x), -20.0, delta=0.05)
        self.assertAlmostEqual(vj.rms_db(vj.set_rms(x, -13.5)), -13.5, delta=0.01)
        self.assertEqual(vj.rms_db(np.zeros(10)), take_checks.FLOOR_DBFS)
        np.testing.assert_array_equal(vj.set_rms(np.zeros(10), -13.5), np.zeros(10))

    def test_limiter_keeps_peaks_at_or_under_084(self):
        x = np.concatenate([tone(0.5, -3.0), click(0.005, 1.0), tone(0.5, -20.0)])
        y = vj.limit(x)
        self.assertLessEqual(np.max(np.abs(y)), 0.84 + 1e-9)
        self.assertEqual(len(y), len(x))

    def test_limiter_leaves_quiet_audio_alone(self):
        x = tone(0.5, -20.0)   # peak about 0.14
        np.testing.assert_allclose(vj.limit(x), x)

    def test_limiter_releases_after_a_peak(self):
        x = np.concatenate([tone(0.1, -3.0), tone(0.5, -20.0)])
        y = vj.limit(x)
        late = slice(int(0.4 * RATE), None)   # 300 ms after the peak: released
        np.testing.assert_allclose(y[late], x[late], rtol=1e-3, atol=1e-6)

    def test_limiter_is_deterministic(self):
        x = np.concatenate([tone(0.3, -2.0), noise(0.2, -10)])
        np.testing.assert_array_equal(vj.limit(x), vj.limit(x.copy()))

    def test_highpass_cuts_low_rumble_and_keeps_speech_band(self):
        low = tone(1.0, -12.0, 20.0)
        mid = tone(1.0, -12.0, 400.0)
        skip = slice(int(0.2 * RATE), None)   # past the filter's settling
        self.assertLess(vj.rms_db(vj.highpass(low, RATE)[skip]), -12.0 - 20.0)
        self.assertAlmostEqual(vj.rms_db(vj.highpass(mid, RATE)[skip]), -12.0, delta=0.3)
        self.assertAlmostEqual(vj.rms_db(vj.highpass(tone(1.0, -12.0, 80.0), RATE)[skip]),
                               -15.0, delta=0.3)   # -3 dB at the corner

    def test_build_clip_levels_and_gap(self):
        a, b = tone(0.8, -25.0), tone(0.6, -8.0, 300.0)
        y = vj.build_clip([a, b])
        n_a, n_gap, n_b = len(a), int(round(0.55 * RATE)), len(b)
        self.assertEqual(len(y), n_a + n_gap + n_b)
        self.assertAlmostEqual(vj.rms_db(y[:n_a]), -13.5, delta=0.3)
        self.assertAlmostEqual(vj.rms_db(y[n_a + n_gap:]), -13.5, delta=0.3)
        np.testing.assert_array_equal(y[n_a:n_a + n_gap], 0.0)
        self.assertLessEqual(np.max(np.abs(y)), 0.84 + 1e-9)

    def test_level_clip_lands_within_half_a_db_of_minus_13_8(self):
        clip = vj.build_clip([tone(0.8, -25.0), noise(0.4, -12), tone(0.6, -8.0)])
        y = vj.level_clip(clip)
        self.assertAlmostEqual(vj.rms_db(y), -13.8, delta=0.5)
        self.assertLessEqual(np.max(np.abs(y)), 0.84 + 1e-9)


class AssembleTest(unittest.TestCase):
    def test_spacing_tail_and_timings(self):
        c1, c2, c3 = tone(1.0), tone(0.7), tone(0.4)
        x, timings = vj.assemble([("01", c1), ("02", c2), ("03", c3)],
                                 ["A", "A", "B"], project="demo")
        self.assertEqual([t["clip"] for t in timings], ["01", "02", "03"])
        self.assertEqual([t["section"] for t in timings], ["A", "A", "B"])
        self.assertEqual([t["name"] for t in timings], ["demo_01", "demo_02", "demo_03"])
        self.assertAlmostEqual(timings[0]["start_s"], 0.0)
        for t, c in zip(timings, (c1, c2, c3)):
            self.assertAlmostEqual(t["end_s"] - t["start_s"], len(c) / RATE, places=6)
        self.assertAlmostEqual(timings[1]["start_s"] - timings[0]["end_s"], 0.6, places=6)
        self.assertAlmostEqual(timings[2]["start_s"] - timings[1]["end_s"], 1.2, places=6)
        self.assertAlmostEqual(len(x) / RATE - timings[2]["end_s"], 0.5, places=6)
        self.assertEqual(gaps(x), [0.6, 1.2])
        s = int(round(timings[1]["start_s"] * RATE))
        np.testing.assert_array_equal(x[s:s + len(c2)], c2)


def _script(text):
    fd, path = tempfile.mkstemp(suffix=".txt")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    return path


SCRIPT = """# name: demo
# a comment
## Opening
[01.1]
First part.
[01.2]
Second part.
> a note
## The middle
[02.1]
Another line.
"""


class PlanJoinTest(unittest.TestCase):
    def setUp(self):
        path = _script(SCRIPT)
        self.addCleanup(os.remove, path)
        self.name, self.lines = line_script.parse_line_script(path)

    def test_missing_take_is_named_and_stray_take_is_extra(self):
        files = ["demo_01.1.wav", "demo_02.1.wav", "demo_09.9.wav"]
        plan = vj.plan_join(self.lines, files, project=self.name)
        self.assertEqual(plan["missing"], ["01.2"])
        self.assertEqual(plan["extra"], ["demo_09.9.wav"])
        self.assertEqual(plan["clips"], [
            {"clip": "01", "section": "Opening", "ids": ["01.1", "01.2"]},
            {"clip": "02", "section": "The middle", "ids": ["02.1"]},
        ])

    def test_takes_the_parser_pair_directly(self):
        plan = vj.plan_join((self.name, self.lines), ["demo_01.1.wav", "demo_02.1.wav"])
        self.assertEqual(plan["missing"], ["01.2"])
        self.assertEqual(plan["files"], {"01.1": "demo_01.1.wav", "02.1": "demo_02.1.wav"})

    def test_a_second_file_for_one_id_is_reported(self):
        files = [os.path.join("a", "demo_01.1.wav"), "demo_01.2.wav",
                 os.path.join("b", "DEMO_01.1.wav"), "demo_02.1.wav"]
        plan = vj.plan_join(self.lines, files, project="demo")
        self.assertEqual(plan["duplicates"], [{"id": "01.1", "files": [files[0], files[2]]}])
        self.assertEqual(plan["files"]["01.1"], files[0])
        self.assertEqual(plan["missing"], [])

    def test_complete_takes_give_files_in_script_order(self):
        files = [os.path.join("rec", "demo_02.1.wav"), os.path.join("rec", "demo_01.2.wav"),
                 os.path.join("rec", "demo_01.1.wav")]
        plan = vj.plan_join(self.lines, files, project="demo")
        self.assertEqual(plan["missing"], [])
        self.assertEqual(plan["extra"], [])
        self.assertEqual(plan["duplicates"], [])
        self.assertEqual(plan["files"], {
            "01.1": files[2], "01.2": files[1], "02.1": files[0]})

    def test_superseded_and_temp_files_are_ignored(self):
        files = ["demo_01.1.wav", "demo_01.2.recording.tmp.wav",
                 os.path.join("rec", "superseded", "demo_01.2_20261126-101010.wav"),
                 os.path.join("superseded", "demo_01.2.wav"),
                 "demo_02.1.wav", "notes.txt"]
        plan = vj.plan_join(self.lines, files, project="demo")
        self.assertEqual(plan["missing"], ["01.2"])
        self.assertEqual(plan["extra"], [])

    def test_other_project_take_is_extra(self):
        files = ["demo_01.1.wav", "demo_01.2.wav", "demo_02.1.wav", "other_01.1.wav"]
        plan = vj.plan_join(self.lines, files, project="demo")
        self.assertEqual(plan["extra"], ["other_01.1.wav"])

    def test_clip_without_a_dot_is_its_own_id(self):
        path = _script("# name: p\n[07]\nOne line.\n")
        self.addCleanup(os.remove, path)
        name, lines = line_script.parse_line_script(path)
        plan = vj.plan_join(lines, ["p_07.wav"], project=name)
        self.assertEqual(plan["clips"], [{"clip": "07", "section": "", "ids": ["07"]}])


class LineScriptModuleTest(unittest.TestCase):
    def test_importing_the_parser_pulls_in_no_ui_toolkit(self):
        code = ("import sys, line_script, voiceover_join; "
                "bad = [m for m in ('tkinter', 'customtkinter', 'sounddevice') "
                "if m in sys.modules]; print(bad)")
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        out = subprocess.run([sys.executable, "-c", code], cwd=here,
                             capture_output=True, text=True, check=True).stdout
        self.assertEqual(out.strip(), "[]")


class Decode48Test(unittest.TestCase):
    def test_decodes_a_44k_wav_to_48k_float(self):
        x = (tone(0.5, -12.0) * 32767).astype("<i2")
        fd, path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        self.addCleanup(os.remove, path)
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(44100)
            w.writeframes(x.tobytes())
        y = vj.decode48(path)
        self.assertEqual(y.dtype, np.float32)
        self.assertAlmostEqual(len(y) / 48000, len(x) / 44100, delta=0.005)
        # the existing 16 kHz decode is unchanged
        z, rate = take_checks.decode(path)
        self.assertEqual(rate, 16000)
        self.assertAlmostEqual(len(z) / 16000, len(x) / 44100, delta=0.005)



# ------------------------------------------------------------ the command ----

import contextlib
import csv
import io
import json
import shutil


class StubTranscriber:
    """Says the same two words for every part; records what it was given."""

    def __init__(self):
        self.calls = []

    def transcribe(self, samples, rate):
        self.calls.append((len(samples), rate))
        return "hello there", [("hello", 0.10, 0.30), ("there", 0.40, 0.60)]


def write_wav(path, x, rate=44100):
    """A 16-bit mono WAV of x (given at 48 kHz, resampled crudely by index)."""
    idx = np.round(np.arange(int(len(x) * rate / RATE)) * RATE / rate).astype(int)
    pcm = (np.clip(x[np.minimum(idx, len(x) - 1)], -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def take_audio(seconds=0.6, freq=200.0):
    return np.concatenate([noise(0.3), tone(seconds, -14.0, freq), noise(0.3)])


class JoinCommandTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.script = os.path.join(self.dir, "demo_line_script.txt")
        with open(self.script, "w", encoding="utf-8") as fh:
            fh.write(SCRIPT)
        self.takes = os.path.join(self.dir, "Recordings", "demo")
        os.makedirs(self.takes)
        self.out = os.path.join(self.dir, "studio", "voiceover")
        for i, line_id in enumerate(("01.1", "01.2", "02.1")):
            write_wav(self.take(line_id), take_audio(0.5 + 0.1 * i, 150.0 + 50 * i))

    def take(self, line_id):
        return os.path.join(self.takes, f"demo_{line_id}.wav")

    def run_join(self, *extra, transcriber=None):
        self.stub = transcriber or StubTranscriber()
        buf = io.StringIO()
        argv = ["--script", self.script, "--takes", self.takes, "--out", self.out, *extra]
        with contextlib.redirect_stdout(buf):
            code = vj.main(argv, transcriber=self.stub)
        lines = [json.loads(ln) for ln in buf.getvalue().splitlines() if ln.strip()]
        return code, lines

    def outputs(self):
        return sorted(os.listdir(self.out)) if os.path.isdir(self.out) else []

    def test_join_writes_the_three_files(self):
        code, lines = self.run_join()
        self.assertEqual(code, 0, lines[-1])
        done = lines[-1]
        self.assertTrue(done["done"])
        self.assertEqual(self.outputs(), ["demo_voiceover.wav", "demo_voiceover_timings.csv",
                                          "demo_voiceover_transcript.json"])
        self.assertEqual(done["wav"], os.path.join(self.out, "demo_voiceover.wav"))
        self.assertEqual(done["csv"], os.path.join(self.out, "demo_voiceover_timings.csv"))
        self.assertEqual(done["transcript"],
                         os.path.join(self.out, "demo_voiceover_transcript.json"))
        self.assertEqual(done["clips"], 2)
        self.assertEqual(done["extra"], [])
        self.assertEqual(done["silent"], [])
        self.assertEqual(done["duplicates"], [])

        with wave.open(done["wav"]) as w:
            self.assertEqual((w.getframerate(), w.getnchannels()), (48000, 1))
            self.assertAlmostEqual(w.getnframes() / 48000, done["length_s"], delta=0.001)

        with open(done["csv"], encoding="utf-8", newline="") as fh:
            text = fh.read()
        self.assertEqual(text.splitlines()[0], "clip,section,name,start_s,end_s,timecode")
        rows = list(csv.DictReader(io.StringIO(text)))
        self.assertEqual([r["clip"] for r in rows], ["01", "02"])
        self.assertEqual([r["section"] for r in rows], ["Opening", "The middle"])
        self.assertEqual([r["name"] for r in rows], ["demo_01", "demo_02"])
        self.assertEqual(rows[0]["start_s"], "0.000")
        self.assertEqual(rows[0]["timecode"], "00:00.00")
        self.assertAlmostEqual(float(rows[1]["start_s"]) - float(rows[0]["end_s"]), 1.2,
                               delta=0.001)
        self.assertAlmostEqual(done["length_s"] - float(rows[1]["end_s"]), 0.5, delta=0.001)
        self.assertEqual(rows[1]["timecode"], vj.timecode(float(rows[1]["start_s"])))

        with open(done["transcript"], encoding="utf-8") as fh:
            tr = json.load(fh)
        self.assertEqual([s["sentence"] for s in tr["sentences"]], ["01.1", "01.2", "02.1"])
        self.assertEqual([w["sentence"] for w in tr["words"]],
                         ["01.1", "01.1", "01.2", "01.2", "02.1", "02.1"])
        # each part is transcribed on its own, at 16 kHz, and its words are
        # moved to its place in the voiceover
        self.assertEqual([r for _, r in self.stub.calls], [16000] * 3)
        s1, s2, s3 = tr["sentences"]
        self.assertAlmostEqual(s1["start"], 0.0, delta=0.001)
        self.assertAlmostEqual(s2["start"] - s1["end"], 0.55, delta=0.001)
        self.assertAlmostEqual(s3["start"], float(rows[1]["start_s"]), delta=0.001)
        for s, (n16, _) in zip(tr["sentences"], self.stub.calls):
            self.assertAlmostEqual(s["end"] - s["start"], n16 / 16000, delta=0.001)
        w5 = tr["words"][4]
        self.assertEqual(w5["word"], "hello")
        self.assertAlmostEqual(w5["start"], s3["start"] + 0.10, delta=0.001)
        self.assertEqual(s3["text"], "hello there")

    def test_progress_lines_come_first_and_rise_to_one(self):
        code, lines = self.run_join()
        self.assertEqual(code, 0)
        progress = [ln for ln in lines if "progress" in ln]
        self.assertEqual(lines[:len(progress)], progress)
        self.assertEqual(len(progress), 6)   # three takes, three sentences
        values = [p["progress"] for p in progress]
        self.assertEqual(values, sorted(values))
        self.assertTrue(all(0 <= v <= 1 for v in values))
        self.assertAlmostEqual(values[-1], 1.0)
        self.assertTrue(all(p["text"] for p in progress))

    def test_a_missing_take_is_refused(self):
        os.remove(self.take("01.2"))
        code, lines = self.run_join()
        self.assertEqual(code, 2)
        self.assertEqual(lines[-1], {"error": "Missing takes: 01.2"})
        self.assertEqual(self.outputs(), [])
        self.assertEqual(self.stub.calls, [])

    def test_two_missing_takes_are_named_in_script_order(self):
        os.remove(self.take("02.1"))
        os.remove(self.take("01.1"))
        code, lines = self.run_join()
        self.assertEqual(code, 2)
        self.assertEqual(lines[-1], {"error": "Missing takes: 01.1, 02.1"})

    def test_a_second_run_moves_the_first_outputs_aside(self):
        self.assertEqual(self.run_join()[0], 0)
        with open(os.path.join(self.out, "demo_voiceover_timings.csv"), "rb") as fh:
            first_csv = fh.read()
        code, lines = self.run_join()
        self.assertEqual(code, 0)
        names = self.outputs()
        self.assertEqual(len(names), 6)
        for base, ext in (("demo_voiceover", "wav"), ("demo_voiceover_timings", "csv"),
                          ("demo_voiceover_transcript", "json")):
            self.assertIn(f"{base}.{ext}", names)
            old = [n for n in names if re.fullmatch(
                re.escape(base) + r"\.old-\d{8}-\d{6}(-\d+)?\." + ext, n)]
            self.assertEqual(len(old), 1, names)
        old_csv = next(n for n in names if n.startswith("demo_voiceover_timings.old-"))
        with open(os.path.join(self.out, old_csv), "rb") as fh:
            self.assertEqual(fh.read(), first_csv)
        self.assertEqual(sorted(lines[-1]["moved_aside"]),
                         sorted(os.path.join(self.out, n) for n in names if ".old-" in n))
        # a third run in the same second does not overwrite the second's set
        self.assertEqual(self.run_join()[0], 0)
        self.assertEqual(len(self.outputs()), 9)

    def test_takes_are_only_read(self):
        before = {n: os.stat(os.path.join(self.takes, n)).st_mtime for n in os.listdir(self.takes)}
        self.run_join()
        after = {n: os.stat(os.path.join(self.takes, n)).st_mtime for n in os.listdir(self.takes)}
        self.assertEqual(before, after)

    def test_extra_and_duplicate_takes_are_reported(self):
        write_wav(os.path.join(self.takes, "demo_09.9.wav"), take_audio())
        os.makedirs(os.path.join(self.takes, "spare"))
        dup = os.path.join(self.takes, "spare", "demo_02.1.wav")
        write_wav(dup, take_audio())
        os.makedirs(os.path.join(self.takes, "superseded"))
        write_wav(os.path.join(self.takes, "superseded", "demo_01.1.wav"), take_audio())
        code, lines = self.run_join()
        self.assertEqual(code, 0)
        self.assertEqual(lines[-1]["extra"], ["demo_09.9.wav"])
        self.assertEqual(lines[-1]["duplicates"],
                         [{"id": "02.1", "files": [self.take("02.1"), dup]}])

    def test_a_stall_is_tightened_and_reported_in_take_time(self):
        x = np.concatenate([noise(0.4), tone(0.5, -14.0), silence(0.9), tone(0.5, -14.0),
                            noise(0.3)])
        write_wav(self.take("01.2"), x)
        code, lines = self.run_join()
        self.assertEqual(code, 0)
        tight = lines[-1]["tightened"]
        self.assertEqual([t["id"] for t in tight], ["01.2"])
        self.assertAlmostEqual(tight[0]["at_s"], 0.9, delta=0.02)
        self.assertAlmostEqual(tight[0]["from_s"], 0.9, delta=0.02)
        self.assertAlmostEqual(tight[0]["to_s"], 0.3, delta=0.001)

    def test_a_take_with_no_speech_is_refused_unless_allowed(self):
        write_wav(self.take("01.2"), noise(1.0, -60.0))
        code, lines = self.run_join()
        self.assertEqual(code, 2)
        self.assertEqual(lines[-1], {"error": "No speech found in takes: 01.2",
                                     "silent": ["01.2"]})
        self.assertEqual(self.outputs(), [])

        code, lines = self.run_join("--allow-flagged")
        self.assertEqual(code, 0)
        self.assertTrue(lines[-1]["done"])
        self.assertEqual(lines[-1]["silent"], ["01.2"])
        with open(lines[-1]["transcript"], encoding="utf-8") as fh:
            self.assertIn("01.2", [s["sentence"] for s in json.load(fh)["sentences"]])

    def test_an_unreadable_take_is_an_error(self):
        with open(self.take("01.2"), "wb") as fh:
            fh.write(b"not audio")
        code, lines = self.run_join()
        self.assertEqual(code, 1)
        self.assertIn("01.2", lines[-1]["error"])
        self.assertEqual(self.outputs(), [])

    def test_a_transcriber_failure_is_an_error_and_writes_nothing(self):
        class Broken:
            def transcribe(self, samples, rate):
                raise take_checks.CheckError("Checks unavailable: no model")
        code, lines = self.run_join(transcriber=Broken())
        self.assertEqual(code, 1)
        self.assertEqual(lines[-1], {"error": "Checks unavailable: no model"})
        self.assertEqual(self.outputs(), [])

    def test_bad_arguments_are_a_json_error(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            code = vj.main(["--script", self.script], transcriber=StubTranscriber())
        self.assertEqual(code, 2)
        self.assertIn("error", json.loads(buf.getvalue().splitlines()[-1]))


class TranscriptForTest(unittest.TestCase):
    def test_each_part_is_offset_to_its_place(self):
        stub = StubTranscriber()
        parts = [("01.1", tone(0.9), 0.0), ("02.1", tone(0.6), 3.25)]
        tr = vj.transcript_for(parts, stub)
        self.assertEqual(stub.calls, [(int(0.9 * 16000), 16000), (int(0.6 * 16000), 16000)])
        self.assertEqual(tr["sentences"], [
            {"sentence": "01.1", "text": "hello there", "start": 0.0, "end": 0.9},
            {"sentence": "02.1", "text": "hello there", "start": 3.25, "end": 3.85}])
        self.assertEqual(tr["words"][2], {"word": "hello", "start": 3.35, "end": 3.55,
                                          "sentence": "02.1"})

    def test_resample_keeps_a_speech_tone_and_drops_above_8k(self):
        y = vj.resample_16k(tone(1.0, -12.0, 1000.0))
        self.assertEqual(len(y), 16000)
        self.assertEqual(y.dtype, np.float32)
        self.assertAlmostEqual(vj.rms_db(y[1000:-1000]), -12.0, delta=0.3)
        hiss = vj.resample_16k(tone(1.0, -12.0, 12000.0))
        self.assertLess(vj.rms_db(hiss[1000:-1000]), -50.0)


class TimecodeTest(unittest.TestCase):
    def test_minutes_seconds_hundredths(self):
        self.assertEqual(vj.timecode(0.0), "00:00.00")
        self.assertEqual(vj.timecode(65.456), "01:05.46")
        self.assertEqual(vj.timecode(59.999), "01:00.00")
        self.assertEqual(vj.timecode(6125.5), "102:05.50")


if __name__ == "__main__":
    unittest.main()
