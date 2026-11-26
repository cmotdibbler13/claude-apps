import json
import os
import subprocess
import sys

import numpy as np
import pytest
import soundfile as sf

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import fit
from mixer import Mixer, Stem

RATE = 44100


def score(seconds=30.0, rate=RATE):
    t = np.arange(int(rate * seconds)) / rate
    left = 0.3 * np.sin(2 * np.pi * 220 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.25 * t))
    right = 0.2 * np.sin(2 * np.pi * 330 * t)
    return np.stack([left, right], axis=1).astype(np.float32)


PLAN = {"steps": [
    {"from_s": 0.0, "to_s": 8.0, "tempo": 1.0, "xfade_s": 0.03},
    {"from_s": 10.0, "to_s": 18.5, "tempo": 0.95, "xfade_s": 2.5},
    {"from_s": 0.0, "to_s": 8.0, "tempo": 1.0, "xfade_s": 0.03},
]}


def test_plan_to_sections_converts_and_dedupes():
    sections, chain = fit.plan_to_sections(PLAN, RATE)
    assert chain == [0, 1, 0]
    assert len(sections) == 2
    assert sections[0]["start"] == 0 and sections[0]["end"] == 8 * RATE
    assert sections[1]["start"] == 10 * RATE and sections[1]["end"] == int(18.5 * RATE)
    assert sections[1]["tempo"] == 0.95 and sections[1]["xfade"] == 2.5
    assert sections[0]["xfade"] == 0.03 and all(s["name"] for s in sections)
    # Same span, different tempo or crossfade: a section of its own.
    other = {"steps": PLAN["steps"] + [{"from_s": 0.0, "to_s": 8.0, "tempo": 1.0, "xfade_s": 0.5}]}
    sections, chain = fit.plan_to_sections(other, RATE)
    assert chain == [0, 1, 0, 2] and len(sections) == 3


def test_plan_to_sections_defaults_and_refusals():
    sections, chain = fit.plan_to_sections({"steps": [{"from_s": 1, "to_s": 2}]}, RATE)
    assert sections[0]["tempo"] == 1.0 and sections[0]["xfade"] == 0.0 and chain == [0]
    sections, _ = fit.plan_to_sections({"steps": [{"from_s": 1, "to_s": 99}]}, RATE, length=RATE * 10)
    assert sections[0]["end"] == RATE * 10 - 1   # clamped to the score's end
    for bad in ({}, {"steps": []}, {"steps": [{"from_s": 3, "to_s": 2}]},
                {"steps": [{"from_s": "a", "to_s": 2}]}, {"steps": [{"from_s": 0, "to_s": 2, "tempo": 3}]},
                {"steps": [{"from_s": 0, "to_s": 2, "xfade_s": -1}]}, {"steps": "x"}):
        with pytest.raises(ValueError):
            fit.plan_to_sections(bad, RATE)
    with pytest.raises(ValueError, match="Step 1"):
        fit.plan_to_sections({"steps": [{"from_s": 20, "to_s": 30}]}, RATE, length=RATE * 10)


def test_render_plan_matches_the_app_chain_at_48k():
    x = score(rate=48000)
    out, factor = fit.render_plan(x, 48000, PLAN)
    mixer = Mixer([Stem("score", x)], 48000)
    mixer.sections, chain = fit.plan_to_sections(PLAN, 48000, length=len(x))
    mixer.set_chain(chain)
    whole, _ = mixer.render_chain()
    assert factor == 1.0
    assert out.shape == whole.shape and np.array_equal(out, whole)


def test_resample_keeps_length_and_tone():
    t = np.arange(RATE * 2) / RATE
    x = np.stack([np.sin(2 * np.pi * 1000 * t)] * 2, axis=1).astype(np.float32)
    y = fit.resample(x, RATE, 48000)
    assert len(y) == 96000 and y.dtype == np.float32
    ref = np.sin(2 * np.pi * 1000 * np.arange(96000) / 48000)
    assert np.abs(y[2000:-2000, 0] - ref[2000:-2000]).max() < 1e-3


@pytest.mark.parametrize("rate", [44100, 22050, 96000])
def test_resample_joins_its_chunks_seamlessly(rate):
    seconds = 25.0   # three chunks
    t = np.arange(int(rate * seconds)) / rate
    x = np.stack([np.sin(2 * np.pi * 440 * t), 0.5 * np.sin(2 * np.pi * 3000 * t)], axis=1)
    calls = []
    y = fit.resample(x.astype(np.float32), rate, 48000, calls.append)
    assert len(y) == int(round(len(x) * 48000 / rate))
    assert len(calls) >= 3 and calls[-1] == 1.0 and calls == sorted(calls)
    u = np.arange(len(y)) / 48000
    inner = slice(4800, -4800)
    assert np.abs(y[inner, 0] - np.sin(2 * np.pi * 440 * u)[inner]).max() < 1e-3
    assert np.abs(y[inner, 1] - 0.5 * np.sin(2 * np.pi * 3000 * u)[inner]).max() < 1e-3


def test_loud_plans_are_turned_down_and_reported():
    x = score() * 4.0   # over full scale
    out, factor = fit.render_plan(x, RATE, PLAN)
    assert factor < 1.0 and np.abs(out).max() <= 1.0 + 1e-3


def run(*args):
    return subprocess.run([sys.executable, os.path.join(HERE, "fit.py"), *map(str, args)],
                          capture_output=True, text=True, timeout=120)


def test_command_writes_a_48k_wav_of_the_chain_length(tmp_path):
    src, plan, out = tmp_path / "score.wav", tmp_path / "plan.json", tmp_path / "fit.wav"
    x = score()
    sf.write(str(src), x, RATE)
    plan.write_text(json.dumps(PLAN))
    done = run(src, plan, out)
    assert done.returncode == 0, done.stderr
    lines = [json.loads(line) for line in done.stdout.splitlines()]
    assert len(lines) > 1 and all("progress" in line for line in lines[:-1])
    assert lines[-1]["done"] is True and lines[-1]["out"] == str(out)
    assert "turned_down" not in lines[-1]
    info = sf.info(str(out))
    assert info.samplerate == 48000 and info.channels == 2
    mixer = Mixer([Stem("score", x)], RATE)
    mixer.sections, chain = fit.plan_to_sections(PLAN, RATE, length=len(x))
    mixer.set_chain(chain)
    assert abs(info.frames - mixer.chain_length_s() * 48000) <= 1
    assert lines[-1]["length_s"] == pytest.approx(info.frames / 48000, abs=1e-3)
    assert [p.name for p in tmp_path.iterdir()] and not any(".tmp" in p.name for p in tmp_path.iterdir())


def test_command_reports_a_bad_plan(tmp_path):
    src, plan = tmp_path / "score.wav", tmp_path / "plan.json"
    sf.write(str(src), score(5), RATE)
    plan.write_text(json.dumps({"steps": []}))
    done = run(src, plan, tmp_path / "fit.wav")
    assert done.returncode != 0
    assert "error" in json.loads(done.stdout.splitlines()[-1])
    assert not (tmp_path / "fit.wav").exists()


def test_command_names_a_score_it_cannot_read(tmp_path):
    src, plan = tmp_path / "score.wav", tmp_path / "plan.json"
    src.write_text("not audio")
    plan.write_text(json.dumps(PLAN))
    done = run(src, plan, tmp_path / "fit.wav")
    assert done.returncode != 0
    error = json.loads(done.stdout.splitlines()[-1])["error"]
    assert error.startswith("Couldn't read score.wav as audio. ") and len(error) > 40
