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


def peak_hz(audio):
    spectrum = np.abs(np.fft.rfft(audio[:, 0] * np.hanning(len(audio))))
    return np.argmax(spectrum) * RATE / len(audio)


def rms(audio):
    return float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))


@pytest.mark.parametrize("tempo", [0.6, 0.85, 1.25, 1.5])
def test_tempo_changes_length_but_not_pitch(tempo):
    mixer = Mixer([Stem("a", tone(440, 3.0))], RATE)
    mixer.tempo = tempo
    audio, _ = mixer.render_all()
    assert len(audio) == pytest.approx(3 * RATE / tempo, abs=2)
    assert peak_hz(audio) == pytest.approx(440, abs=1.5)
    middle = audio[RATE // 2:-RATE // 2]
    assert rms(middle) == pytest.approx(0.25 / np.sqrt(2), rel=0.05)  # no warble or level change


@pytest.mark.parametrize("pitch", [-5, 3])
def test_pitch_changes_pitch_but_not_length(pitch):
    mixer = Mixer([Stem("a", tone(440, 3.0))], RATE)
    mixer.pitch = pitch
    audio, _ = mixer.render_all()
    assert len(audio) == pytest.approx(3 * RATE, abs=2)
    assert peak_hz(audio) == pytest.approx(440 * 2 ** (pitch / 12), abs=1.5)


def test_tempo_and_pitch_together_like_a_record_deck():
    mixer = Mixer([Stem("a", tone(440, 2.0))], RATE)
    mixer.pitch = 6
    mixer.tempo = mixer.pitch_ratio
    audio, _ = mixer.render_all()
    assert len(audio) == pytest.approx(2 * RATE / mixer.tempo, abs=2)
    assert peak_hz(audio) == pytest.approx(440 * mixer.tempo, abs=2)


def test_tempo_keeps_drum_hits_in_time():
    clicks = np.zeros(RATE * 4, np.float32)
    clicks[::RATE // 2] = 0.9  # a hit every half second
    mixer = Mixer([Stem("d", clicks)], RATE)
    mixer.tempo = 0.8
    audio, _ = mixer.render_all()
    hits = np.flatnonzero(np.abs(audio[:, 0]) > 0.3)
    starts = hits[np.insert(np.diff(hits) > 2000, 0, True)]
    assert len(starts) == 8
    assert np.allclose(np.diff(starts), RATE / 2 / 0.8, atol=1100)


@pytest.mark.parametrize("tempo,pitch", [(0.8, 0), (1.0, 2), (2 ** (3 / 12), 3)])
def test_blocks_match_the_export(tempo, pitch):
    mixer = Mixer([Stem("a", tone(440, 2.0)), Stem("b", tone(660, 2.0))], RATE)
    mixer.tempo, mixer.pitch = tempo, pitch
    whole, _ = mixer.render_all()
    blocks = []
    while not mixer.ended:
        blocks.append(mixer.render_block(441))
        assert 0 <= mixer.position <= mixer.length
    played = np.concatenate(blocks)
    assert len(played) >= len(whole) - 441
    size = min(len(played), len(whole))
    assert np.allclose(played[:size], whole[:size], atol=1e-4)


def test_seek_while_stretching():
    mixer = Mixer([Stem("a", tone(440, 4.0))], RATE)
    mixer.tempo = 0.5
    mixer.render_block(4096)
    assert 0 < mixer.position < 4096  # half speed: fewer song frames than output frames
    mixer.seek(2 * RATE)
    mixer.render_block(441)
    assert mixer.position == pytest.approx(2 * RATE + 220, abs=5)


def test_stretching_keeps_up_with_playback():
    import time
    rng = np.random.default_rng(0)
    stems = [Stem(f"s{i}", rng.standard_normal((RATE * 10, 2)).astype(np.float32) * 0.05)
             for i in range(6)]
    mixer = Mixer(stems, RATE)
    mixer.tempo, mixer.pitch = 0.8, 2
    started = time.perf_counter()
    for _ in range(100):
        mixer.render_block(441)  # one second of sound
    assert time.perf_counter() - started < 0.5


def test_export_is_turned_down_rather_than_clipped():
    mixer = make(0.8, 0.8)
    audio, factor = mixer.render_all()
    assert factor == pytest.approx(EXPORT_CEILING / 1.6)
    assert np.abs(audio).max() == pytest.approx(EXPORT_CEILING)
    block = mixer.render_block(10)
    assert mixer.clipped and np.abs(block).max() <= 1.0


def test_settings_round_trip():
    mixer = make(0.1, 0.2)
    mixer.tempo, mixer.pitch, mixer.master = 0.9, -2, 1.2
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


class FakeSound:
    """Stands in for sounddevice: a PC whose default output only opens in mono."""

    class default:
        device = (0, 1)

    def __init__(self, works):
        self.works = works   # set of (device, channels) that open
        self.tried = []
        outer = self

        class OutputStream:
            def __init__(self, samplerate, channels, dtype, device, extra_settings, callback):
                outer.tried.append((device, channels))
                if (device, channels) not in outer.works:
                    raise RuntimeError("Invalid number of channels [PaErrorCode -9998]")
                self.device, self.channels, self.callback, self.active = device, channels, callback, False

            def start(self):
                self.active = True

            def abort(self):
                self.active = False

            def close(self):
                pass

        self.OutputStream = OutputStream

    def WasapiSettings(self, auto_convert=False):
        return "wasapi"

    def query_hostapis(self):
        return [{"name": "MME", "default_output_device": 1},
                {"name": "Windows WASAPI", "default_output_device": 3},
                {"name": "Windows WDM-KS", "default_output_device": 4}]

    def query_devices(self, index=None):
        devices = [{"name": "Mic", "hostapi": 0, "max_output_channels": 0},
                   {"name": "Headset (MME)", "hostapi": 0, "max_output_channels": 1},
                   {"name": "Mic", "hostapi": 1, "max_output_channels": 0},
                   {"name": "Speakers (WASAPI)", "hostapi": 1, "max_output_channels": 8},
                   {"name": "Speakers (KS)", "hostapi": 2, "max_output_channels": 2}]
        return devices if index is None else devices[index]


def play_with(monkeypatch, works):
    from mixer import Player
    fake = FakeSound(works)
    monkeypatch.setitem(sys.modules, "sounddevice", fake)
    left = np.full(1000, 0.2, np.float32)
    player = Player()
    player.load(Mixer([Stem("a", np.stack([left, left * 0], axis=1))], RATE))
    return player, fake


def test_player_falls_back_to_a_mono_output(monkeypatch):
    player, fake = play_with(monkeypatch, {(1, 1)})
    player.play()
    assert fake.tried == [(None, 2), (1, 1)]
    assert player.playing and player.mono and player.device_name == "Headset (MME)"
    out = np.ones((64, 1), np.float32)
    player._callback(out, 64, None, None)
    assert np.allclose(out, 0.1)  # left and right averaged
    player.stop()
    assert not player.playing


def test_player_tries_other_drivers_and_fills_surround(monkeypatch):
    player, fake = play_with(monkeypatch, {(3, 2)})
    player.play()
    assert fake.tried == [(None, 2), (1, 1), (3, 2)]  # then WASAPI, before WDM-KS
    assert not player.mono
    out = np.ones((64, 8), np.float32)
    player._callback(out, 64, None, None)
    assert np.allclose(out[:, 0], 0.2) and np.allclose(out[:, 1:], 0.0)


def test_player_explains_when_nothing_opens(monkeypatch):
    player, _ = play_with(monkeypatch, set())
    with pytest.raises(RuntimeError, match="sound output"):
        player.play()
    assert not player.playing


def test_quiet_console_gives_a_windowed_app_somewhere_to_print(monkeypatch):
    monkeypatch.setattr(sys, "stdout", None)
    monkeypatch.setattr(sys, "stderr", None)
    separator.quiet_console()
    print("a progress bar", file=sys.stderr)
    sys.stdout.write("and another")


def ramp_mixer(seconds=2.0):
    """A stem whose value is its own position, so a block shows where it came from."""
    n = int(RATE * seconds)
    return Mixer([Stem("r", np.linspace(0, 0.5, n, dtype=np.float32))], RATE), n


def test_loop_needs_a_real_section():
    mixer, n = ramp_mixer()
    assert not mixer.set_loop(1000, 1200)
    assert mixer.loop_start is None and not mixer.looping
    assert mixer.set_loop(30000, 10000)  # either order
    assert (mixer.loop_start, mixer.loop_end) == (10000, 30000)
    assert not mixer.looping  # marked but not switched on
    mixer.loop_on = True
    assert mixer.looping


def test_loop_goes_round_and_never_ends():
    mixer, n = ramp_mixer()
    mixer.set_loop(10000, 20000)
    mixer.loop_on = True
    mixer.seek(9000)  # starting before the section plays into it
    seen = []
    for _ in range(100):
        block = mixer.render_block(441)
        seen.append(mixer.position)
        assert not mixer.ended
    assert max(seen) <= 20000 and min(seen[5:]) >= 10000
    assert sum(b < a for a, b in zip(seen, seen[1:])) == 4  # 44100 frames = 4 and a bit laps
    # the join dips to silence instead of jumping
    mixer.seek(19900)
    block = mixer.render_block(441)[:, 0]
    assert abs(block[99]) < 0.01 and abs(block[100]) < 0.01
    assert np.abs(np.diff(block)).max() < 0.01
    assert block[300] == pytest.approx(0.5 * 10200 / n, abs=1e-3)  # back in the section, at full level


def test_playing_after_the_loop_carries_on_to_the_end():
    mixer, n = ramp_mixer()
    mixer.set_loop(10000, 20000)
    mixer.loop_on = True
    mixer.seek(n - 1000)
    mixer.render_block(2000)
    assert mixer.ended


@pytest.mark.parametrize("tempo,pitch", [(0.8, 0), (1.0, 3)])
def test_loop_while_stretching(tempo, pitch):
    mixer = Mixer([Stem("a", tone(440, 4.0))], RATE)
    mixer.tempo, mixer.pitch = tempo, pitch
    mixer.set_loop(RATE, 2 * RATE)
    mixer.loop_on = True
    mixer.seek(RATE)
    blocks, seen = [], []
    for _ in range(400):  # four seconds of sound
        blocks.append(mixer.render_block(441))
        seen.append(mixer.position)
    assert not mixer.ended
    assert min(seen) >= RATE and max(seen) <= 2 * RATE + 1
    assert sum(b < a for a, b in zip(seen, seen[1:])) == int(4 * tempo)
    audio = np.concatenate(blocks)
    assert rms(audio[RATE:]) == pytest.approx(0.25 / np.sqrt(2), rel=0.08)  # no gaps at the joins


def test_export_of_a_section():
    mixer, n = ramp_mixer()
    audio, _ = mixer.render_all(section=(10000, 20000))
    assert len(audio) == 10000
    assert audio[0, 0] == pytest.approx(0.5 * 10000 / n, abs=1e-4)
    mixer.tempo = 0.5
    audio, _ = mixer.render_all(section=(10000, 20000))
    assert len(audio) == 20000


def test_loop_is_saved_and_reset():
    mixer, n = ramp_mixer()
    mixer.set_loop(10000, 20000)
    mixer.loop_on = True
    other, _ = ramp_mixer()
    other.apply_settings(mixer.settings())
    assert (other.loop_start, other.loop_end, other.loop_on) == (10000, 20000, True)
    other.reset()
    assert other.loop_start is None and not other.looping
    assert other.settings()["loop"] is None


def test_saved_sections():
    mixer, n = ramp_mixer()
    assert mixer.save_section() is None  # nothing marked
    mixer.set_loop(10000, 20000)
    assert mixer.save_section("verse") == 0
    assert mixer.save_section() == 0  # the same section isn't saved twice
    mixer.set_loop(30000, 50000)
    assert mixer.active_section() is None
    assert mixer.save_section() == 1
    assert mixer.select_section(0) and mixer.looping
    assert (mixer.loop_start, mixer.loop_end, mixer.position) == (10000, 20000, 10000)
    assert mixer.active_section() == 0
    assert not mixer.select_section(5)

    other, _ = ramp_mixer()
    other.apply_settings(mixer.settings())
    assert [s["name"] for s in other.sections] == ["verse", ""]
    other.reset()
    assert len(other.sections) == 2 and other.loop_start is None  # reset keeps them
    other.delete_section(0)
    assert other.sections[0]["start"] == 30000

    for i in range(20):
        mixer.set_loop(i * 4000, i * 4000 + 5000)
        mixer.save_section()
    assert len(mixer.sections) == 9
    junk = {"sections": [{"start": 5, "end": 6}, {"start": "x"}, "no", {"start": 0, "end": 9e9},
                         {"start": 100, "end": 9000, "name": 7}]}
    other.apply_settings(junk)
    assert other.sections == [{"name": "7", "start": 100.0, "end": 9000.0}]


def chain_mixer():
    mixer, n = ramp_mixer(4.0)
    for start in (10000, 60000, 110000):
        mixer.set_loop(start, start + 10000)
        mixer.save_section()
    mixer.clear_loop()
    return mixer, n


@pytest.mark.parametrize("tempo", [1.0, 0.8])
def test_chain_plays_sections_in_order_and_goes_round(tempo):
    mixer, n = chain_mixer()
    mixer.tempo = tempo
    assert mixer.set_chain([2, 0, 0, 7]) == [2, 0, 0]  # section 8 doesn't exist
    assert mixer.start_chain() and mixer.position == 110000
    steps, where = [], []
    for _ in range(int(120 / tempo)):  # a bit over one time round
        mixer.render_block(441)
        steps.append(mixer.chain_step)
        where.append(mixer.position)
        section = mixer.sections[mixer.chain[mixer.chain_step]]
        assert section["start"] <= mixer.position <= section["end"] + 1
    changes = [b for a, b in zip(steps, steps[1:]) if a != b]
    assert changes[:3] == [1, 2, 0]
    assert not mixer.ended
    assert sum(b < a for a, b in zip(where, where[1:])) >= 2  # jumped back for the 0, 0


def test_chain_export_is_the_sections_end_to_end():
    mixer, n = chain_mixer()
    mixer.set_chain([1, 0])
    audio, _ = mixer.render_chain()
    assert len(audio) == 20000
    assert audio[5000, 0] == pytest.approx(0.5 * 65000 / n, abs=1e-3)
    assert audio[15000, 0] == pytest.approx(0.5 * 15000 / n, abs=1e-3)
    assert abs(audio[10000, 0]) < 0.01 and abs(audio[0, 0]) < 0.01  # joins dip, no click
    mixer.tempo = 0.5
    assert len(mixer.render_chain()[0]) == 40000


def test_chain_survives_saving_deleting_and_seeking():
    mixer, n = chain_mixer()
    mixer.set_chain([0, 1, 2, 1])
    mixer.chain_on = True
    other, _ = ramp_mixer(4.0)
    other.apply_settings(mixer.settings())
    assert other.chain == [0, 1, 2, 1] and other.chaining
    other.seek(115000)  # clicking into section 3 carries on from there
    assert other.chain_step == 2
    other.delete_section(1)
    assert other.chain == [0, 1] and len(other.sections) == 2
    other.delete_section(0)
    other.delete_section(0)
    assert other.chain == [] and not other.chaining and other.region() is None
    other.reset()
    assert not other.chain_on


def test_equalise_moves_only_its_band():
    low, mid, high = tone(60, 1.0), tone(1000, 1.0), tone(12000, 1.0)
    stem = Stem("x", low + mid + high)
    mixer = Mixer([stem], RATE)
    stem.eq = [-12.0, 0.0, 6.0]
    stem.apply_eq()
    assert stem.data.shape == stem.source.shape and stem.data is not stem.source
    spectrum = np.abs(np.fft.rfft(stem.data[:, 0])) / (RATE / 2)
    assert spectrum[60] == pytest.approx(0.25 * 10 ** (-12 / 20), rel=0.03)
    assert spectrum[1000] == pytest.approx(0.25, rel=0.03)
    assert spectrum[12000] == pytest.approx(0.25 * 10 ** (6 / 20), rel=0.03)
    assert np.allclose(mixer.render_block(64), stem.data[:64])
    saved = mixer.settings()
    assert saved["stems"]["x"]["eq"] == [-12.0, 0.0, 6.0]
    stem.reset()
    assert stem.data is stem.source and stem.eq == [0.0, 0.0, 0.0]
    stem.apply_settings({"eq": [99, "x", 0]})
    assert stem.eq == [0.0, 0.0, 0.0]
    stem.apply_settings({"eq": [99, -99, 3]})
    assert stem.eq == [12.0, -12.0, 3.0]


def test_levels_follow_what_is_heard():
    mixer = make(0.5, 0.2)
    mixer.stems[1].mute = True
    mixer.master = 0.5
    mixer.render_block(64)
    assert mixer.levels[0] == pytest.approx(0.25) and mixer.levels[1] == 0
    assert mixer.master_level == pytest.approx(0.25)
