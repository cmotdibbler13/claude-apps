"""Stem Remixer: the mixing engine.

Holds the separated stems in memory and mixes them on demand, either a block
at a time for live playback or the whole song at once for an export. Pure
NumPy, so it can be tested without a sound card.
"""

import numpy as np

MAX_VOLUME = 1.5      # sliders go up to 150%
MIN_SPEED = 0.5
MAX_SPEED = 1.5
EXPORT_CEILING = 0.98  # exports louder than full scale are turned down to this
_EXPORT_CHUNK = 1 << 18


class Stem:
    """One separated part of the song (vocals, drums, ...)."""

    def __init__(self, name: str, data: np.ndarray):
        data = np.asarray(data, dtype=np.float32)
        if data.ndim == 1:
            data = data[:, None]
        if data.shape[1] == 1:
            data = np.repeat(data, 2, axis=1)
        self.name = name
        self.data = np.ascontiguousarray(data[:, :2])
        self.volume = 1.0   # 0 .. MAX_VOLUME
        self.pan = 0.0      # -1 (left) .. +1 (right)
        self.mute = False
        self.solo = False

    def reset(self) -> None:
        self.volume, self.pan, self.mute, self.solo = 1.0, 0.0, False, False

    def settings(self) -> dict:
        return {"volume": self.volume, "pan": self.pan,
                "mute": self.mute, "solo": self.solo}

    def apply_settings(self, values: dict) -> None:
        self.volume = float(np.clip(values.get("volume", 1.0), 0.0, MAX_VOLUME))
        self.pan = float(np.clip(values.get("pan", 0.0), -1.0, 1.0))
        self.mute = bool(values.get("mute", False))
        self.solo = bool(values.get("solo", False))


def pan_gains(pan: float) -> tuple:
    """Left/right gain for a pan position. Centre is (1, 1); panning only ever
    turns the far side down, so it can't push a stem into clipping."""
    return (min(1.0, 1.0 - pan), min(1.0, 1.0 + pan))


class Mixer:
    def __init__(self, stems: list, samplerate: int):
        if not stems:
            raise ValueError("A mix needs at least one stem.")
        length = min(len(s.data) for s in stems)
        for s in stems:
            s.data = s.data[:length]
        self.stems = stems
        self.samplerate = int(samplerate)
        self.length = length
        self.position = 0.0   # in frames of the song; fractional when speed != 1
        self.speed = 1.0      # like a turntable: faster is also higher
        self.master = 1.0
        self.ended = False
        self.clipped = False  # set when a played block went over full scale
        self._last_gains = None

    # ------------------------------------------------------------- settings

    @property
    def duration(self) -> float:
        return self.length / self.samplerate

    def is_audible(self, stem: Stem) -> bool:
        if any(s.solo for s in self.stems):
            return stem.solo
        return not stem.mute

    def gains(self) -> np.ndarray:
        """Current (stems, 2) gain table, master included."""
        table = np.zeros((len(self.stems), 2), dtype=np.float32)
        for i, stem in enumerate(self.stems):
            if self.is_audible(stem):
                left, right = pan_gains(stem.pan)
                table[i] = (stem.volume * left * self.master,
                            stem.volume * right * self.master)
        return table

    def seek(self, frame: float) -> None:
        self.position = float(np.clip(frame, 0, max(0, self.length - 1)))
        self.ended = False

    def reset(self) -> None:
        for stem in self.stems:
            stem.reset()
        self.speed = 1.0
        self.master = 1.0

    def settings(self) -> dict:
        return {"speed": self.speed, "master": self.master,
                "stems": {s.name: s.settings() for s in self.stems}}

    def apply_settings(self, values: dict) -> None:
        self.speed = float(np.clip(values.get("speed", 1.0), MIN_SPEED, MAX_SPEED))
        self.master = float(np.clip(values.get("master", 1.0), 0.0, MAX_VOLUME))
        saved = values.get("stems", {})
        for stem in self.stems:
            if isinstance(saved.get(stem.name), dict):
                stem.apply_settings(saved[stem.name])

    # --------------------------------------------------------------- mixing

    def _mix(self, position: float, frames: int, speed: float,
             gains_from: np.ndarray, gains_to: np.ndarray) -> np.ndarray:
        """Mix `frames` output frames starting at song frame `position`.
        Gains glide from one table to the other so a mute doesn't click."""
        out = np.zeros((frames, 2), dtype=np.float32)
        last = self.length - 1
        if position >= last or frames <= 0:
            return out
        steady = np.array_equal(gains_from, gains_to)
        ramp = None if steady else np.linspace(
            0.0, 1.0, frames, endpoint=False, dtype=np.float32)[:, None]

        if speed == 1.0 and position == int(position):
            start = int(position)
            count = min(frames, self.length - start)
            index = frac = None
        else:
            where = position + np.arange(frames, dtype=np.float64) * speed
            count = int(np.searchsorted(where, last, side="left"))
            where = where[:count]
            index = where.astype(np.int64)
            frac = (where - index).astype(np.float32)[:, None]

        for i, stem in enumerate(self.stems):
            if not gains_from[i].any() and not gains_to[i].any():
                continue
            if index is None:
                audio = stem.data[start:start + count]
            else:
                a = stem.data[index]
                audio = a + (stem.data[index + 1] - a) * frac
            if steady:
                out[:count] += audio * gains_from[i]
            else:
                glide = gains_from[i] + (gains_to[i] - gains_from[i]) * ramp[:count]
                out[:count] += audio * glide
        return out

    def render_block(self, frames: int) -> np.ndarray:
        """Next block for the sound card; moves the playhead on."""
        target = self.gains()
        previous = self._last_gains if self._last_gains is not None else target
        speed = self.speed
        position = self.position
        out = self._mix(position, frames, speed, previous, target)
        self._last_gains = target
        if np.abs(out).max(initial=0.0) > 1.0:
            self.clipped = True
            np.clip(out, -1.0, 1.0, out=out)
        position += frames * speed
        if position >= self.length - 1:
            position = float(self.length - 1)
            self.ended = True
        self.position = position
        return out

    def forget_gains(self) -> None:
        """Call when playback (re)starts, so it doesn't glide from stale gains."""
        self._last_gains = None

    def render_all(self) -> tuple:
        """The whole song with the current settings, for an export.
        Returns (audio, turned_down_by): audio is float32 within -1..1, and
        turned_down_by is the factor applied to avoid clipping (1.0 = none)."""
        gains = self.gains()
        speed = self.speed
        total = int(np.ceil((self.length - 1) / speed)) if self.length > 1 else 0
        parts = []
        for start in range(0, total, _EXPORT_CHUNK):
            frames = min(_EXPORT_CHUNK, total - start)
            parts.append(self._mix(start * speed, frames, speed, gains, gains))
        audio = np.concatenate(parts) if parts else np.zeros((0, 2), np.float32)
        peak = float(np.abs(audio).max(initial=0.0))
        factor = 1.0
        if peak > 1.0:
            factor = EXPORT_CEILING / peak
            audio *= factor
        return audio, factor


def waveform_peaks(data: np.ndarray, bins: int = 2000) -> np.ndarray:
    """Loudest sample in each of `bins` equal slices, for drawing a waveform."""
    mono = np.abs(data).max(axis=1) if data.ndim == 2 else np.abs(data)
    if len(mono) == 0:
        return np.zeros(bins, dtype=np.float32)
    bins = min(bins, len(mono))
    edges = np.linspace(0, len(mono), bins, endpoint=False).astype(np.int64)
    return np.maximum.reduceat(mono, edges).astype(np.float32)


# ------------------------------------------------------------------ files

def _to_pcm16(audio: np.ndarray) -> np.ndarray:
    return (np.clip(audio, -1.0, 1.0) * 32767.0).round().astype(np.int16)


def write_wav(path: str, audio: np.ndarray, samplerate: int) -> None:
    import soundfile as sf
    sf.write(path, _to_pcm16(audio), samplerate, subtype="PCM_16")


def write_mp3(path: str, audio: np.ndarray, samplerate: int, kbps: int = 320) -> None:
    import lameenc
    encoder = lameenc.Encoder()
    encoder.set_bit_rate(kbps)
    encoder.set_in_sample_rate(samplerate)
    encoder.set_channels(2)
    encoder.set_quality(2)
    data = encoder.encode(_to_pcm16(audio).tobytes()) + encoder.flush()
    with open(path, "wb") as handle:
        handle.write(bytes(data))


def write_audio(path: str, audio: np.ndarray, samplerate: int) -> None:
    if path.lower().endswith(".mp3"):
        write_mp3(path, audio, samplerate)
    else:
        write_wav(path, audio, samplerate)


# --------------------------------------------------------------- playback

class Player:
    """Plays a Mixer through the sound card.

    Windows offers each output through several drivers, and some outputs are
    mono (a Bluetooth headset in call mode) or refuse the song's sample rate.
    So play() tries the default output first and then works through the
    alternatives until one opens.
    """

    HOST_ORDER = ("Windows WASAPI", "Windows DirectSound", "MME")

    def __init__(self):
        self.mixer = None
        self.device_name = ""
        self.mono = False
        self._stream = None

    @property
    def playing(self) -> bool:
        return self._stream is not None and self._stream.active

    def load(self, mixer: Mixer) -> None:
        self.stop()
        self.mixer = mixer

    def _callback(self, outdata, frames, _time, _status) -> None:
        mixer = self.mixer
        if mixer is None or mixer.ended:
            outdata.fill(0)
            return
        block = mixer.render_block(frames)
        if outdata.shape[1] == 1:
            outdata[:, 0] = block.mean(axis=1)
        else:
            outdata[:, :2] = block
            outdata[:, 2:] = 0

    @staticmethod
    def _candidates(sd) -> list:
        """(device index or None, channels, host API name) in the order to try."""
        tries = [(None, 2, "")]
        try:
            devices, hosts = sd.query_devices(), sd.query_hostapis()
        except Exception:
            return tries
        seen = set()

        def add(index):
            if index is None or index < 0 or index in seen or index >= len(devices):
                return
            seen.add(index)
            most = int(devices[index]["max_output_channels"])
            if most >= 1:
                host = hosts[devices[index]["hostapi"]]["name"]
                if most >= 2:
                    tries.append((index, 2, host))
                tries.append((index, 1, host))  # mono as a last resort for this device

        try:
            add(sd.default.device[1])
        except Exception:
            pass
        ranked = sorted(hosts, key=lambda h: Player.HOST_ORDER.index(h["name"])
                        if h["name"] in Player.HOST_ORDER else len(Player.HOST_ORDER))
        for host in ranked:
            add(host.get("default_output_device", -1))
        return tries

    def _open(self, sd):
        errors = []
        for device, channels, host in self._candidates(sd):
            extra = None
            if "WASAPI" in host:
                try:  # lets Windows convert the sample rate if the device differs
                    extra = sd.WasapiSettings(auto_convert=True)
                except Exception:
                    extra = None
            try:
                stream = sd.OutputStream(
                    samplerate=self.mixer.samplerate, channels=channels, dtype="float32",
                    device=device, extra_settings=extra, callback=self._callback)
                stream.start()
            except Exception as err:
                errors.append(str(err))
                continue
            self.mono = channels == 1
            try:
                self.device_name = sd.query_devices(stream.device)["name"]
            except Exception:
                self.device_name = ""
            return stream
        raise RuntimeError(
            "Windows wouldn't open any sound output. Check a speaker or headphones "
            "are set as the output in Windows sound settings, then press Play again."
            + (f"\n\n({errors[0]})" if errors else ""))

    def play(self) -> None:
        if self.mixer is None or self.playing:
            return
        import sounddevice as sd
        self.stop()
        if self.mixer.ended or self.mixer.position >= self.mixer.length - 1:
            self.mixer.seek(0)
        self.mixer.forget_gains()
        self._stream = self._open(sd)

    def stop(self) -> None:
        stream, self._stream = self._stream, None
        if stream is not None:
            try:
                stream.abort()
                stream.close()
            except Exception:
                pass  # the device went away; nothing left to stop
