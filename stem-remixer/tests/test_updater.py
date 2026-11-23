import io
import os
import sys
import zipfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import updater


def repo_zip(files: dict) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("claude-apps-main/README.md", "the repo")
        archive.writestr("claude-apps-main/other-app/main.py", "not ours")
        for name, text in files.items():
            archive.writestr("claude-apps-main/stem-remixer/" + name, text)
    return buffer.getvalue()


def fake_github(versions: dict, files: dict = None, api=True, stale=None):
    def fetch(url):
        for branch, version in versions.items():
            if url.endswith(f"/contents/stem-remixer/VERSION?ref={branch}") and api:
                return version.encode()
            if url.endswith(f"/{branch}/stem-remixer/VERSION"):
                return (stale or version).encode()
            if url.endswith(f"/refs/heads/{branch}"):
                return repo_zip(files or {})
        raise OSError("404")
    return fetch


@pytest.fixture
def installed(tmp_path):
    for name, text in {"VERSION": "1.2.0\n", "main.py": "old", "requirements.txt": "numpy",
                       "Stems/song/vocals.wav": "my stems", ".venv/keep": "venv"}.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return tmp_path


def test_versions_compare_as_numbers():
    assert updater.parse_version("1.10.0") > updater.parse_version("1.9.3")
    assert updater.parse_version("<html>404") == ()


def test_check_picks_the_newest_branch(installed):
    folder = str(installed)
    assert updater.check(folder, fake_github({"main": "1.2.0"})) is None
    assert updater.check(folder, fake_github({"main": "1.1.9"})) is None
    assert updater.check(folder, fake_github({"main": "<html>"})) is None
    both = fake_github({"main": "1.3.0", "claude/peaceful-davinci-h3btsz": "1.4.0"})
    assert updater.check(folder, both) == ("1.4.0", "claude/peaceful-davinci-h3btsz")
    with pytest.raises(updater.UpdateError, match="reach GitHub"):
        updater.check(folder, fake_github({}))


def test_apply_replaces_app_files_and_nothing_else(installed):
    files = {"VERSION": "1.3.0\n", "main.py": "new", "requirements.txt": "numpy",
             "assets/icon.ico": "icon", "../../evil.py": "nope"}
    changed = updater.apply("main", str(installed), fake_github({"main": "1.3.0"}, files))
    assert changed is False
    assert (installed / "main.py").read_text() == "new"
    assert (installed / "assets" / "icon.ico").read_text() == "icon"
    assert updater.local_version(str(installed)) == "1.3.0"
    assert (installed / "Stems/song/vocals.wav").read_text() == "my stems"
    assert (installed / ".venv/keep").exists()
    assert not (installed.parent / "evil.py").exists() and not (installed / "other-app").exists()
    assert not list(installed.rglob("*.new"))


def test_apply_reports_new_requirements_and_bad_downloads(installed):
    files = {"VERSION": "1.3.0", "main.py": "new", "requirements.txt": "numpy\nscipy"}
    assert updater.apply("main", str(installed), fake_github({"main": "1.3.0"}, files)) is True
    with pytest.raises(updater.UpdateError, match="didn't contain the app"):
        updater.apply("main", str(installed), fake_github({"main": "1.4.0"}, {"README.md": "x"}))
    with pytest.raises(updater.UpdateError, match="download failed"):
        updater.apply("gone", str(installed), fake_github({"main": "1.4.0"}))
    assert (installed / "main.py").read_text() == "new"  # failed updates changed nothing


def test_version_comes_from_the_api_with_the_file_as_fallback(installed):
    folder = str(installed)
    fresh = fake_github({"main": "1.5.0"}, stale="1.2.0")
    assert updater.check(folder, fresh) == ("1.5.0", "main")
    no_api = fake_github({"main": "1.5.0"}, api=False)
    assert updater.check(folder, no_api) == ("1.5.0", "main")
