import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import separator
from mixer import EXPORT_CEILING, Mixer, Stem, pan_gains, waveform_peaks, write_audio

RATE = 44100


def tone(freq, seconds=1.0, level=0.25):
    t = np.arange(int(RATE * seconds)) / RATE
    return (level * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def make(*levels):
    return Mixer([Stem(f"s{i}", np.full((1000, 2), v, np.float32))
                  for i, v in enumerate(levels)], RATE)


def test_mono_stems_become_stereo():
    assert Stem("x", tone(440)).data.shape == (RATE, 2)


def test_block_is_the_sum_of_the_stems():
    mixer = make(0.1, 0.2)
    assert np.allclose(mixer.render_block(64), 0.3)
    assert mixer.position == 64


def test_mute_and_solo():
    mixer = make(0.1, 0.2, 0.4)
    mixer.stems[0].mute = True
    assert np.allclose(mixer.render_all()[0], 0.6)
    mixer.stems[1].solo = True
    assert np.allclose(mixer.render_all()[0], 0.2)
    mixer.stems[0].solo = True  # solo wins over that stem's own mute
    assert np.allclose(mixer.render_all()[0], 0.3)


def test_volume_master_and_pan():
    mixer = make(0.2)
    mixer.stems[0].volume = 0.5
    mixer.master = 0.5
    mixer.stems[0].pan = -1.0
    audio, _ = mixer.render_all()
    assert np.allclose(audio[:, 0], 0.05) and np.allclose(audio[:, 1], 0.0)
    assert pan_gains(0.0) == (1.0, 1.0)
    assert pan_gains(0.5) == (0.5, 1.0)


def test_mute_glides_instead_of_clicking():
    mixer = make(0.5)
    mixer.render_block(100)
    mixer.stems[0].mute = True
    block = mixer.render_block(100)[:, 0]
    assert block[0] == pytest.approx(0.5) and 0 < block[50] < 0.5
    assert np.all(np.diff(block) < 0)
    assert np.allclose(mixer.render_block(100), 0.0)


def test_playback_reaches_the_end():
    mixer = make(0.1)
    mixer.render_block(600)
    block = mixer.render_block(600)
    assert mixer.ended and np.allclose(block[400:], 0.0)
    mixer.seek(0)
    assert not mixer.ended and mixer.position == 0


def test_speed_changes_length_and_pitch():
    mixer = Mixer([Stem("a", tone(440))], RATE)
    mixer.speed = 1.25
    audio, _ = mixer.render_all()
    assert len(audio) == pytest.approx(RATE / 1.25, abs=2)
    spectrum = np.abs(np.fft.rfft(audio[:, 0]))
    peak_hz = np.argmax(spectrum) * RATE / len(audio)
    assert peak_hz == pytest.approx(550, abs=3)


def test_blocks_at_speed_match_the_export():
    mixer = Mixer([Stem("a", tone(440)), Stem("b", tone(660))], RATE)
    mixer.speed = 0.8
    whole, _ = mixer.render_all()
    blocks = []
    while not mixer.ended:
        blocks.append(mixer.render_block(512))
    played = np.concatenate(blocks)[:len(whole)]
    assert np.allclose(played, whole, atol=1e-4)


def test_export_is_turned_down_rather_than_clipped():
    mixer = make(0.8, 0.8)
    audio, factor = mixer.render_all()
    assert factor == pytest.approx(EXPORT_CEILING / 1.6)
    assert np.abs(audio).max() == pytest.approx(EXPORT_CEILING)
    block = mixer.render_block(10)
    assert mixer.clipped and np.abs(block).max() <= 1.0


def test_settings_round_trip():
    mixer = make(0.1, 0.2)
    mixer.speed, mixer.master = 0.9, 1.2
    mixer.stems[1].apply_settings({"volume": 9, "pan": -0.4, "mute": True})
    saved = mixer.settings()
    other = make(0.1, 0.2)
    other.apply_settings(saved)
    assert other.settings() == saved
    assert other.stems[1].volume == 1.5  # clamped to the slider's range
    other.reset()
    assert other.settings() == make(0.1, 0.2).settings()


def test_waveform_peaks():
    data = np.zeros((1000, 2), np.float32)
    data[750:, 1] = -0.5
    peaks = waveform_peaks(data, bins=4)
    assert np.allclose(peaks, [0, 0, 0, 0.5])
    assert len(waveform_peaks(np.zeros((3, 2), np.float32), bins=10)) == 3


@pytest.mark.parametrize("ext", [".wav", ".mp3"])
def test_write_audio(tmp_path, ext):
    import soundfile as sf
    path = str(tmp_path / ("mix" + ext))
    audio = np.stack([tone(440), tone(440)], axis=1)
    write_audio(path, audio, RATE)
    back, rate = sf.read(path, dtype="float32")
    assert rate == RATE and back.shape[1] == 2
    assert abs(len(back) - RATE) < 3000  # MP3 pads a little
    assert np.abs(back).max() == pytest.approx(0.25, abs=0.02)


def test_project_folders(tmp_path):
    folder = separator.project_dir(r"C:\Music\AC/DC: Back?.mp3", "htdemucs", str(tmp_path))
    assert os.path.basename(folder) == "DC_ Back_ [htdemucs]"
    assert separator.read_project(folder) is None
    os.makedirs(folder)
    import soundfile as sf
    for name in ("other", "vocals", "drums", "bass"):
        sf.write(os.path.join(folder, name + ".wav"), tone(220, 0.1), RATE)
    assert separator.loose_stems(folder) == ["vocals", "drums", "bass", "other"]
    assert separator.read_project(folder) is None  # no project.json yet
    separator.write_project(folder, {"stems": ["vocals", "drums", "bass", "other"]})
    assert separator.read_project(folder)["stems"][0] == "vocals"
    os.remove(os.path.join(folder, "bass.wav"))
    assert separator.read_project(folder) is None  # a stem went missing
    stems, rate = separator.load_stems(folder, ["vocals", "drums"])
    assert rate == RATE and stems["vocals"].shape == (4410, 1)


def test_split_progress():
    info = {"models": 4, "model_idx_in_bag": 1, "segment_offset": 50, "audio_length": 100}
    assert separator.split_progress(info) == pytest.approx(0.375)
    assert separator.split_progress({}) == 0.0
