"""Stem Remixer: the mixing engine.

Holds the separated stems in memory and mixes them on demand, either a block
at a time for live playback or the whole song at once for an export. Pure
NumPy, so it can be tested without a sound card.
"""

import threading

import numpy as np

MAX_VOLUME = 1.5      # sliders go up to 150%
MIN_TEMPO = 0.5
MAX_TEMPO = 1.5
MAX_PITCH = 6         # semitones up or down
EXPORT_CEILING = 0.98  # exports louder than full scale are turned down to this
MIN_LOOP_SECONDS = 0.1
MAX_SECTIONS = 9       # saved sections per song: one for each number key
_LOOP_FADE = 128       # frames faded either side of the loop join, so it doesn't click
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


class Stretcher:
    """Changes how fast audio plays without changing its pitch (WSOLA).

    The output is built from short overlapping slices of the input. To play
    slower or faster, the slices are taken closer together or further apart
    than they are laid down. Each slice is nudged to the spot, near where it
    should come from, that lines up best with the end of the previous one, so
    the joins don't warble.
    """

    FRAME = 2048    # slice length, about 46 ms
    HOP = 1024      # output made per slice: slices overlap by half
    SEARCH = 1024   # how far a slice may be nudged either way

    def __init__(self, position: float):
        self.ideal = float(position)   # song frame the next slice should start at
        self.template = None           # what would naturally have come next
        self.tail = np.zeros((self.HOP, 2), dtype=np.float32)
        self.ready = np.zeros((0, 2), dtype=np.float32)   # made but not yet played
        window = np.hanning(self.FRAME + 1)[:self.FRAME]  # halves sum to exactly 1
        self.window = window.astype(np.float32)[:, None]

    def hop(self, fetch, tempo: float, ratio: float) -> np.ndarray:
        """Make the next HOP frames. fetch(song_position, frames, ratio) returns
        mixed audio read at `ratio` song frames per frame; `tempo` is how many
        song frames go by per output frame."""
        frame, hop, search = self.FRAME, self.HOP, self.SEARCH
        region = fetch(self.ideal - search * ratio, frame + 2 * search + hop, ratio)
        offset = search
        if self.template is not None:
            mono = region[:hop + 2 * search].sum(axis=1)
            match = np.correlate(mono, self.template, "valid")
            squares = np.concatenate(([0.0], np.cumsum(mono.astype(np.float64) ** 2)))
            energy = squares[hop:hop + 2 * search + 1] - squares[:2 * search + 1]
            score = match / np.sqrt(energy + 1e-9)
            best = int(np.argmax(score))
            if score[best] > 0:
                offset = best
        piece = region[offset:offset + frame] * self.window
        if self.template is None:
            out = region[offset:offset + hop].copy()   # the very start: nothing to fade in from
        else:
            out = piece[:hop] + self.tail
        self.tail = piece[hop:].copy()
        self.template = region[offset + hop:offset + 2 * hop].sum(axis=1)
        self.ideal += hop * tempo
        return out


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
        self.position = 0.0   # in frames of the song; can be fractional
        self.tempo = 1.0      # how fast the song goes by; pitch is unaffected
        self.pitch = 0        # semitones up or down; tempo is unaffected
        self.master = 1.0
        self.ended = False
        self.clipped = False  # set when a played block went over full scale
        self.loop_start = None   # the marked section, in song frames (None = none marked)
        self.loop_end = None
        self.loop_on = False
        self.sections = []       # saved sections: [{"name", "start", "end"}]
        self._last_gains = None
        self._stretch = None
        self._lock = threading.Lock()   # the sound card and the window both move the playhead

    # ------------------------------------------------------------- settings

    @property
    def pitch_ratio(self) -> float:
        return float(2.0 ** (self.pitch / 12.0))

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
        with self._lock:
            self.position = float(np.clip(frame, 0, max(0, self.length - 1)))
            self.ended = False
            self._stretch = None

    @property
    def looping(self) -> bool:
        return self.loop_on and self.loop_start is not None

    def set_loop(self, start: float, end: float) -> bool:
        """Mark the section between two song frames (either order). Returns
        False, changing nothing, if it is too short to loop."""
        start, end = sorted((float(start), float(end)))
        start = max(0.0, start)
        end = min(float(self.length - 1), end)
        if end - start < MIN_LOOP_SECONDS * self.samplerate:
            return False
        with self._lock:
            self.loop_start, self.loop_end = start, end
        return True

    def clear_loop(self) -> None:
        with self._lock:
            self.loop_start = self.loop_end = None
            self.loop_on = False

    # ------------------------------------------------------ saved sections

    def active_section(self):
        """Index of the saved section that is the one marked now, or None."""
        if self.loop_start is None:
            return None
        for index, section in enumerate(self.sections):
            if abs(section["start"] - self.loop_start) < 1 and abs(section["end"] - self.loop_end) < 1:
                return index
        return None

    def save_section(self, name: str = ""):
        """Keep the marked section. Returns its index, or None if nothing is
        marked or the song already has MAX_SECTIONS."""
        if self.loop_start is None:
            return None
        already = self.active_section()
        if already is not None:
            return already
        if len(self.sections) >= MAX_SECTIONS:
            return None
        self.sections.append({"name": name, "start": self.loop_start, "end": self.loop_end})
        return len(self.sections) - 1

    def select_section(self, index: int) -> bool:
        """Mark a saved section, loop it, and jump to its start."""
        if not 0 <= index < len(self.sections):
            return False
        section = self.sections[index]
        if not self.set_loop(section["start"], section["end"]):
            return False
        self.loop_on = True
        self.seek(self.loop_start)
        return True

    def delete_section(self, index: int) -> None:
        if 0 <= index < len(self.sections):
            del self.sections[index]

    def reset(self) -> None:
        """Back to the plain song. Saved sections are kept."""
        self.clear_loop()
        for stem in self.stems:
            stem.reset()
        self.tempo = 1.0
        self.pitch = 0
        self.master = 1.0

    def settings(self) -> dict:
        loop = None
        if self.loop_start is not None:
            loop = {"start": self.loop_start, "end": self.loop_end, "on": self.loop_on}
        return {"tempo": self.tempo, "pitch": self.pitch, "master": self.master, "loop": loop,
                "sections": [dict(section) for section in self.sections],
                "stems": {s.name: s.settings() for s in self.stems}}

    def apply_settings(self, values: dict) -> None:
        self.tempo = float(np.clip(values.get("tempo", 1.0), MIN_TEMPO, MAX_TEMPO))
        self.pitch = int(np.clip(round(values.get("pitch", 0)), -MAX_PITCH, MAX_PITCH))
        self.master = float(np.clip(values.get("master", 1.0), 0.0, MAX_VOLUME))
        self.sections = []
        saved_sections = values.get("sections")
        for section in saved_sections if isinstance(saved_sections, list) else []:
            try:
                start, end = float(section["start"]), float(section["end"])
            except (TypeError, KeyError, ValueError):
                continue
            fits = 0 <= start and end <= self.length
            if fits and end - start >= MIN_LOOP_SECONDS * self.samplerate \
                    and len(self.sections) < MAX_SECTIONS:
                self.sections.append({"name": str(section.get("name", "")),
                                      "start": start, "end": end})
        loop = values.get("loop")
        if isinstance(loop, dict) and self.set_loop(loop.get("start", 0), loop.get("end", 0)):
            self.loop_on = bool(loop.get("on", False))
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

    def _fetcher(self, gains: np.ndarray):
        """A fetch function for the Stretcher: mixed audio from any song
        position, silent before the start and after the end."""
        def fetch(position: float, frames: int, ratio: float) -> np.ndarray:
            lead = 0
            if position < 0:
                lead = min(frames, int(np.ceil(-position / ratio)))
                position += lead * ratio
            audio = self._mix(position, frames - lead, ratio, gains, gains)
            if lead:
                audio = np.concatenate([np.zeros((lead, 2), np.float32), audio])
            return audio
        return fetch

    @staticmethod
    def _plain(tempo: float, ratio: float) -> bool:
        """True when tempo and pitch move together, as on a record deck, so
        reading the stems faster or slower is all that's needed."""
        return abs(tempo - ratio) < 1e-6

    def render_block(self, frames: int) -> np.ndarray:
        """Next block for the sound card; moves the playhead on."""
        with self._lock:
            tempo, ratio = self.tempo, self.pitch_ratio
            target = self.gains()
            last = self.length - 1
            loop = (self.loop_start, self.loop_end) if self.looping else None
            if self._plain(tempo, ratio):
                self._stretch = None
                previous = self._last_gains if self._last_gains is not None else target
                out, position = self._plain_block(frames, ratio, previous, target, loop)
            else:
                stretch = self._stretch
                if stretch is None:
                    stretch = self._stretch = Stretcher(self.position)
                fetch = self._fetcher(target)
                made = [stretch.ready]
                count = len(stretch.ready)
                while count < frames and stretch.ideal < last:
                    before = stretch.ideal
                    made.append(stretch.hop(fetch, tempo, ratio))
                    if loop and before < loop[1] <= stretch.ideal:
                        # Reached the end of the section: carry on from its start.
                        # The stretcher's overlap blends the join.
                        stretch.ideal = loop[0] + (stretch.ideal - loop[1]) % (loop[1] - loop[0])
                    count += Stretcher.HOP
                audio = np.concatenate(made) if len(made) > 1 else made[0]
                out = np.zeros((frames, 2), dtype=np.float32)
                out[:min(frames, count)] = audio[:frames]
                stretch.ready = audio[frames:]
                # Past the end only once what was made has been played out.
                position = stretch.ideal - len(stretch.ready) * tempo
                if loop and position < loop[0] <= self.position:
                    # Just went round: what's still to be played is the section's tail.
                    position = max(loop[0], loop[1] - (loop[0] - position))
                if count < frames:
                    position = float(last)
            self._last_gains = target
            if np.abs(out).max(initial=0.0) > 1.0:
                self.clipped = True
                np.clip(out, -1.0, 1.0, out=out)
            if position >= last:
                position = float(last)
                self.ended = True
            self.position = max(0.0, position)
            return out

    def _plain_block(self, frames, ratio, previous, target, loop) -> tuple:
        """A block read straight from the stems, going round the loop if one
        is on. Returns (audio, new position)."""
        position = self.position
        if not loop or position >= loop[1]:
            return self._mix(position, frames, ratio, previous, target), position + frames * ratio
        start, end = loop
        out = np.zeros((frames, 2), dtype=np.float32)
        done = 0
        while done < frames:
            count = min(frames - done, max(1, int(np.ceil((end - position) / ratio))))
            piece = self._mix(position, count, ratio, previous, target)
            # Dip to silence for a few milliseconds either side of the join.
            where = position + np.arange(count) * ratio
            near = np.minimum(end - where, where - start) / (_LOOP_FADE * ratio)
            piece *= np.clip(np.where(where < start, 1.0, near), 0.0, 1.0)[:, None].astype(np.float32)
            out[done:done + count] = piece
            done += count
            position += count * ratio
            previous = target
            if position >= end:
                position = start + (position - end) % (end - start)
        return out, position

    def forget_gains(self) -> None:
        """Call when playback (re)starts, so it doesn't glide from stale gains
        or carry on from a stale stretch."""
        self._last_gains = None
        self._stretch = None

    def render_all(self, section=None) -> tuple:
        """The whole song with the current settings, for an export, or just
        the (start, end) song frames given as `section`.
        Returns (audio, turned_down_by): audio is float32 within -1..1, and
        turned_down_by is the factor applied to avoid clipping (1.0 = none)."""
        gains = self.gains()
        tempo, ratio = self.tempo, self.pitch_ratio
        first, last = section if section else (0.0, float(self.length - 1))
        total = int(np.ceil((last - first) / tempo)) if last > first else 0
        parts = []
        if self._plain(tempo, ratio):
            for start in range(0, total, _EXPORT_CHUNK):
                frames = min(_EXPORT_CHUNK, total - start)
                parts.append(self._mix(first + start * ratio, frames, ratio, gains, gains))
        else:
            stretch, fetch = Stretcher(first), self._fetcher(gains)
            for _ in range(0, total, Stretcher.HOP):
                parts.append(stretch.hop(fetch, tempo, ratio))
        audio = np.concatenate(parts)[:total] if parts else np.zeros((0, 2), np.float32)
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
