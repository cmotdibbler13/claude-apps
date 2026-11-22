"""Stem Remixer: updating itself from GitHub.

The app's files live in a public GitHub repository. An update downloads the
repository's zip, copies this app's folder out of it over the installed
files, and restarts. Stems, the .venv folder and anything else not in the
repository are left alone.
"""

import io
import os
import subprocess
import sys
import urllib.request
import zipfile

APP_DIR = os.path.dirname(os.path.abspath(__file__))
REPOSITORY = "cmotdibbler13/claude-apps"
FOLDER = "stem-remixer"
# Where to look for a newer version; the newest one found wins.
BRANCHES = ("main", "claude/peaceful-davinci-h3btsz")
VERSION_FILE = "VERSION"
TIMEOUT = 20


class UpdateError(Exception):
    """An update failed for a reason worth showing in plain words."""


def parse_version(text: str) -> tuple:
    parts = []
    for piece in str(text).strip().split("."):
        if not piece.isdigit():
            return ()
        parts.append(int(piece))
    return tuple(parts)


def local_version(folder: str = APP_DIR) -> str:
    try:
        with open(os.path.join(folder, VERSION_FILE), encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return "0"


def _fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "stem-remixer-updater"})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return response.read()


def remote_version(branch: str, fetch=_fetch) -> str:
    url = f"https://raw.githubusercontent.com/{REPOSITORY}/{branch}/{FOLDER}/{VERSION_FILE}"
    return fetch(url).decode("utf-8", "replace").strip()


def check(folder: str = APP_DIR, fetch=_fetch):
    """Look for a newer version. Returns (version, branch), or None if this
    is the newest. Raises UpdateError if GitHub couldn't be reached at all."""
    best, reached = None, False
    for branch in BRANCHES:
        try:
            version = remote_version(branch, fetch)
        except Exception:
            continue  # that branch doesn't have the app (or no connection)
        reached = True
        if parse_version(version) and (best is None or parse_version(version) > parse_version(best[0])):
            best = (version, branch)
    if not reached:
        raise UpdateError("Couldn't reach GitHub to look for updates. Check your internet "
                          "connection and try again.")
    if best and parse_version(best[0]) > parse_version(local_version(folder)):
        return best
    return None


def apply(branch: str, folder: str = APP_DIR, fetch=_fetch) -> bool:
    """Download `branch` and copy the app's files over the ones in `folder`.
    Returns True if requirements.txt changed (so new parts need installing)."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(
            fetch(f"https://codeload.github.com/{REPOSITORY}/zip/refs/heads/{branch}")))
    except Exception as err:
        raise UpdateError(f"The download failed. Check your internet connection and try again.\n\n({err})")
    marker = f"/{FOLDER}/"
    files = {}
    for name in archive.namelist():
        if marker in name and not name.endswith("/"):
            relative = name.split(marker, 1)[1]
            target = os.path.normpath(os.path.join(folder, relative))
            if target.startswith(os.path.normpath(folder) + os.sep):
                files[relative] = (name, target)
    if "main.py" not in files or VERSION_FILE not in files:
        raise UpdateError("The download didn't contain the app. Nothing was changed.")

    def current(path: str) -> bytes:
        try:
            with open(path, "rb") as handle:
                return handle.read()
        except OSError:
            return b""

    requirements_changed = ("requirements.txt" in files and
                            archive.read(files["requirements.txt"][0])
                            != current(files["requirements.txt"][1]))
    # The version file goes last, so an update that is interrupted is offered again.
    order = sorted(files, key=lambda relative: relative == VERSION_FILE)
    for relative in order:
        name, target = files[relative]
        data = archive.read(name)
        if data == current(target):
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        try:
            with open(target + ".new", "wb") as handle:
                handle.write(data)
            os.replace(target + ".new", target)
        except OSError as err:
            if relative.endswith(".py") or relative == VERSION_FILE:
                raise UpdateError(f"Couldn't replace {relative}. Close other copies of the app "
                                  f"and try again.\n\n({err})")
            # an icon or similar that Windows has open: keep the old one
    return requirements_changed


def install_requirements(folder: str = APP_DIR) -> None:
    """Fetch any new parts the update needs (pip install -r requirements.txt)."""
    python = sys.executable
    console = os.path.join(os.path.dirname(python), "python.exe")
    if os.path.basename(python).lower() == "pythonw.exe" and os.path.exists(console):
        python = console
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    result = subprocess.run(
        [python, "-m", "pip", "install", "-r", os.path.join(folder, "requirements.txt")],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        creationflags=flags)
    if result.returncode != 0:
        tail = result.stdout.decode("utf-8", "replace").strip().splitlines()[-3:]
        raise UpdateError("The app was updated, but fetching its new parts failed. "
                          "Run Install.cmd in the app's folder to finish.\n\n(" + " ".join(tail) + ")")


def restart(folder: str = APP_DIR) -> None:
    """Start the updated app. The caller then closes this one."""
    subprocess.Popen([sys.executable, os.path.join(folder, "main.py")], cwd=folder)
