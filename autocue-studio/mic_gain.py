"""Windows microphone input-level ("mic gain") control via Core Audio.

Uses pycaw to find active capture endpoints and adjust their master input
volume — the same 0–100 level as Windows Sound settings, which acts before
the samples reach the app, so lowering it genuinely stops clipping.

sounddevice reports device names through host APIs that may truncate them
(MME cuts at 31 characters), so endpoint matching is fuzzy.
"""

import difflib
import re

import comtypes
from pycaw.constants import DEVICE_STATE, EDataFlow
from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


class MicGainController:
    """Maps a sounddevice input-device name to its Windows endpoint volume."""

    def __init__(self):
        self._volumes: dict = {}  # endpoint friendly name -> IAudioEndpointVolume
        self._current = None
        self._current_name = ""
        self.refresh()

    def refresh(self) -> None:
        """Re-enumerate active capture endpoints."""
        self._volumes = {}
        self._current = None
        self._current_name = ""
        try:
            enumerator = AudioUtilities.GetDeviceEnumerator()
            collection = enumerator.EnumAudioEndpoints(
                EDataFlow.eCapture.value, DEVICE_STATE.ACTIVE.value
            )
            for i in range(collection.GetCount()):
                dev = collection.Item(i)
                try:
                    name = AudioUtilities.CreateDevice(dev).FriendlyName or ""
                    punk = dev.Activate(
                        IAudioEndpointVolume._iid_, comtypes.CLSCTX_ALL, None
                    )
                    # QueryInterface takes its own COM reference. A plain
                    # ctypes cast() shares punk's single reference, which
                    # punk releases when it goes out of scope — leaving the
                    # stored pointer dangling and crashing the app with an
                    # access violation once the memory is reused mid-take.
                    self._volumes[name] = punk.QueryInterface(IAudioEndpointVolume)
                except Exception:
                    continue  # endpoint without a controllable volume
        except Exception:
            self._volumes = {}

    def endpoint_names(self) -> list[str]:
        return list(self._volumes)

    def resolve(self, sd_device_name: str) -> bool:
        """Select the endpoint matching a (possibly truncated) device name."""
        self._current = None
        self._current_name = ""
        if not self._volumes or not sd_device_name:
            return False
        wanted = _norm(sd_device_name)
        best = None
        for name in self._volumes:
            candidate = _norm(name)
            if wanted and (candidate.startswith(wanted) or wanted.startswith(candidate)):
                best = name
                break
        if best is None:
            close = difflib.get_close_matches(
                sd_device_name, list(self._volumes), n=1, cutoff=0.75
            )
            best = close[0] if close else None
        if best is None:
            return False
        self._current = self._volumes[best]
        self._current_name = best
        return True

    @property
    def available(self) -> bool:
        return self._current is not None

    @property
    def device_name(self) -> str:
        return self._current_name

    def get_percent(self) -> int | None:
        if self._current is None:
            return None
        try:
            return round(self._current.GetMasterVolumeLevelScalar() * 100)
        except Exception:
            return None

    def set_percent(self, percent: float) -> bool:
        if self._current is None:
            return False
        try:
            scalar = max(0.0, min(1.0, percent / 100.0))
            self._current.SetMasterVolumeLevelScalar(scalar, None)
            return True
        except Exception:
            return False
