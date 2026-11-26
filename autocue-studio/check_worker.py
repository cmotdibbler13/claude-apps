"""Background take checks for Autocue Studio's line mode.

One daemon thread works through a queue of saved takes, one at a time, using
take_checks.check_take. Each result is written to
Recordings/<project>/checks/<project>_<id>.json (temp file, then os.replace)
and handed to on_result(id, result). The UI must marshal that call onto its own
thread (Tk: self.after(0, ...)).

* A take that changes or disappears while it is being checked is dropped
  silently: its result would describe audio that is no longer the take.
  It is reported as on_result(id, {"status": "dropped", "file": ...}) so the
  UI can stop tracking it (and check the new take); nothing is shown for it.
* Any exception becomes an error result; the worker never dies.
* The transcriber is made on the first job. If it is not loaded yet,
  on_result(None, {"status": "loading", "download": bool}) is called once
  before that job; download is False when the model is already on disk.
* On Windows the thread runs below normal priority, so a check on the CPU
  never competes with the recorder.

Also here, so the app stays thin: read_result, is_current, needs_check, the
status-line and line-mark copy and the take-commit retry.
"""

import json
import os
import queue
import sys
import threading
import time
from datetime import datetime

import take_checks

load_settings = take_checks.load_settings  # autocue_settings.json, with defaults

LOADING = {"status": "loading"}
LOADING_TEXT = "Checks are getting ready (downloading the speech model)…"
LOADING_CACHED_TEXT = "Checks are getting ready (loading the speech model)…"
THREAD_PRIORITY_BELOW_NORMAL = -1
UNAVAILABLE = "Checks unavailable: "
ALL_CHECKED = "All takes checked"
STATUS_SEP = "  ·  "
MTIME_TOLERANCE_S = 0.001

_STOP = object()
_RESET = object()


def lower_thread_priority(platform=None, kernel32=None):
    """Lower the calling thread's priority on Windows (a no-op elsewhere).
    True if it was lowered; never raises."""
    if (platform or sys.platform) != "win32":
        return False
    try:
        if kernel32 is None:
            import ctypes
            kernel32 = ctypes.windll.kernel32
        return bool(kernel32.SetThreadPriority(kernel32.GetCurrentThread(),
                                               THREAD_PRIORITY_BELOW_NORMAL))
    except Exception:
        return False


def result_path(checks_dir, project, line_id):
    return os.path.join(checks_dir, f"{project}_{line_id}.json")


def read_result(checks_dir, project, line_id):
    """The saved check for a line, or None if there is none (or it is unreadable)."""
    try:
        with open(result_path(checks_dir, project, line_id), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def is_current(result, take_path):
    """True when result was made from the take as it is now on disk."""
    if not result or not isinstance(result.get("take_mtime"), (int, float)):
        return False
    try:
        mtime = os.stat(take_path).st_mtime
    except OSError:
        return False
    return abs(mtime - result["take_mtime"]) <= MTIME_TOLERANCE_S


def needs_check(result, take_mtime):
    """True when Check all should (re)check a take: no result, a result for an
    older take, or an error (the cause may have been fixed since)."""
    if not result or "error" in result:
        return True
    saved = result.get("take_mtime")
    if not isinstance(saved, (int, float)):
        return True
    return abs(take_mtime - saved) > MTIME_TOLERANCE_S


def check_all_message(count):
    if count == 0:
        return ALL_CHECKED
    return f"Checking {count} take{'' if count == 1 else 's'}…"


def join_status(current, text, previous_check=None):
    """The status line after a check result arrives. After a "Saved …" line
    (with or without the backup's suffix) the check is appended, replacing the
    check appended before it, so a "server copy failed" warning stays put.
    Anything else is simply replaced."""
    if not current.startswith("Saved"):
        return text
    if previous_check and STATUS_SEP + previous_check in current:
        return current.replace(STATUS_SEP + previous_check, STATUS_SEP + text, 1)
    return current + STATUS_SEP + text


def status_message(line_id, result):
    """(text, kind) for the status line; kind is ok, flag, error or loading.
    None for a dropped check, which shows nothing."""
    if result.get("status") == "dropped":
        return None
    if result.get("status") == "loading":
        return (LOADING_TEXT if result.get("download", True) else LOADING_CACHED_TEXT), "loading"
    if "error" in result:
        err = str(result["error"])
        return (err if err.startswith(UNAVAILABLE) else UNAVAILABLE + err), "error"
    if result.get("ok", True):
        return f"{line_id} ✓ OK", "ok"
    flags = result.get("flags") or []
    first = flags[0]["text"] if flags else "check failed"
    text = f"{line_id} flagged: {first}. Press ← to redo."
    if len(flags) > 1:
        text += f" (+{len(flags) - 1} more)"
    return text, "flag"


NOTE_KINDS = {"pause", "noise"}
COMMIT_RETRIES = 3
COMMIT_RETRY_DELAY_S = 0.1


def mark_parts(result):
    """[(text, kind)] for the mark under the line, kind ok, flag or note:
    a pass is "✓ checked" (ok), a fail its flags (flag); pause and noise
    notes follow, muted. [] for no mark."""
    if not result or "error" in result or "ok" not in result:
        return []
    flags = result.get("flags") or []
    if result["ok"]:
        head, notes = [("✓ checked", "ok")], [f["text"] for f in flags]
    else:
        severe = [f["text"] for f in flags if f.get("kind") not in NOTE_KINDS]
        notes = [f["text"] for f in flags if f.get("kind") in NOTE_KINDS]
        head = [(" · ".join(severe) or "check failed", "flag")]
    return head + ([("· " + " · ".join(notes), "note")] if notes else [])


def retry_on_permission_error(fn, retries=COMMIT_RETRIES, delay_s=COMMIT_RETRY_DELAY_S,
                              sleep=None):
    """fn(), tried again up to `retries` times, delay_s apart, while Windows
    refuses with PermissionError (a check's ffmpeg may still be reading the
    old take). Other errors, and the last refusal, are raised."""
    sleep = sleep or time.sleep
    for attempt in range(retries + 1):
        try:
            return fn()
        except PermissionError:
            if attempt == retries:
                raise
            sleep(delay_s)


class CheckWorker:
    def __init__(self, transcriber_factory, on_result, check=take_checks.check_take,
                 now=time.time, lower_priority=lower_thread_priority):
        self._factory = transcriber_factory
        self._lower_priority = lower_priority
        self._on_result = on_result
        self._check = check
        self._now = now
        self._transcriber = None
        self._factory_error = None
        self._announced = False
        self._queue = queue.Queue()
        self._stopping = False
        self._thread = threading.Thread(target=self._run, name="take-checks", daemon=True)
        self._thread.start()

    @property
    def daemon(self):
        return self._thread.daemon

    def submit(self, job):
        """Queue {id, path, line_text, checks_dir, project}."""
        if not self._stopping:
            self._queue.put(dict(job))

    def reset_transcriber(self):
        """Forget a failed model load before the next job (for Check all)."""
        if not self._stopping:
            self._queue.put(_RESET)

    def stop(self):
        """Ask the thread to finish; returns at once (the thread is a daemon)."""
        self._stopping = True
        self._queue.put(_STOP)

    def join(self, timeout=None):
        self._thread.join(timeout)

    def join_queue(self, timeout):
        """Wait until every queued item has been handled (tests)."""
        deadline = time.monotonic() + timeout
        with self._queue.all_tasks_done:
            while self._queue.unfinished_tasks:
                left = deadline - time.monotonic()
                if left <= 0:
                    return False
                self._queue.all_tasks_done.wait(left)
        return True

    # ------------------------------------------------------- the thread ----

    def _run(self):
        try:
            self._lower_priority()
        except Exception:
            pass
        while True:
            item = self._queue.get()
            try:
                if item is _STOP:
                    return
                if item is _RESET:
                    self._reset()
                elif not self._stopping:
                    self._handle(item)
            except Exception:
                pass  # never let one job kill the worker
            finally:
                self._queue.task_done()

    def _reset(self):
        # Only a failed (or never finished) load is forgotten: a loaded model
        # is kept, so Check all doesn't reload it every time.
        self._factory_error = None
        t = self._transcriber
        if t is not None and not getattr(t, "loaded", True):
            self._announced = False
            if hasattr(t, "reset"):
                t.reset()

    def _emit(self, line_id, result):
        try:
            self._on_result(line_id, result)
        except Exception:
            pass

    def _get_transcriber(self):
        if self._transcriber is None and self._factory_error is None:
            try:
                self._transcriber = self._factory()
            except Exception as e:
                self._factory_error = e
        if self._factory_error is not None:
            raise take_checks.CheckError(f"{UNAVAILABLE}{self._factory_error}")
        if not self._announced and not getattr(self._transcriber, "loaded", True):
            self._announced = True
            try:
                download = bool(self._transcriber.will_download())
            except Exception:  # no such method, or the cache check failed
                download = True
            self._emit(None, dict(LOADING, download=download))
        return self._transcriber

    def _handle(self, job):
        path = job["path"]
        dropped = {"status": "dropped", "file": os.path.basename(path)}
        try:
            mtime = os.stat(path).st_mtime
        except OSError:
            self._emit(job["id"], dropped)  # the take is gone already
            return
        try:
            body = self._check(path, job["line_text"], self._get_transcriber())
        except Exception as e:
            body = {"error": str(e) or type(e).__name__, "version": take_checks.VERSION}
        try:
            stale = os.stat(path).st_mtime != mtime  # re-recorded while checking
        except OSError:
            stale = True                              # deleted while checking
        if stale:
            self._emit(job["id"], dropped)
            return
        result = {
            "id": job["id"],
            "file": os.path.basename(path),
            "checked_at": datetime.fromtimestamp(self._now()).isoformat(timespec="seconds"),
            "take_mtime": mtime,
        }
        result.update(body)
        try:
            self._write(job, result)
        except OSError:
            pass  # still show it; Check all will write it next time
        self._emit(job["id"], result)

    def _write(self, job, result):
        os.makedirs(job["checks_dir"], exist_ok=True)
        final = result_path(job["checks_dir"], job["project"], job["id"])
        tmp = final + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        os.replace(tmp, final)
