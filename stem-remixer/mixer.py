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
NUMBER_KEYS = 9        # number keys that pick a saved section; a song can keep more
MAX_SECTIONS = NUMBER_KEYS   # old name, kept for the window's number keys (no longer a cap)
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
        self.source = np.ascontiguousarray(data[:, :2])   # as split
        self.data = self.source                           # what is mixed: source, or with EQ
        self.samplerate = 44100     # the Mixer sets the real one
        self.eq = [0.0, 0.0, 0.0]   # low, mid, high in dB
        self.eq_applied = [0.0, 0.0, 0.0]   # the EQ that self.data has
        self.volume = 1.0   # 0 .. MAX_VOLUME
        self.pan = 0.0      # -1 (left) .. +1 (right)
        self.mute = False
        self.solo = False

    def reset(self) -> None:
        self.volume, self.pan, self.mute, self.solo = 1.0, 0.0, False, False
        self.eq = [0.0, 0.0, 0.0]
        self.apply_eq()

    def settings(self) -> dict:
        return {"volume": self.volume, "pan": self.pan,
                "mute": self.mute, "solo": self.solo, "eq": list(self.eq)}

    def apply_eq(self) -> None:
        """Make self.data match self.eq. Slow for a whole song (a second or
        so), so the window calls it off the UI thread."""
        wanted = list(self.eq)
        if wanted == self.eq_applied:
            return
        self.data = equalise(self.source, wanted, self.samplerate) if any(wanted) else self.source
        self.eq_applied = wanted

    def apply_settings(self, values: dict) -> None:
        self.volume = float(np.clip(values.get("volume", 1.0), 0.0, MAX_VOLUME))
        self.pan = float(np.clip(values.get("pan", 0.0), -1.0, 1.0))
        self.mute = bool(values.get("mute", False))
        self.solo = bool(values.get("solo", False))
        eq = values.get("eq")
        if isinstance(eq, list) and len(eq) == 3:
            try:
                self.eq = [float(np.clip(v, -MAX_EQ, MAX_EQ)) for v in eq]
            except (TypeError, ValueError):
                pass


EQ_BANDS = (120.0, 1000.0, 8000.0)   # Hz: where Low, Mid and High are centred
MAX_EQ = 12.0                         # dB up or down


def equalise(data: np.ndarray, gains_db, samplerate: int) -> np.ndarray:
    """A three-band tone control over a whole stem. The boost or cut glides
    smoothly from one band to the next and adds no delay, so the stems stay
    lined up."""
    frames = len(data)
    if frames == 0:
        return data
    size = 1 << int(np.ceil(np.log2(frames)))   # a fast size for the transform
    freqs = np.fft.rfftfreq(size, 1.0 / samplerate)
    curve_db = np.interp(np.log(np.maximum(freqs, 1.0)), np.log(EQ_BANDS), gains_db)
    curve = (10.0 ** (curve_db / 20.0)).astype(np.float32)
    out = np.empty_like(data)
    for channel in range(data.shape[1]):
        spectrum = np.fft.rfft(data[:, channel], size)
        out[:, channel] = np.fft.irfft(spectrum * curve, size)[:frames]
    return out


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
        self.wrapped = False           # just jumped back to the start of a loop
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


class _Part:
    """One step of a chain: its section read front to back at its own tempo,
    a few frames at a time, the same way however the frames are asked for."""

    def __init__(self, mixer, first: float, tempo: float, ratio: float, offset: int):
        self.mixer, self.first, self.tempo, self.ratio = mixer, float(first), tempo, ratio
        self.done = int(offset)   # frames of this part made so far
        self.stretch = None if Mixer._plain(tempo, ratio) else Stretcher(first + offset * tempo)
        self.ready = np.zeros((0, 2), dtype=np.float32)

    def pull(self, frames: int, previous: np.ndarray, target: np.ndarray) -> np.ndarray:
        if self.stretch is None:
            out = self.mixer._mix(self.first + self.done * self.ratio, frames, self.ratio,
                                  previous, target)
        else:
            fetch = self.mixer._fetcher(target)
            made, count = [self.ready], len(self.ready)
            while count < frames:
                made.append(self.stretch.hop(fetch, self.tempo, self.ratio))
                count += Stretcher.HOP
            audio = np.concatenate(made) if len(made) > 1 else made[0]
            out, self.ready = audio[:frames].copy(), audio[frames:]
        self.done += frames
        return out


class _ChainStream:
    """The chain, once through, made on demand. Each step plays at its section's
    tempo; a step with a crossfade overlaps the next by that much (equal power),
    and every other join, and both ends, get the few-millisecond dip. Exports
    pull it all at once and playback a block at a time, so both hear the same."""

    def __init__(self, mixer, plan: list, step: int = 0, offset: int = 0):
        self.mixer, self.plan = mixer, plan
        self.starts, at = [], 0
        for _section, _tempo, length, overlap in plan:
            self.starts.append(at)
            at += length - overlap
        self.total = at
        self.low = step                # steps before this are done (or skipped by a seek)
        self.pos = self.starts[step] + offset if plan else 0   # frame of the chain output
        self.parts = {}
        self.key = None   # what it was made from (Mixer._chain_key), for playback

    def _envelope(self, step: int, first: int, count: int) -> np.ndarray:
        length = self.plan[step][2]
        where = np.arange(first, first + count)
        gain = np.ones(count, dtype=np.float64)
        incoming = self.plan[step - 1][3] if step > 0 else 0
        head = incoming or min(_LOOP_FADE, length // 2)
        tail = self.plan[step][3] or min(_LOOP_FADE, length // 2)
        if head:
            inside = where < head
            if incoming:
                gain[inside] = np.sin((where[inside] + 0.5) / head * np.pi / 2)
            else:
                gain[inside] = where[inside] / max(1, head - 1)
        if tail:
            back = where - (length - tail)   # 0 .. tail-1 within the tail
            inside = back >= 0
            if self.plan[step][3]:
                gain[inside] = np.cos((back[inside] + 0.5) / tail * np.pi / 2)
            else:
                gain[inside] = (tail - 1 - back[inside]) / max(1, tail - 1)
        return gain.astype(np.float32)[:, None]

    def pull(self, frames: int, previous: np.ndarray, target: np.ndarray) -> tuple:
        """Up to `frames` more frames of the chain. Returns (audio, frames made)."""
        a = self.pos
        b = min(a + frames, self.total)
        out = np.zeros((frames, 2), dtype=np.float32)
        for step in range(self.low, len(self.plan)):
            start, length = self.starts[step], self.plan[step][2]
            if start >= b:
                break
            lo, hi = max(a, start), min(b, start + length)
            if hi > lo:
                part = self.parts.get(step)
                if part is None:
                    section, tempo = self.plan[step][0], self.plan[step][1]
                    part = self.parts[step] = _Part(self.mixer, section["start"], tempo,
                                                    self.mixer.pitch_ratio, lo - start)
                piece = part.pull(hi - lo, previous, target)
                out[lo - a:hi - a] += piece * self._envelope(step, lo - start, hi - lo)
            if start + length <= b:
                self.parts.pop(step, None)
                if step == self.low:
                    self.low += 1
        self.pos = b
        return out, b - a

    def where(self) -> tuple:
        """(chain step, song frame) of the newest step playing now."""
        step = max(self.low, 0)
        for index in range(self.low, len(self.plan)):
            if self.starts[index] <= self.pos:
                step = index
            else:
                break
        step = min(step, len(self.plan) - 1)
        section, tempo, length, _ = self.plan[step]
        local = min(self.pos - self.starts[step], length)
        return step, min(section["start"] + local * tempo, section["end"])


class Mixer:
    def __init__(self, stems: list, samplerate: int):
        if not stems:
            raise ValueError("A mix needs at least one stem.")
        length = min(len(s.data) for s in stems)
        for s in stems:
            s.source = s.data = s.source[:length]
            s.samplerate = int(samplerate)
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
        self.sections = []       # saved sections: [{"name", "start", "end", "tempo", "xfade"}]
        self.chain = []          # saved sections to play one after another, by index
        self.chain_on = False
        self.chain_step = 0      # which entry of the chain is playing
        self.levels = np.zeros(len(stems), dtype=np.float32)   # loudest recent peak per stem
        self.master_level = 0.0                                # and of the whole mix
        self._last_gains = None
        self._stretch = None
        self._chain = None    # the chain being played (a _ChainStream)
        self._chain_old = None   # [stream, frames faded] when a change rebuilt the chain
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
            self._chain = None
            self._chain_old = None
            if self.chaining:
                # Carry on from the chain entry that was clicked into, else
                # from the start of the chain.
                order = [self.chain_step] + list(range(len(self.chain)))
                for step in order:
                    section = self.sections[self.chain[step % len(self.chain)]]
                    if section["start"] <= self.position < section["end"]:
                        self.chain_step = step % len(self.chain)
                        break
                else:
                    self.chain_step = 0
                    self.position = float(self.sections[self.chain[0]]["start"])

    @property
    def chaining(self) -> bool:
        return self.chain_on and bool(self.chain)

    def region(self):
        """(start, end) of what is going round now: the chain's current
        section, else the loop, else None."""
        if self.chaining:
            section = self.sections[self.chain[self.chain_step % len(self.chain)]]
            return section["start"], section["end"]
        if self.loop_on and self.loop_start is not None:
            return self.loop_start, self.loop_end
        return None

    def _next_region(self):
        """Called when play reaches the end of the region: the same loop
        again, or the next section of the chain."""
        if self.chaining:
            self.chain_step = (self.chain_step + 1) % len(self.chain)
        return self.region()

    @property
    def looping(self) -> bool:
        return self.region() is not None

    def set_chain(self, steps) -> list:
        """Set the order to play saved sections in (indices; repeats are
        fine). Ones that don't exist are dropped. Returns the chain."""
        with self._lock:
            self.chain = [int(i) for i in steps if 0 <= int(i) < len(self.sections)]
            self.chain_step = 0
            if not self.chain:
                self.chain_on = False
        return self.chain

    def start_chain(self) -> bool:
        """Switch the chain on and jump to its first section."""
        if not self.chain:
            return False
        self.chain_step = 0
        self.chain_on = True
        self.seek(self.region()[0])
        return True

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
        marked."""
        if self.loop_start is None:
            return None
        already = self.active_section()
        if already is not None:
            return already
        self.sections.append({"name": name, "start": self.loop_start, "end": self.loop_end,
                              "tempo": 1.0, "xfade": 0.0})
        return len(self.sections) - 1

    @staticmethod
    def _section_tempo(value) -> float:
        try:
            value = float(value)
        except (TypeError, ValueError):
            return 1.0
        return float(np.clip(value, MIN_TEMPO, MAX_TEMPO)) if np.isfinite(value) else 1.0

    @staticmethod
    def _section_xfade(value) -> float:
        try:
            value = float(value)
        except (TypeError, ValueError):
            return 0.0
        return max(0.0, value) if np.isfinite(value) else 0.0

    def set_section(self, index: int, tempo=None, xfade=None) -> bool:
        """Change a saved section's own tempo (times the song's tempo) or its
        crossfade, in seconds, into whatever follows it in a chain."""
        with self._lock:
            if not 0 <= index < len(self.sections):
                return False
            section = self.sections[index]
            if tempo is not None:
                section["tempo"] = self._section_tempo(tempo)
            if xfade is not None:
                section["xfade"] = self._section_xfade(xfade)
        return True

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
            with self._lock:
                del self.sections[index]
                self.chain = [i - (i > index) for i in self.chain if i != index]
                self.chain_step = 0
                if not self.chain:
                    self.chain_on = False

    def reset(self) -> None:
        """Back to the plain song. Saved sections are kept."""
        self.clear_loop()
        self.chain_on = False
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
                "chain": {"steps": list(self.chain), "on": self.chain_on},
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
            if fits and end - start >= MIN_LOOP_SECONDS * self.samplerate:
                self.sections.append({"name": str(section.get("name", "")),
                                      "start": start, "end": end,
                                      "tempo": self._section_tempo(section.get("tempo", 1.0)),
                                      "xfade": self._section_xfade(section.get("xfade", 0.0))})
        chain = values.get("chain")
        if isinstance(chain, dict) and isinstance(chain.get("steps"), list):
            try:
                self.set_chain(chain["steps"])
                self.chain_on = bool(chain.get("on", False)) and bool(self.chain)
            except (TypeError, ValueError):
                self.set_chain([])
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
                part = audio * gains_from[i]
            else:
                part = audio * (gains_from[i] + (gains_to[i] - gains_from[i]) * ramp[:count])
            out[:count] += part
            peak = np.abs(part).max(initial=0.0)
            if peak > self.levels[i]:
                self.levels[i] = peak
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
            loop = self.region()
            if self.chaining:
                self._stretch = None
                previous = self._last_gains if self._last_gains is not None else target
                out, position = self._chain_block(frames, previous, target)
                position = min(position, last - 1.0)   # a chain goes round; it never ends
            elif self._plain(tempo, ratio):
                self._chain = None
                self._stretch = None
                previous = self._last_gains if self._last_gains is not None else target
                out, position = self._plain_block(frames, ratio, previous, target, loop)
            else:
                self._chain = None
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
                        # Reached the end of the section: carry on from its start, or
                        # from the next one in the chain. The stretcher's overlap
                        # blends the join.
                        over = stretch.ideal - loop[1]
                        loop = self._next_region() or loop
                        stretch.ideal = loop[0] + over % (loop[1] - loop[0])
                        stretch.wrapped = True
                    count += Stretcher.HOP
                audio = np.concatenate(made) if len(made) > 1 else made[0]
                out = np.zeros((frames, 2), dtype=np.float32)
                out[:min(frames, count)] = audio[:frames]
                stretch.ready = audio[frames:]
                # Past the end only once what was made has been played out.
                position = stretch.ideal - len(stretch.ready) * tempo
                if stretch.wrapped:
                    # Just went round: don't show the playhead before the section.
                    if loop and position < loop[0]:
                        position = loop[0]
                    else:
                        stretch.wrapped = False
                if count < frames:
                    position = float(last)
            self._last_gains = target
            peak = float(np.abs(out).max(initial=0.0))
            if peak > self.master_level:
                self.master_level = peak
            if peak > 1.0:
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
                over = position - end
                start, end = self._next_region() or (start, end)
                position = start + over % (end - start)
        return out, position

    def _chain_block(self, frames, previous, target) -> tuple:
        """A block of the chain, made by the same _ChainStream as render_chain,
        going round to the start again at the end. Returns (audio, position)."""
        key = self._chain_key()
        stream = self._chain
        if stream is not None and stream.key != key:
            # A tempo, pitch or section change while it plays: carry on from
            # here with the new settings, crossfading out of the old sound.
            self._chain_old = [stream, 0]
            stream = None
        if stream is None:
            stream = self._chain = self._chain_here(key)
        out = np.zeros((frames, 2), dtype=np.float32)
        done = 0
        while done < frames:
            audio, count = stream.pull(frames - done, previous, target)
            out[done:done + count] = audio[:count]
            done += count
            previous = target
            if stream.pos >= stream.total:
                stream = self._chain = _ChainStream(self, stream.plan)
                stream.key = key
                if stream.total <= 0:
                    break
        if self._chain_old is not None:
            self._fade_from_old(out)
        self.chain_step, position = stream.where()
        return out, position

    def _fade_from_old(self, out: np.ndarray) -> None:
        """Blend the start of a rebuilt chain in from the old one over
        _LOOP_FADE frames (equal power), so a change doesn't click."""
        old, faded = self._chain_old
        count = min(len(out), _LOOP_FADE - faded)
        audio, made = old.pull(count, self._last_gains if self._last_gains is not None
                               else self.gains(), self.gains())
        t = (np.arange(faded, faded + count) + 0.5) / _LOOP_FADE * (np.pi / 2)
        out[:count] = (out[:count] * np.sin(t)[:, None].astype(np.float32)
                       + audio[:count] * np.cos(t)[:, None].astype(np.float32))
        faded += count
        self._chain_old = None if faded >= _LOOP_FADE else [old, faded]

    def _chain_key(self) -> tuple:
        """Everything a chain's sound is made from, apart from the gains."""
        return (tuple(self.chain), self.tempo, self.pitch,
                tuple((s["start"], s["end"], s.get("tempo", 1.0), s.get("xfade", 0.0))
                      for s in (self.sections[i] for i in self.chain)))

    def _chain_here(self, key) -> _ChainStream:
        """A chain stream from the playhead: the current step, from where in
        its section the playhead is."""
        plan = self._chain_plan()
        step = self.chain_step % len(plan)
        section, tempo, length, _ = plan[step]
        offset = 0
        if section["start"] <= self.position < section["end"]:
            offset = int(min(length - 1, (self.position - section["start"]) / tempo))
        stream = _ChainStream(self, plan, step, offset)
        stream.key = key
        return stream

    def _chain_plan(self) -> list:
        """[section, tempo, frames out, frames overlapped with the next step]
        for each step of the chain."""
        plan = []
        for index in self.chain:
            section = self.sections[index]
            tempo = self.tempo * section.get("tempo", 1.0)
            frames = int(np.ceil((section["end"] - section["start"]) / tempo))
            plan.append([section, tempo, frames, 0])
        for step, following in zip(plan, plan[1:]):
            wanted = int(round(step[0].get("xfade", 0.0) * self.samplerate))
            step[3] = max(0, min(wanted, step[2] // 2, following[2] // 2))
        return plan

    def chain_length_s(self) -> float:
        """How long render_chain's audio is, in seconds."""
        plan = self._chain_plan()
        return (sum(p[2] for p in plan) - sum(p[3] for p in plan)) / self.samplerate

    def forget_gains(self) -> None:
        """Call when playback (re)starts, so it doesn't glide from stale gains
        or carry on from a stale stretch."""
        self._last_gains = None
        self._stretch = None
        self._chain = None
        self._chain_old = None

    def render_chain(self) -> tuple:
        """The chain, once through, for an export: each section at its own
        tempo, joined with its crossfade (or the few-millisecond dip), exactly
        as it plays."""
        gains = self.gains()
        stream = _ChainStream(self, self._chain_plan())
        parts = []
        while stream.pos < stream.total:
            audio, count = stream.pull(min(_EXPORT_CHUNK, stream.total - stream.pos), gains, gains)
            parts.append(audio[:count])
        audio = np.concatenate(parts) if parts else np.zeros((0, 2), np.float32)
        return self._ceiling(audio)

    def render_all(self, section=None) -> tuple:
        """The whole song with the current settings, for an export, or just
        the (start, end) song frames given as `section`.
        Returns (audio, turned_down_by): audio is float32 within -1..1, and
        turned_down_by is the factor applied to avoid clipping (1.0 = none)."""
        return self._ceiling(self._render(section))

    @staticmethod
    def _ceiling(audio: np.ndarray) -> tuple:
        peak = float(np.abs(audio).max(initial=0.0))
        factor = 1.0
        if peak > 1.0:
            factor = EXPORT_CEILING / peak
            audio *= factor
        return audio, factor

    def _render(self, section=None) -> np.ndarray:
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
        return np.concatenate(parts)[:total] if parts else np.zeros((0, 2), np.float32)


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
