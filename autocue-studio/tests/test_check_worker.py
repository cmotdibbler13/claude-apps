"""Tests for check_worker: a stub check and stub transcribers, no Tk, no voices."""

import json
import os
import queue
import tempfile
import threading
import time
import unittest

import check_worker
from check_worker import CheckWorker
from take_checks import CheckError

WAIT_S = 5.0


def ok_body(**extra):
    body = {"ok": True, "flags": [], "transcript": "hello there",
            "duration_s": 1.5, "peak_dbfs": -6.0, "noise_dbfs": -62.0, "version": 1}
    body.update(extra)
    return body


class StubTranscriber:
    def __init__(self):
        self.loaded = False
        self.resets = 0

    def transcribe(self, samples, rate):
        self.loaded = True
        return "hello there", []

    def reset(self):
        self.resets += 1
        self.loaded = False


class UnavailableTranscriber(StubTranscriber):
    """Like WhisperTranscriber with faster-whisper missing: every use raises."""

    def transcribe(self, samples, rate):
        raise CheckError("Checks unavailable: faster-whisper is not installed (No module)")


def transcribing_check(path, line_text, transcriber):
    transcriber.transcribe(None, 16000)
    return ok_body()


class WorkerTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.checks_dir = os.path.join(self.dir, "checks")
        self.results = queue.Queue()
        self.worker = None

    def tearDown(self):
        if self.worker:
            self.worker.stop()
            self.worker.join(WAIT_S)
        self._tmp.cleanup()

    def make_take(self, line_id="05.2"):
        path = os.path.join(self.dir, f"film_{line_id}.wav")
        with open(path, "wb") as f:
            f.write(b"RIFF....WAVE")
        return path

    def job(self, line_id="05.2", path=None):
        return {"id": line_id, "path": path or self.make_take(line_id),
                "line_text": "Hello there.", "checks_dir": self.checks_dir,
                "project": "film"}

    def start(self, check=transcribing_check, factory=StubTranscriber):
        self.worker = CheckWorker(factory, lambda i, r: self.results.put((i, r)),
                                  check=check)
        return self.worker

    def next_result(self):
        return self.results.get(timeout=WAIT_S)

    def result_file(self, line_id="05.2"):
        return os.path.join(self.checks_dir, f"film_{line_id}.json")

    def assert_no_more_results(self):
        self.worker.join_queue(WAIT_S)
        self.assertTrue(self.results.empty(), list(self.results.queue))


class ResultWrittenAndCallback(WorkerTestCase):
    def test_result_written_and_callback(self):
        w = self.start()
        job = self.job()
        mtime = os.stat(job["path"]).st_mtime
        w.submit(job)
        self.assertEqual(self.next_result(), (None, {"status": "loading", "download": True}))
        line_id, result = self.next_result()
        self.assertEqual(line_id, "05.2")
        self.assertEqual(result["id"], "05.2")
        self.assertEqual(result["file"], "film_05.2.wav")
        self.assertEqual(result["take_mtime"], mtime)
        self.assertTrue(result["ok"])
        self.assertEqual(result["version"], 1)
        self.assertIsInstance(result["checked_at"], str)
        with open(self.result_file(), encoding="utf-8") as f:
            self.assertEqual(json.load(f), result)
        # No temp file left behind.
        self.assertEqual(os.listdir(self.checks_dir), ["film_05.2.json"])


class StaleResultDropped(WorkerTestCase):
    def test_take_replaced_mid_check_is_dropped(self):
        def check_that_rerecords(path, line_text, transcriber):
            # A new take lands while this one is being checked.
            st = os.stat(path)
            os.utime(path, (st.st_atime, st.st_mtime + 5))
            return ok_body()

        w = self.start(check=check_that_rerecords)
        # The new take's own result is already there: it must not be overwritten.
        os.makedirs(self.checks_dir)
        with open(self.result_file(), "w", encoding="utf-8") as f:
            json.dump({"id": "05.2", "marker": "new take"}, f)
        w.submit(self.job())
        self.assertEqual(self.next_result(), (None, {"status": "loading", "download": True}))
        self.assertEqual(self.next_result(),
                         ("05.2", {"status": "dropped", "file": "film_05.2.wav"}))
        self.assert_no_more_results()
        with open(self.result_file(), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["marker"], "new take")

    def test_take_gone_mid_check_is_dropped(self):
        def check_that_deletes(path, line_text, transcriber):
            os.remove(path)
            return ok_body()

        w = self.start(check=check_that_deletes)
        w.submit(self.job())
        self.assertEqual(self.next_result(), (None, {"status": "loading", "download": True}))
        self.assertEqual(self.next_result()[1]["status"], "dropped")
        self.assert_no_more_results()
        self.assertFalse(os.path.exists(self.result_file()))

    def test_take_missing_before_check_is_dropped(self):
        calls = []
        w = self.start(check=lambda *a: calls.append(a) or ok_body())
        w.submit(self.job(path=os.path.join(self.dir, "nope.wav")))
        self.assertEqual(self.next_result(),
                         ("05.2", {"status": "dropped", "file": "nope.wav"}))
        self.assert_no_more_results()
        self.assertEqual(calls, [])

    def test_drop_shows_nothing(self):
        self.assertIsNone(check_worker.status_message("05.2", {"status": "dropped"}))


class TranscriberUnavailable(WorkerTestCase):
    def test_error_json_written_and_worker_keeps_going(self):
        w = self.start(factory=UnavailableTranscriber)
        w.submit(self.job("01.1"))
        w.submit(self.job("01.2"))
        self.assertEqual(self.next_result(), (None, {"status": "loading", "download": True}))
        for line_id in ("01.1", "01.2"):
            got_id, result = self.next_result()
            self.assertEqual(got_id, line_id)
            self.assertIn("Checks unavailable", result["error"])
            self.assertNotIn("ok", result)
            with open(self.result_file(line_id), encoding="utf-8") as f:
                self.assertEqual(json.load(f), result)
        msg, kind = check_worker.status_message("01.2", result)
        self.assertEqual(kind, "error")
        self.assertTrue(msg.startswith("Checks unavailable: faster-whisper"), msg)
        self.assertNotIn("Checks unavailable: Checks unavailable", msg)

    def test_factory_failure_is_an_error_result(self):
        def factory():
            raise RuntimeError("no settings")

        w = self.start(factory=factory)
        w.submit(self.job("01.1"))
        w.submit(self.job("01.2"))
        self.assertIn("no settings", self.next_result()[1]["error"])
        self.assertEqual(self.next_result()[0], "01.2")

    def test_reset_lets_a_fixed_environment_retry(self):
        made = []

        def factory():
            made.append(UnavailableTranscriber())
            return made[-1]

        w = self.start(factory=factory)
        w.submit(self.job("01.1"))
        self.next_result(), self.next_result()          # loading, error
        w.reset_transcriber()
        w.submit(self.job("01.2"))
        self.assertEqual(self.next_result(), (None, {"status": "loading", "download": True}))
        self.assertEqual(self.next_result()[0], "01.2")
        self.assertEqual(len(made), 1)
        self.assertEqual(made[0].resets, 1)


class ErrorDoesNotStopWorker(WorkerTestCase):
    def test_any_exception_becomes_an_error_result(self):
        def check(path, line_text, transcriber):
            if path.endswith("01.1.wav"):
                raise ZeroDivisionError("boom")
            if path.endswith("01.2.wav"):
                raise CheckError("ffmpeg could not read film_01.2.wav: bad header")
            return ok_body()

        w = self.start(check=check)
        for line_id in ("01.1", "01.2", "01.3"):
            w.submit(self.job(line_id))
        self.assertEqual(self.next_result()[1], {"status": "loading", "download": True})
        self.assertIn("boom", self.next_result()[1]["error"])
        self.assertIn("bad header", self.next_result()[1]["error"])
        line_id, result = self.next_result()
        self.assertEqual(line_id, "01.3")
        self.assertTrue(result["ok"])

    def test_callback_exception_does_not_stop_worker(self):
        seen = []

        def on_result(line_id, result):
            seen.append(line_id)
            if line_id == "01.1":
                raise RuntimeError("Tk has gone")

        self.worker = CheckWorker(StubTranscriber, on_result, check=transcribing_check)
        self.worker.submit(self.job("01.1"))
        self.worker.submit(self.job("01.2"))
        self.worker.join_queue(WAIT_S)
        self.assertEqual(seen, [None, "01.1", "01.2"])


class LoadingStatusOnce(WorkerTestCase):
    def test_loading_reported_once(self):
        made = []

        def factory():
            made.append(StubTranscriber())
            return made[-1]

        w = self.start(factory=factory)
        for line_id in ("01.1", "01.2", "01.3"):
            w.submit(self.job(line_id))
        w.join_queue(WAIT_S)
        got = list(self.results.queue)
        self.assertEqual(got[0], (None, {"status": "loading", "download": True}))
        self.assertEqual([i for i, _ in got], [None, "01.1", "01.2", "01.3"])
        self.assertEqual(len(made), 1)

    def test_no_loading_when_already_loaded(self):
        class Ready(StubTranscriber):
            def __init__(self):
                super().__init__()
                self.loaded = True

        w = self.start(factory=Ready)
        w.submit(self.job())
        self.assertEqual(self.next_result()[0], "05.2")

    def test_stop_is_non_blocking(self):
        def slow(path, line_text, transcriber):
            time.sleep(0.5)
            return ok_body()

        w = self.start(check=slow)
        w.submit(self.job())
        t0 = time.monotonic()
        w.stop()
        self.assertLess(time.monotonic() - t0, 0.2)
        self.assertTrue(w.daemon)


class SettingsDefaults(unittest.TestCase):
    def test_missing_and_bad_json(self):
        want = {"check_model": "medium.en", "check_device": "auto"}
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(check_worker.load_settings(d), want)
            with open(os.path.join(d, "autocue_settings.json"), "w") as f:
                f.write("not json")
            self.assertEqual(check_worker.load_settings(d), want)
            with open(os.path.join(d, "autocue_settings.json"), "w") as f:
                f.write('["a list"]')
            self.assertEqual(check_worker.load_settings(d), want)


class ReadResult(WorkerTestCase):
    def test_read_result(self):
        self.assertIsNone(check_worker.read_result(self.checks_dir, "film", "05.2"))
        os.makedirs(self.checks_dir)
        with open(self.result_file(), "w", encoding="utf-8") as f:
            json.dump({"id": "05.2", "ok": True}, f)
        self.assertEqual(check_worker.read_result(self.checks_dir, "film", "05.2"),
                         {"id": "05.2", "ok": True})
        with open(self.result_file(), "w", encoding="utf-8") as f:
            f.write("{half")
        self.assertIsNone(check_worker.read_result(self.checks_dir, "film", "05.2"))
        with open(self.result_file(), "w", encoding="utf-8") as f:
            f.write("[1, 2]")
        self.assertIsNone(check_worker.read_result(self.checks_dir, "film", "05.2"))

    def test_needs_check(self):
        self.assertTrue(check_worker.needs_check(None, 100.0))
        self.assertTrue(check_worker.needs_check({"take_mtime": 90.0, "ok": True}, 100.0))
        self.assertFalse(check_worker.needs_check({"take_mtime": 100.0, "ok": True}, 100.0))
        # An error is retried by Check all even when it is for this very take.
        self.assertTrue(check_worker.needs_check(
            {"take_mtime": 100.0, "error": "Checks unavailable: no model"}, 100.0))
        self.assertTrue(check_worker.needs_check({}, 100.0))

    def test_is_current(self):
        path = self.make_take()
        mtime = os.stat(path).st_mtime
        self.assertFalse(check_worker.is_current(None, path))
        self.assertTrue(check_worker.is_current({"take_mtime": mtime}, path))
        self.assertFalse(check_worker.is_current({"take_mtime": mtime - 10}, path))
        self.assertFalse(check_worker.is_current({}, path))
        self.assertFalse(check_worker.is_current({"take_mtime": mtime},
                                                 path + ".gone"))


class Copy(unittest.TestCase):
    """The status-line and line-mark copy (constraints.md)."""

    def flagged(self, *texts, ok=False):
        return {"ok": ok, "flags": [{"kind": "x", "text": t, "at_s": None} for t in texts]}

    def test_status_ok(self):
        self.assertEqual(check_worker.status_message("05.2", ok_body()), ("05.2 ✓ OK", "ok"))

    def test_status_flagged(self):
        self.assertEqual(
            check_worker.status_message("05.2", self.flagged('last word "Skaill" cut off')),
            ('05.2 flagged: last word "Skaill" cut off. Press ← to redo.', "flag"))
        self.assertEqual(
            check_worker.status_message(
                "05.2", self.flagged("clipping: re-record a little quieter",
                                     "room noise at -50 dBFS", "pause of 0.8 s after \"x\"")),
            ("05.2 flagged: clipping: re-record a little quieter. Press ← to redo. (+2 more)",
             "flag"))

    def test_status_notes_only_is_ok(self):
        self.assertEqual(
            check_worker.status_message("05.2", self.flagged("room noise at -50 dBFS", ok=True)),
            ("05.2 ✓ OK", "ok"))

    def test_check_all_nothing_to_do(self):
        self.assertEqual(check_worker.check_all_message(0), "All takes checked")
        self.assertEqual(check_worker.check_all_message(1), "Checking 1 take…")
        self.assertEqual(check_worker.check_all_message(3), "Checking 3 takes…")

    def test_append_after_saved(self):
        join = check_worker.join_status
        self.assertEqual(join("Saved  a.wav", "05.2 ✓ OK", None), "Saved  a.wav  ·  05.2 ✓ OK")
        warn = "Saved  a.wav  ·  server copy failed, will retry after the next take"
        self.assertEqual(join(warn, "05.2 ✓ OK", None), warn + "  ·  05.2 ✓ OK")
        # A later check replaces the earlier one rather than piling up.
        self.assertEqual(join("Saved  a.wav  ·  05.2 ✓ OK  ·  copied to server ✓",
                              "05.3 ✓ OK", "05.2 ✓ OK"),
                         "Saved  a.wav  ·  05.3 ✓ OK  ·  copied to server ✓")
        self.assertEqual(join("Ready", "05.2 ✓ OK", None), "05.2 ✓ OK")
        self.assertEqual(join("Checking 3 takes…", "05.2 ✓ OK", None), "05.2 ✓ OK")

    def test_status_loading_and_error(self):
        self.assertEqual(
            check_worker.status_message(None, {"status": "loading"}),
            ("Checks are getting ready (downloading the speech model)…", "loading"))
        self.assertEqual(
            check_worker.status_message("05.2", {"error": "ffmpeg not found"}),
            ("Checks unavailable: ffmpeg not found", "error"))

    def test_marks(self):
        self.assertEqual(check_worker.mark_text(None), ("", None))
        self.assertEqual(check_worker.mark_text({"error": "x"}), ("", None))
        self.assertEqual(check_worker.mark_text(ok_body()), ("✓ checked", "ok"))
        self.assertEqual(check_worker.mark_text(self.flagged("a", "b")), ("a · b", "flag"))
        self.assertEqual(check_worker.mark_text(self.flagged("room noise", ok=True)),
                         ("✓ checked · room noise", "flag"))


class LoadingNoticeSaysWhy(WorkerTestCase):
    """"downloading" only when the model really has to be downloaded."""

    def _first(self, transcriber_cls):
        w = self.start(factory=transcriber_cls)
        w.submit(self.job())
        return self.next_result()

    def test_cached_model_is_loading(self):
        class Cached(StubTranscriber):
            def will_download(self):
                return False

        notice = self._first(Cached)
        self.assertEqual(notice, (None, {"status": "loading", "download": False}))
        self.assertEqual(check_worker.status_message(None, notice[1]),
                         ("Checks are getting ready (loading the speech model)…", "loading"))

    def test_download_needed_keeps_the_download_copy(self):
        class Fresh(StubTranscriber):
            def will_download(self):
                return True

        notice = self._first(Fresh)
        self.assertEqual(notice, (None, {"status": "loading", "download": True}))
        self.assertEqual(check_worker.status_message(None, notice[1]),
                         ("Checks are getting ready (downloading the speech model)…", "loading"))

    def test_unknown_or_failing_check_says_downloading(self):
        class Broken(StubTranscriber):
            def will_download(self):
                raise RuntimeError("no hub")

        self.assertEqual(self._first(Broken), (None, {"status": "loading", "download": True}))


class WorkerThreadPriority(WorkerTestCase):
    def test_worker_lowers_its_own_priority(self):
        seen = []
        self.worker = CheckWorker(StubTranscriber, lambda i, r: None, check=transcribing_check,
                                  lower_priority=lambda: seen.append(
                                      threading.current_thread().name))
        self.worker.submit(self.job())
        self.worker.join_queue(WAIT_S)
        self.assertEqual(seen, ["take-checks"])

    def test_lower_thread_priority_windows_only(self):
        calls = []

        class Kernel32:
            def GetCurrentThread(self):
                return 42

            def SetThreadPriority(self, handle, level):
                calls.append((handle, level))
                return 1

        self.assertFalse(check_worker.lower_thread_priority("linux", Kernel32()))
        self.assertEqual(calls, [])
        self.assertTrue(check_worker.lower_thread_priority("win32", Kernel32()))
        self.assertEqual(calls, [(42, -1)])

    def test_lower_thread_priority_never_raises(self):
        class Broken:
            def GetCurrentThread(self):
                raise OSError("no")

        self.assertFalse(check_worker.lower_thread_priority("win32", Broken()))
        self.assertFalse(check_worker.lower_thread_priority("win32"))  # no ctypes.windll here


def _have_customtkinter():
    try:
        import customtkinter  # noqa: F401  (needs Tk too)
    except Exception:
        return False
    return True


@unittest.skipUnless(_have_customtkinter(), "customtkinter not installed")
class AppImports(unittest.TestCase):
    def test_import_app(self):
        import app  # noqa: F401
        self.assertTrue(hasattr(app.AutocueApp, "_show_check"))


if __name__ == "__main__":
    unittest.main()
