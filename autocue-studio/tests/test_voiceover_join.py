"""Tests for voiceover_join: synthetic audio only (tones, noise, silence)."""

import os
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


if __name__ == "__main__":
    unittest.main()
