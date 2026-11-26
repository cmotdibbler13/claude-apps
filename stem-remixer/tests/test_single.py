"""Opening one file without splitting it, opening with a fit plan, and the
small pure parts of the window (with Tk stubbed out, so no display is needed)."""

import ast
import json
import os
import sys
import types

import numpy as np
import pytest
import soundfile as sf

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import fit
import separator
from mixer import Mixer, Stem

RATE = 44100


def tone(seconds=24.0, rate=RATE):
    t = np.arange(int(rate * seconds)) / rate
    left = 0.3 * np.sin(2 * np.pi * 220 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.25 * t))
    right = 0.2 * np.sin(2 * np.pi * 330 * t + 0.3)
    return np.stack([left, right], axis=1).astype(np.float32)


# A section used twice with different neighbours (Review Focus 2).
PLAN = {"steps": [
    {"from_s": 0.0, "to_s": 6.0, "tempo": 1.0, "xfade_s": 0.03},
    {"from_s": 8.0, "to_s": 14.5, "tempo": 0.95, "xfade_s": 2.5},
    {"from_s": 0.0, "to_s": 6.0, "tempo": 1.0, "xfade_s": 0.03},
    {"from_s": 15.0, "to_s": 23.0, "tempo": 1.06, "xfade_s": 0.0},
]}


@pytest.fixture
def song(tmp_path):
    path = tmp_path / "in" / "My Score.wav"
    path.parent.mkdir()
    sf.write(str(path), tone(), RATE, subtype="FLOAT")
    return str(path)


# ------------------------------------------------------------ single_project

def test_single_project_makes_a_folder_read_project_accepts(song, tmp_path):
    root = str(tmp_path / "Stems")
    folder = separator.single_project(song, root)
    assert folder == os.path.join(root, "My Score [single]")
    project = separator.read_project(folder)
    assert project is not None
    assert project["stems"] == ["score"] and project["model"] == "single"
    assert project["source"] == os.path.abspath(song)
    assert project["samplerate"] == RATE
    audio, rate = sf.read(os.path.join(folder, "score.wav"), dtype="float32", always_2d=True)
    assert rate == RATE
    assert np.array_equal(audio, sf.read(song, dtype="float32", always_2d=True)[0])
    stems, rate = separator.load_stems(folder, project["stems"])
    assert rate == RATE and stems["score"].shape == audio.shape


def test_single_project_is_reused_and_keeps_its_mix(song, tmp_path):
    root = str(tmp_path / "Stems")
    folder = separator.single_project(song, root)
    project = separator.read_project(folder)
    project["mix"] = {"tempo": 1.1}
    separator.write_project(folder, project)
    wav = os.path.join(folder, "score.wav")
    os.utime(wav, (1, 1))     # so a rewrite would show
    assert separator.single_project(song, root) == folder
    assert os.stat(wav).st_mtime == 1
    assert separator.read_project(folder)["mix"] == {"tempo": 1.1}


def test_single_project_rebuilds_when_the_source_changes(song, tmp_path):
    root = str(tmp_path / "Stems")
    folder = separator.single_project(song, root)
    shorter = tone(seconds=5.0)
    sf.write(song, shorter, RATE, subtype="FLOAT")
    os.utime(song, (2_000_000_000, 2_000_000_000))
    assert separator.single_project(song, root) == folder
    audio, _ = sf.read(os.path.join(folder, "score.wav"), dtype="float32", always_2d=True)
    assert len(audio) == len(shorter)


def test_single_project_converts_other_formats(tmp_path):
    path = str(tmp_path / "score.flac")
    sf.write(path, tone(seconds=2.0), 48000, subtype="PCM_24")
    folder = separator.single_project(path, str(tmp_path / "Stems"))
    info = sf.info(os.path.join(folder, "score.wav"))
    assert info.format == "WAV" and info.samplerate == 48000
    assert separator.read_project(folder)["samplerate"] == 48000


def test_single_project_refuses_what_is_not_audio(tmp_path):
    path = tmp_path / "notes.wav"
    path.write_text("not audio")
    with pytest.raises(separator.SplitError, match="notes.wav"):
        separator.single_project(str(path), str(tmp_path / "Stems"))
    assert not os.path.exists(tmp_path / "Stems" / "notes [single]" / "project.json")


# ------------------------------------------------------- applying a fit plan

def test_apply_plan_matches_plan_to_sections():
    length = len(tone())
    old = {"tempo": 1.2, "pitch": 2, "master": 0.5, "loop": {"start": 0, "end": 99, "on": True},
           "sections": [{"name": "Old", "start": 0, "end": 1000, "tempo": 1.0, "xfade": 0.0}],
           "chain": {"steps": [0], "on": False}, "stems": {"score": {"volume": 0.2}}}
    settings = separator.apply_plan_to_settings(old, PLAN, RATE, length)
    sections, chain = fit.plan_to_sections(PLAN, RATE, length=length)
    assert [(s["start"], s["end"], s["tempo"], s["xfade"]) for s in settings["sections"]] == \
        [(s["start"], s["end"], s["tempo"], s["xfade"]) for s in sections]
    assert [s["name"] for s in settings["sections"]] == ["Step 1", "Step 2", "Step 3"]
    assert settings["chain"] == {"steps": chain, "on": True}
    # The plan is heard as fit.py renders it: nothing else changes the sound.
    assert settings["tempo"] == 1.0 and settings["pitch"] == 0 and settings["master"] == 1.0
    assert settings["loop"] is None and "stems" not in settings
    assert old["sections"][0]["name"] == "Old"    # the input is left alone


def test_apply_plan_refuses_a_bad_plan():
    with pytest.raises(ValueError):
        separator.apply_plan_to_settings({}, {"steps": []}, RATE, RATE * 10)


def test_open_single_with_a_plan_writes_the_mix(song, tmp_path):
    root = str(tmp_path / "Stems")
    plan_path = tmp_path / "plan.json"
    plan_path.write_text(json.dumps(PLAN))
    folder, project = separator.open_single(song, root, str(plan_path))
    saved = separator.read_project(folder)
    assert saved == project
    assert [s["name"] for s in saved["mix"]["sections"]] == ["Step 1", "Step 2", "Step 3"]
    assert saved["mix"]["chain"] == {"steps": [0, 1, 0, 2], "on": True}
    # Without a plan, the mix is left as it was.
    folder, again = separator.open_single(song, root)
    assert again["mix"] == saved["mix"]


def test_open_single_names_a_bad_plan(song, tmp_path):
    plan_path = tmp_path / "plan.json"
    plan_path.write_text("{not json")
    with pytest.raises(ValueError, match="plan.json"):
        separator.open_single(song, str(tmp_path / "Stems"), str(plan_path))


def test_app_path_plays_what_fit_renders(song, tmp_path):
    """Review Focus 2 at app level: the --plan path, loaded the way the window
    loads a project, renders the chain exactly as fit.py does."""
    plan_path = tmp_path / "plan.json"
    plan_path.write_text(json.dumps(PLAN))
    folder, project = separator.open_single(song, str(tmp_path / "Stems"), str(plan_path))
    audio, rate = separator.load_stems(folder, project["stems"])
    mixer = Mixer([Stem(name, audio[name]) for name in project["stems"]], rate)
    mixer.apply_settings(project["mix"])
    assert mixer.chaining
    ours, our_factor = mixer.render_chain()
    x, score_rate = sf.read(song, dtype="float32", always_2d=True)
    theirs, their_factor = fit.render_plan(x, score_rate, PLAN, out_rate=score_rate)
    assert ours.shape == theirs.shape
    assert np.max(np.abs(ours - theirs)) < 1e-4
    assert our_factor == their_factor


# ------------------------------------------------------------------ main.py

def test_main_parses_open_and_plan_and_ignores_the_rest():
    import main
    args = main.parse_args(["--open", r"C:\x\score.wav", "--plan", "p.json", "--whatever", "1"])
    assert args.open == r"C:\x\score.wav" and args.plan == "p.json"
    args = main.parse_args([])
    assert args.open is None and args.plan is None
    assert main.parse_args(["--open"]).open is None   # a broken call still starts the app


# ------------------------------------------------- app.py, with Tk stubbed

def test_app_parses():
    with open(os.path.join(HERE, "app.py"), encoding="utf-8") as handle:
        ast.parse(handle.read())


class _Anything:
    def __init__(self, *args, **kwargs):
        pass

    def __getattr__(self, name):
        return _Anything


def _stub(name):
    module = types.ModuleType(name)
    module.__path__ = []     # a package, so its submodules can be stubbed too
    module.__getattr__ = lambda attr: _Anything
    return module


@pytest.fixture
def app_module(monkeypatch):
    import importlib
    for name in ("tkinter", "tkinter.filedialog", "tkinter.messagebox",
                 "tkinter.simpledialog", "customtkinter"):
        try:
            importlib.import_module(name)
        except ImportError:
            monkeypatch.setitem(sys.modules, name, _stub(name))
    monkeypatch.delitem(sys.modules, "app", raising=False)
    import app
    return app


def test_section_text_shows_tempo_and_crossfade(app_module):
    text = app_module.section_text
    section = {"name": "Intro", "start": 0, "end": RATE * 5, "tempo": 1.0, "xfade": 0.0}
    assert text(section, RATE) == "Intro"
    assert text(dict(section, tempo=0.97, xfade=0.03), RATE) == "Intro · 97 % · xf 30 ms"
    assert text(dict(section, tempo=1.025), RATE) == "Intro · 102.5 %"
    assert text(dict(section, xfade=2.5), RATE) == "Intro · xf 2.5 s"
    assert text(dict(section, name=""), RATE) == "0:00 to 0:05"


def test_chain_text_reads_numbers_past_nine(app_module):
    parse = app_module.parse_chain
    assert parse("1 2 2 3", 4) == [0, 1, 1, 2]
    assert parse("1223", 4) == [0, 1, 1, 2]        # digits, as before, up to nine sections
    assert parse("1 2 10 12", 12) == [0, 1, 9, 11]
    assert parse("1, 11", 11) == [0, 10]
