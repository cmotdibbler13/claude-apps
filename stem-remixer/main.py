"""Stem Remixer: entry point.

Run with:  python main.py
"""

import ctypes

# Give the process its own taskbar identity, so Windows doesn't group the
# window under Python's icon.
try:
    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("JonH.StemRemixer")
except (AttributeError, OSError):
    pass  # not Windows; cosmetic only



def on_store_python() -> bool:
    """True when this is Python from the Microsoft Store. Windows then shows
    the Python logo on the taskbar whatever the app asks for; Install.cmd
    moves the app to the standard Python to fix that."""
    try:
        length = ctypes.c_uint32(0)
        no_package = 15700  # APPMODEL_ERROR_NO_PACKAGE
        return ctypes.windll.kernel32.GetCurrentPackageFullName(
            ctypes.byref(length), None) != no_package
    except (AttributeError, OSError):
        return False


from app import StemRemixerApp


def main() -> None:
    StemRemixerApp(store_python=on_store_python()).mainloop()


if __name__ == "__main__":
    main()
