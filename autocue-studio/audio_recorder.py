"""Local microphone recording to WAV files using sounddevice.

The audio callback runs on a high-priority audio thread, so it only copies
raw bytes into a queue and updates the peak level. A separate writer thread
drains the queue to disk, keeping file I/O off the audio thread.
"""

import os
import queue
import threading
import wave
from datetime import datetime

import numpy as np
import sounddevice as sd

SAMPLE_RATE = 44100
CHANNELS = 1  # mono is ideal for voice; halves the file size
SAMPLE_WIDTH_BYTES = 2  # 16-bit PCM
DTYPE = "int16"


class AudioRecorder:
    """Records microphone input to a timestamped WAV file in recordings_dir."""

    def __init__(self, recordings_dir: str):
        self.recordings_dir = recordings_dir
        os.makedirs(self.recordings_dir, exist_ok=True)

        self._stream: sd.InputStream | None = None
        self._wave_file: wave.Wave_write | None = None
        self._frames_queue: queue.Queue | None = None
        self._writer_thread: threading.Thread | None = None
        self._frames_captured = 0

        self.is_recording = False
        self.is_paused = False
        self.level = 0.0  # peak level of the latest audio block, 0.0–1.0
        self.current_path: str | None = None

    @staticmethod
    def list_input_devices() -> list[tuple[int, str]]:
        """Return [(device_index, device_name), ...] for recordable devices.

        Windows exposes the same physical mic through several host APIs
        (MME, DirectSound, WASAPI); de-duplicating by name keeps the
        dropdown readable.
        """
        devices: list[tuple[int, str]] = []
        seen_names: set[str] = set()
        for index, dev in enumerate(sd.query_devices()):
            if dev["max_input_channels"] > 0 and dev["name"] not in seen_names:
                seen_names.add(dev["name"])
                devices.append((index, dev["name"]))
        return devices

    @property
    def elapsed_seconds(self) -> float:
        """Recorded duration so far (excludes time spent paused)."""
        return self._frames_captured / SAMPLE_RATE

    def start(self, device_index: int | None = None, path: str | None = None) -> str:
        """Open the WAV file and start capturing. Returns the file path.

        If ``path`` is given the take is written there (used by line mode);
        otherwise a timestamped file is created in recordings_dir.
        """
        if self.is_recording:
            return self.current_path or ""

        if path:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            self.current_path = path
        else:
            timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
            self.current_path = os.path.join(
                self.recordings_dir, f"recording_{timestamp}.wav"
            )

        self._wave_file = wave.open(self.current_path, "wb")
        self._wave_file.setnchannels(CHANNELS)
        self._wave_file.setsampwidth(SAMPLE_WIDTH_BYTES)
        self._wave_file.setframerate(SAMPLE_RATE)

        self._frames_queue = queue.Queue()
        self._frames_captured = 0
        self.is_paused = False

        self._writer_thread = threading.Thread(target=self._write_loop, daemon=True)
        self._writer_thread.start()

        try:
            self._stream = self._open_stream(device_index)
        except Exception:
            # Unwind the half-started session so a retry starts clean.
            self._frames_queue.put(None)
            self._wave_file.close()
            self._wave_file = None
            if os.path.exists(self.current_path):
                os.remove(self.current_path)
            self.current_path = None
            raise

        self.is_recording = True
        return self.current_path

    @staticmethod
    def _candidate_devices(device_index: int | None) -> list[int | None]:
        """The chosen device first, then the same mic through other host APIs.

        Windows lists one physical mic under MME, DirectSound and WASAPI.
        When one driver path refuses to open, another often still works.
        """
        if device_index is None:
            return [None]
        candidates: list[int | None] = [device_index]
        try:
            devices = sd.query_devices()
            name = devices[device_index]["name"]
        except Exception:
            return candidates
        for index, dev in enumerate(devices):
            if index == device_index or dev["max_input_channels"] <= 0:
                continue
            # Some host APIs truncate long names (MME caps at 31 chars).
            if dev["name"].startswith(name) or name.startswith(dev["name"]):
                candidates.append(index)
        return candidates

    def _open_stream(self, device_index: int | None) -> sd.InputStream:
        """Open and start an input stream, trying fallbacks before giving up.

        Always records mono 44.1 kHz to the WAV file. If the device refuses
        mono, it is opened in stereo and downmixed in the callback.
        """
        errors: list[str] = []
        for candidate in self._candidate_devices(device_index):
            try:
                max_ch = int(sd.query_devices(candidate, "input")["max_input_channels"])
            except Exception:
                max_ch = CHANNELS
            for channels in dict.fromkeys((CHANNELS, min(max(max_ch, 1), 2))):
                stream = None
                try:
                    stream = sd.InputStream(
                        samplerate=SAMPLE_RATE,
                        channels=channels,
                        dtype=DTYPE,
                        device=candidate,
                        callback=self._audio_callback,
                    )
                    stream.start()
                    return stream
                except Exception as exc:
                    if stream is not None:
                        try:
                            stream.close()
                        except Exception:
                            pass
                    errors.append(str(exc))

        try:
            mic = sd.query_devices(device_index, "input")["name"]
        except Exception:
            mic = "the selected microphone"
        raise RuntimeError(
            f"Windows would not open {mic}.\n\n"
            "Try this:\n"
            "  • Unplug the mic/webcam, wait 5 seconds, plug it back in, "
            "then pick it again in the Microphone list.\n"
            "  • Close any other app that might be using it.\n"
            "  • Or choose a different microphone.\n\n"
            f"Details: {errors[0] if errors else 'unknown error'}"
        )

    def _audio_callback(self, indata, frames, time_info, status) -> None:
        if self.is_paused:
            self.level = 0.0
            return
        if indata.shape[1] > 1:
            # Stereo fallback: average the channels down to mono.
            indata = indata.astype(np.int32).mean(axis=1).astype(np.int16).reshape(-1, 1)
        self._frames_queue.put(bytes(indata))
        self._frames_captured += frames
        self.level = float(np.max(np.abs(indata.astype(np.int32)))) / 32768.0

    def _write_loop(self) -> None:
        while True:
            chunk = self._frames_queue.get()
            if chunk is None:
                return
            self._wave_file.writeframes(chunk)

    def pause(self) -> None:
        if self.is_recording:
            self.is_paused = True

    def resume(self) -> None:
        if self.is_recording:
            self.is_paused = False

    def stop(self) -> str | None:
        """Stop capturing, finish writing, and return the saved file path."""
        if not self.is_recording:
            return None
        self.is_recording = False
        self.is_paused = False

        self._stream.stop()
        self._stream.close()
        self._stream = None

        self._frames_queue.put(None)  # sentinel: flush and exit writer thread
        self._writer_thread.join(timeout=5)
        self._wave_file.close()
        self._wave_file = None

        self.level = 0.0
        return self.current_path
