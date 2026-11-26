"""Copy finished takes to a backup folder (e.g. a home server) in the background.

After every saved take (and once at start-up) the whole Recordings folder is
mirrored to the server: any file that is missing there, or differs in size or
date, is copied. Nothing on the server is ever deleted or moved, so the server
also keeps takes that were later removed here. If the server can't be reached
the copy is simply skipped and caught up after the next take.

Set the AUTOCUE_BACKUP_DIR environment variable to the destination folder.
If it is not set, backup is switched off and nothing is copied.
"""

import os
import shutil
import threading

BACKUP_DIR = os.environ.get("AUTOCUE_BACKUP_DIR") or None


class ServerBackup:
    def __init__(self, source_dir: str, dest_dir: str | None = BACKUP_DIR):
        self.source_dir = source_dir
        self.dest_dir = dest_dir
        self._lock = threading.Lock()
        self._again = False
        self._running = False
        # Read by the UI thread: None until a run finishes, then
        # ("ok", files_copied) or ("error", message).
        self.last_result: tuple[str, object] | None = None

    def request(self) -> None:
        """Start a background copy (or queue one if a copy is already running)."""
        if not self.dest_dir:
            return  # backup not configured
        with self._lock:
            if self._running:
                self._again = True
                return
            self._running = True
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        while True:
            try:
                self.last_result = ("ok", self._mirror())
            except OSError as exc:
                self.last_result = ("error", str(exc))
            with self._lock:
                if not self._again:
                    self._running = False
                    return
                self._again = False

    def _mirror(self) -> int:
        if not os.path.isdir(os.path.splitdrive(self.dest_dir)[0] + os.sep):
            raise OSError(f"server drive not available ({self.dest_dir})")
        copied = 0
        for root, _dirs, files in os.walk(self.source_dir):
            rel = os.path.relpath(root, self.source_dir)
            target_dir = os.path.normpath(os.path.join(self.dest_dir, rel))
            for name in files:
                if not name.lower().endswith(".wav") or name.endswith(".tmp.wav"):
                    continue
                src = os.path.join(root, name)
                dst = os.path.join(target_dir, name)
                try:
                    s = os.stat(src)
                    if os.path.exists(dst):
                        d = os.stat(dst)
                        if d.st_size == s.st_size and int(d.st_mtime) == int(s.st_mtime):
                            continue
                except FileNotFoundError:
                    continue  # moved or deleted while we looked
                os.makedirs(target_dir, exist_ok=True)
                part = dst + ".part"
                shutil.copy2(src, part)
                os.replace(part, dst)
                copied += 1
        return copied
