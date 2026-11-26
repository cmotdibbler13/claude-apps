import json
import os
import subprocess
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import measure

RATE = 44100


def click_track(bpm=120.0, seconds=30.0, first=0.25):
    """Short decaying clicks over a soft hum, on every beat."""
    n = int(RATE * seconds)
    t = np.arange(n) / RATE
    x = 0.02 * np.sin(2 * np.pi * 110 * t)
    rng = np.random.default_rng(1)
    beats = np.arange(first, seconds - 0.1, 60.0 / bpm)
    length = int(0.03 * RATE)
    shape = np.exp(-np.arange(length) / (0.004 * RATE))
    for b in beats:
        i = int(round(b * RATE))
        x[i:i + length] += 0.5 * shape * rng.standard_normal(length)
    return np.stack([x, x], axis=1).astype(np.float32), beats


def pad(levels_db, seconds, fade_s=0.0):
    """Steady chords at each level in turn, then an optional linear fade to silence."""
    parts = []
    for level, length in zip(levels_db, seconds):
        parts.append(np.full(int(RATE * length), 10 ** (level / 20)))
    gain = np.concatenate(parts)
    if fade_s:
        gain = np.concatenate([gain, gain[-1] * np.linspace(1, 0, int(RATE * fade_s))])
    t = np.arange(len(gain)) / RATE
    tone = sum(np.sin(2 * np.pi * f * t) for f in (220, 277.2, 329.6)) * np.sqrt(2 / 3)  # RMS 1
    return (gain * tone).astype(np.float32)


def test_click_track_gives_its_tempo_and_beats():
    x, truth = click_track()
    result = measure.analyse(x, RATE)
    assert result["bpm"] == pytest.approx(120.0, rel=0.02)
    beats = np.array(result["beats"])
    assert len(beats) >= 0.9 * len(truth)
    for b in beats:   # every beat found is on a click
        assert np.abs(truth - b).min() < 0.020
    for b in truth[1:-1]:   # and every click (bar the ends) is found
        assert np.abs(beats - b).min() < 0.020


def test_loudness_is_in_tenths_of_a_second_and_smoothed():
    x = pad([-20], [10])
    result = measure.analyse(x, RATE)
    assert result["duration_s"] == pytest.approx(10.0, abs=0.01)
    assert len(result["loud"]) == 100
    assert result["loud"][50] == pytest.approx(-20.0, abs=0.2)


def test_pad_gives_one_rise_and_a_fade():
    x = pad([-30, -20], [20, 20], fade_s=5)
    result = measure.analyse(x, RATE)
    rises = [m for m in result["moves"] if m["kind"] == "rise"]
    drops = [m for m in result["moves"] if m["kind"] == "drop"]
    fades = [m for m in result["moves"] if m["kind"] == "fade"]
    assert len(rises) == 1 and abs(rises[0]["t"] - 20.0) <= 1.5
    assert rises[0]["db"] == pytest.approx(10.0, abs=1.5)
    assert drops == []
    assert len(fades) == 1 and abs(fades[0]["t"] - 40.0) <= 1.5
    assert [m["t"] for m in result["moves"]] == sorted(m["t"] for m in result["moves"])


def test_a_drop_is_found_and_a_small_change_is_not():
    x = pad([-20, -28, -24], [15, 15, 15])
    moves = measure.analyse(x, RATE)["moves"]
    assert [m["kind"] for m in moves] == ["drop"]
    assert abs(moves[0]["t"] - 15.0) <= 1.5 and moves[0]["db"] == pytest.approx(-8, abs=1.5)


def test_steady_sine_has_no_beats_and_no_error():
    t = np.arange(RATE * 20) / RATE
    x = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    result = measure.analyse(x, RATE)
    assert result["beats"] == []
    assert result["bpm"] is None


def test_silence_and_tiny_files_do_not_fail():
    for x in (np.zeros(RATE * 5, np.float32), np.zeros(10, np.float32), np.zeros(0, np.float32)):
        result = measure.analyse(x, RATE)
        assert result["beats"] == [] and result["bpm"] is None and result["moves"] == []


def run(*args):
    return subprocess.run([sys.executable, os.path.join(HERE, "measure.py"), *args],
                          capture_output=True, text=True, timeout=120)


def test_command_prints_progress_then_done(tmp_path):
    import soundfile as sf
    x, _ = click_track(seconds=12)
    path = tmp_path / "score.wav"
    sf.write(str(path), x, RATE)
    out = run(str(path))
    assert out.returncode == 0, out.stderr
    lines = [json.loads(line) for line in out.stdout.splitlines()]
    assert all("progress" in line and "text" in line for line in lines[:-1]) and len(lines) > 1
    done = lines[-1]
    assert done["done"] is True
    assert set(done) >= {"duration_s", "loud", "beats", "bpm", "moves"}
    assert done["bpm"] == pytest.approx(120, rel=0.02)


def test_command_reports_a_missing_file(tmp_path):
    out = run(str(tmp_path / "nothing.wav"))
    assert out.returncode != 0
    assert "error" in json.loads(out.stdout.splitlines()[-1])
