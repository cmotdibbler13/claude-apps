"""Stem Remixer: entry point.

Run with:  python main.py
Or, to open one file as it is (no split), optionally with a fit plan whose
sections and chain replace the saved ones:
    python main.py --open <file> [--plan <plan.json>] [--export-dir <folder>]
--export-dir only sets the folder Export mix's Save dialog starts in.
"""

import argparse
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


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        """A broken command line still starts the app (pythonw has no console)."""
        raise ValueError(message)


def parse_args(argv):
    """--open, --plan and --export-dir; anything else on the command line is ignored."""
    parser = _Parser(add_help=False)
    parser.add_argument("--open", default=None)
    parser.add_argument("--plan", default=None)
    parser.add_argument("--export-dir", dest="export_dir", default=None)
    try:
        args, _unknown = parser.parse_known_args(argv)
    except ValueError:
        args = argparse.Namespace(open=None, plan=None, export_dir=None)
    return args


def main(argv=None) -> None:
    import sys
    from app import StemRemixerApp
    args = parse_args(sys.argv[1:] if argv is None else argv)
    app = StemRemixerApp(store_python=on_store_python(), export_dir=args.export_dir)
    if args.open:
        app.after(0, lambda: app.open_file(args.open, args.plan))
    app.mainloop()


if __name__ == "__main__":
    main()
