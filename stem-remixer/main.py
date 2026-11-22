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

from app import StemRemixerApp


def main() -> None:
    StemRemixerApp().mainloop()


if __name__ == "__main__":
    main()
