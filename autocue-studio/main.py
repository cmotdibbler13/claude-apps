"""Autocue Studio — entry point.

Run with:  python main.py
"""

import ctypes
import os
import subprocess
import sys

# Give the process its own taskbar identity so Windows groups the window
# under the Autocue Studio icon instead of pythonw's. Must match the
# AppUserModelID stamped on the desktop/taskbar shortcuts.
APP_USER_MODEL_ID = "JonH.AutocueStudio"
try:
    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_USER_MODEL_ID)
except (AttributeError, OSError):
    pass  # non-Windows or very old Windows; cosmetic only


def _relaunch_if_store_python() -> None:
    """Hop to the python.org interpreter when launched on Store Python.

    The Microsoft Store build runs with an MSIX package identity, which
    forces the python logo onto the taskbar regardless of the app ID set
    above. If that's our interpreter and the python.org build is installed,
    relaunch there so the app keeps its own icon however it was opened.
    """
    try:
        kernel32 = ctypes.windll.kernel32
        length = ctypes.c_uint32(0)
        APPMODEL_ERROR_NO_PACKAGE = 15700
        if kernel32.GetCurrentPackageFullName(
            ctypes.byref(length), None
        ) == APPMODEL_ERROR_NO_PACKAGE:
            return  # already unpackaged
        target = os.path.join(
            os.environ.get("LOCALAPPDATA", ""),
            "Programs", "Python", "Python313", "pythonw.exe",
        )
        here = os.path.abspath(__file__)
        if os.path.exists(target):
            subprocess.Popen([target, here], cwd=os.path.dirname(here))
            sys.exit(0)
    except (AttributeError, OSError):
        pass  # relaunching is best-effort; worst case is the python icon


_relaunch_if_store_python()

from app import AutocueApp


def main() -> None:
    app = AutocueApp()
    app.mainloop()


if __name__ == "__main__":
    main()
