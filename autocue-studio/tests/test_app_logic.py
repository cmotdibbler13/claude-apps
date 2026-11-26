"""The take-check wiring in app.py, imported against stub Tk, CustomTkinter
and sounddevice modules (none are installed here). The methods are called on
a plain stand-in for the window, so only their logic runs."""

import os
import sys
import tempfile
import types
import unittest
from unittest import mock

import check_worker


class _Anything:
    """Stands in for any Tk/CTk class, function or constant."""

    def __init__(self, *a, **kw):
        pass

    def __call__(self, *a, **kw):
        return _Anything()

    def __getattr__(self, name):
        return _Anything()


class _StubModule(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _Anything


def _import_app():
    stubs = {n: _StubModule(n) for n in (
        "tkinter", "tkinter.filedialog", "tkinter.font", "tkinter.messagebox",
        "customtkinter", "sounddevice")}
    stubs["tkinter"].filedialog = stubs["tkinter.filedialog"]
    stubs["tkinter"].font = stubs["tkinter.font"]
    stubs["tkinter"].messagebox = stubs["tkinter.messagebox"]
    with mock.patch.dict(sys.modules, stubs):
        sys.modules.pop("app", None)
        sys.modules.pop("audio_recorder", None)
        import app
    return app


app = _import_app()


class Label:
    def __init__(self, text=""):
        self.options = {"text": text}

    def configure(self, **kw):
        self.options.update(kw)

    def cget(self, key):
        return self.options[key]


class FakeWindow(types.SimpleNamespace):
    """Just enough of AutocueApp for the methods under test."""

    def __init__(self, tmp, lines):
        super().__init__(
            line_mode=True, script_name="film", script_lines=lines, line_index=0,
            _queued_checks=set(), _last_check_error=None, _shown_check_text=None,
            _counting_down=False, recorder=types.SimpleNamespace(is_recording=False),
            status_label=Label(), check_mark_label=Label(), check_note_label=Label(),
            submitted=[])
        self.dir = tmp
        self.checker = types.SimpleNamespace(
            submit=self.submitted.append, reset_transcriber=lambda: None)

    def _recordings_dir(self):
        return self.dir

    def _take_path(self, index):
        return os.path.join(self.dir, f"film_{self.script_lines[index]['id']}.wav")

    def _checks_dir(self):
        return os.path.join(self.dir, "checks")

    def _submit_check(self, index):
        return app.AutocueApp._submit_check(self, index)

    def _wrap_check_mark(self):
        return app.AutocueApp._wrap_check_mark(self)


class AppTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.lines = [{"id": i, "text": f"Line {i}."} for i in ("01", "02", "03")]
        self.win = FakeWindow(self._tmp.name, self.lines)

    def take(self, line_id):
        path = os.path.join(self._tmp.name, f"film_{line_id}.wav")
        with open(path, "wb") as f:
            f.write(b"RIFF")
        return path


class SubmitCountsOnlyNewChecks(AppTestCase):
    def test_submit_returns_whether_it_queued(self):
        self.take("01")
        self.assertTrue(app.AutocueApp._submit_check(self.win, 0))
        self.assertFalse(app.AutocueApp._submit_check(self.win, 0))  # already queued
        self.assertEqual(len(self.win.submitted), 1)

    def test_check_all_counts_only_submitted_takes(self):
        for line_id in ("01", "02", "03"):
            self.take(line_id)
        self.win._queued_checks.add("film_02.wav")  # its check is already on the way
        app.AutocueApp._check_all(self.win)
        self.assertEqual(self.win.status_label.cget("text"), "Checking 2 takes…")
        self.assertEqual([j["id"] for j in self.win.submitted], ["01", "03"])

    def test_check_all_with_everything_queued(self):
        self.take("01")
        self.win._queued_checks.add("film_01.wav")
        app.AutocueApp._check_all(self.win)
        self.assertEqual(self.win.status_label.cget("text"), "All takes checked")


class CommitTakeRetries(AppTestCase):
    def test_permission_error_is_retried_before_the_dialog(self):
        final = self.take("01")
        temp = os.path.join(self._tmp.name, "temp.wav")
        with open(temp, "wb") as f:
            f.write(b"new")
        real_move, tries = app.shutil.move, []

        def busy_move(src, dst):
            tries.append(src)
            if len(tries) < 3:
                raise PermissionError(13, "The process cannot access the file")
            return real_move(src, dst)

        dialog = mock.Mock()
        with mock.patch.object(app.shutil, "move", side_effect=busy_move), \
                mock.patch.object(app.messagebox, "showerror", dialog), \
                mock.patch.object(check_worker.time, "sleep") as sleep:
            got = app.AutocueApp._commit_take(self.win, temp, final)
        self.assertEqual(got, final)
        self.assertEqual(len(tries), 3)
        dialog.assert_not_called()
        self.assertEqual(sleep.call_count, 2)
        with open(final, "rb") as f:
            self.assertEqual(f.read(), b"new")
        self.assertEqual(len(os.listdir(os.path.join(self._tmp.name, "superseded"))), 1)

    def test_still_refused_shows_the_dialog_and_keeps_the_temp(self):
        final = self.take("01")
        temp = os.path.join(self._tmp.name, "temp.wav")
        with open(temp, "wb") as f:
            f.write(b"new")
        dialog = mock.Mock()
        with mock.patch.object(app.shutil, "move",
                               side_effect=PermissionError(13, "in use")) as move, \
                mock.patch.object(app.messagebox, "showerror", dialog), \
                mock.patch.object(check_worker.time, "sleep"):
            got = app.AutocueApp._commit_take(self.win, temp, final)
        self.assertEqual(got, temp)
        self.assertEqual(move.call_count, 4)
        dialog.assert_called_once()
        self.assertTrue(os.path.exists(temp))


class CheckMarkColours(AppTestCase):
    def _show(self, body):
        take = self.take("01")
        os.makedirs(self.win._checks_dir(), exist_ok=True)
        result = dict(body, take_mtime=os.stat(take).st_mtime)
        with open(os.path.join(self.win._checks_dir(), "film_01.json"), "w") as f:
            import json
            json.dump(result, f)
        app.AutocueApp._show_check_mark(self.win)
        return self.win.check_mark_label.options, self.win.check_note_label.options

    def test_passed_with_notes(self):
        mark, note = self._show({"ok": True, "flags": [
            {"kind": "noise", "text": "room noise at -50 dBFS", "at_s": None}]})
        self.assertEqual((mark["text"], mark["text_color"]), ("✓ checked", app.CHECK_OK))
        self.assertEqual((note["text"], note["text_color"]),
                         ("· room noise at -50 dBFS", app.INK_MUTED))

    def test_mark_and_notes_share_the_width(self):
        self.win._wrap = 600
        mark, note = self._show({"ok": True, "flags": [
            {"kind": "pause", "text": 'pause of 0.8 s after "x"', "at_s": 1.0}]})
        self.assertEqual(mark["wraplength"], 300)
        self.assertEqual(note["wraplength"], 294)
        mark, _ = self._show({"ok": False, "flags": [
            {"kind": "misread", "text": "may have missed \"y\"", "at_s": 1.0}]})
        self.assertEqual(mark["wraplength"], 600)

    def test_flagged(self):
        mark, note = self._show({"ok": False, "flags": [
            {"kind": "cut_off", "text": "ends too abruptly", "at_s": 1.0}]})
        self.assertEqual((mark["text"], mark["text_color"]), ("ends too abruptly", app.BRASS))
        self.assertEqual(note["text"], "")

    def test_no_result_clears_both(self):
        self.take("01")
        self.win.check_mark_label.configure(text="old")
        self.win.check_note_label.configure(text="old")
        app.AutocueApp._show_check_mark(self.win)
        self.assertEqual(self.win.check_mark_label.cget("text"), "")
        self.assertEqual(self.win.check_note_label.cget("text"), "")


class StubsDoNotLeak(unittest.TestCase):
    def test_real_modules_untouched(self):
        self.assertNotIn("app", sys.modules)
        self.assertFalse(isinstance(sys.modules.get("tkinter"), _StubModule))


if __name__ == "__main__":
    unittest.main()
