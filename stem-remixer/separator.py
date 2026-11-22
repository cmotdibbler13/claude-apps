"""Stem Remixer: splitting a song into stems with Demucs.

Each split song gets its own folder under Stems/, holding one WAV per stem
and a project.json. The JSON is written last, so a folder that has one is a
finished split and can be opened again without redoing the work.
"""

import json
import os
import re

# Shown in the picker -> Demucs model name.
MODELS = {
    "4 stems: vocals, drums, bass, other": "htdemucs",
    "6 stems: adds guitar and piano": "htdemucs_6s",
    "4 stems, best quality (4x slower)": "htdemucs_ft",
}
DEFAULT_MODEL_LABEL = next(iter(MODELS))

# The order the lanes are shown in.
STEM_ORDER = ["vocals", "drums", "bass", "guitar", "piano", "other"]

PROJECT_FILE = "project.json"
AUDIO_TYPES = (".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aac", ".wma", ".aiff", ".aif", ".opus")


class Cancelled(Exception):
    """The user pressed Cancel during a split."""


class SplitError(Exception):
    """A split failed for a reason worth showing in plain words."""


def project_dir(song_path: str, model: str, root: str) -> str:
    name = os.path.splitext(os.path.basename(song_path))[0]
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .") or "song"
    return os.path.join(root, f"{name[:80]} [{model}]")


def order_stems(names) -> list:
    known = [n for n in STEM_ORDER if n in names]
    return known + sorted(n for n in names if n not in STEM_ORDER)


def read_project(folder: str):
    """The project.json of a finished split, or None."""
    try:
        with open(os.path.join(folder, PROJECT_FILE), encoding="utf-8") as handle:
            project = json.load(handle)
    except (OSError, ValueError):
        return None
    stems = project.get("stems") if isinstance(project, dict) else None
    if not isinstance(stems, list) or not stems:
        return None
    if not all(os.path.isfile(os.path.join(folder, f"{s}.wav")) for s in stems):
        return None
    return project


def write_project(folder: str, project: dict) -> None:
    target = os.path.join(folder, PROJECT_FILE)
    with open(target + ".tmp", "w", encoding="utf-8") as handle:
        json.dump(project, handle, indent=2)
    os.replace(target + ".tmp", target)


def loose_stems(folder: str) -> list:
    """Stem names for a folder of WAVs that this app didn't make."""
    try:
        files = os.listdir(folder)
    except OSError:
        return []
    return order_stems([os.path.splitext(f)[0] for f in files if f.lower().endswith(".wav")])


def load_stems(folder: str, names: list):
    """Read the stem WAVs. Returns ({name: float32 array}, samplerate)."""
    import soundfile as sf
    stems, rate = {}, None
    for name in names:
        data, this_rate = sf.read(os.path.join(folder, f"{name}.wav"),
                                  dtype="float32", always_2d=True)
        if rate is not None and this_rate != rate:
            raise SplitError("The stems in this folder have different sample rates.")
        stems[name], rate = data, this_rate
    return stems, rate


def split_progress(info: dict) -> float:
    """Fraction done, from a Demucs progress callback."""
    models = max(1, info.get("models", 1))
    length = max(1, info.get("audio_length", 1))
    within = min(1.0, info.get("segment_offset", 0) / length)
    return min(1.0, (info.get("model_idx_in_bag", 0) + within) / models)


def split(song_path: str, folder: str, model: str, on_status, cancel) -> dict:
    """Split `song_path` into stems in `folder`. Slow: run it off the UI thread.

    on_status(text, fraction_or_None) reports progress; `cancel` is a
    threading.Event. Returns the project dict. Raises Cancelled or SplitError.
    """
    on_status("Starting the splitter…", None)
    try:
        import torch
        import soundfile as sf
        from demucs.api import Separator, LoadAudioError
    except ImportError as err:
        raise SplitError(
            "The splitter isn't installed yet. In this folder, run:\n"
            "pip install -r requirements.txt\n\n(" + str(err) + ")")

    device = "cuda" if torch.cuda.is_available() else "cpu"

    def progress(info: dict) -> None:
        if cancel.is_set():
            raise Cancelled()
        on_status("Splitting", split_progress(info))

    on_status("Loading the model (the first time, this downloads it)…", None)
    try:
        separator = Separator(model=model, device=device, callback=progress)
    except Exception as err:
        raise SplitError(
            "Couldn't load the model. The first split needs an internet "
            "connection to download it.\n\n(" + str(err) + ")")
    if cancel.is_set():
        raise Cancelled()

    on_status("Reading the song…", None)
    try:
        _, stems = separator.separate_audio_file(song_path)
    except LoadAudioError:
        raise SplitError(
            "Couldn't read that file. WAV, FLAC, MP3 and OGG always work; "
            "M4A and other types need FFmpeg installed.")
    except RuntimeError as err:
        if "out of memory" in str(err).lower():
            raise SplitError("The graphics card ran out of memory on this song.")
        raise

    on_status("Saving the stems…", None)
    os.makedirs(folder, exist_ok=True)
    names = order_stems(list(stems))
    for name in names:
        audio = stems[name].clamp(-1.0, 1.0).cpu().numpy().T
        sf.write(os.path.join(folder, f"{name}.wav"), audio,
                 separator.samplerate, subtype="PCM_16")
    project = {"source": os.path.abspath(song_path), "model": model,
               "samplerate": separator.samplerate, "stems": names}
    write_project(folder, project)
    return project
