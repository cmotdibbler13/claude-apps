"""Stem Remixer: the window.

Open a song, wait for it to be split into stems, then remix it: one lane per
stem with volume, pan, mute and solo, a shared playhead, and an export of
whatever mix is playing.
"""

import os
import queue
import threading
import time
import tkinter as tk
import tkinter.filedialog as filedialog
import tkinter.messagebox as messagebox
import tkinter.simpledialog as simpledialog

import customtkinter as ctk

import separator
from mixer import (MAX_PITCH, MAX_SECTIONS, MAX_TEMPO, MAX_VOLUME, MIN_TEMPO, Mixer, Player, Stem,
                   waveform_peaks, write_audio)

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STEMS_DIR = os.path.join(APP_DIR, "Stems")

TICK_MS = 40
WAVE_HEIGHT = 64

# --- Six Minutes On… palette (Night theme), as in the other apps here ---
SURFACE_000 = "#03070c"
SURFACE_100 = "#091a2e"
SURFACE_200 = "#0d2440"
SURFACE_300 = "#14304f"
INK = "#eaebed"
INK_MUTED = "#a3adb8"
INK_FAINT = "#7d8690"
BRASS = "#d5a867"
BRASS_HOVER = "#c49046"
ON_BRASS = "#1a1206"
TIDE = "#86bfdb"
RULE = "#24395a"
WARN = "#e0876a"

STEM_COLOURS = {
    "vocals": "#d5a867", "drums": "#86bfdb", "bass": "#d98f8f",
    "guitar": "#9fc48b", "piano": "#b9a4d8", "other": "#a3adb8",
}
WAVE_OFF = "#2b4263"   # waveform of a stem that isn't being heard


def clock(seconds: float) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds // 60}:{seconds % 60:02d}"


def time_left(seconds: float) -> str:
    if seconds < 50:
        return "under a minute left"
    minutes = round(seconds / 60)
    return f"about {minutes} minute{'s' if minutes != 1 else ''} left"


class StemLane:
    """One row of the mixer: the controls and waveform of a single stem."""

    def __init__(self, app, parent, stem: Stem, scale: float):
        self.app = app
        self.stem = stem
        self.colour = STEM_COLOURS.get(stem.name, INK_MUTED)
        self.peaks = waveform_peaks(stem.data)
        self.scale = scale
        self._shape = None
        self._section = None
        self._edges = []
        self._playhead = None
        self._drawn_on = None

        self.frame = ctk.CTkFrame(parent, fg_color=SURFACE_200, corner_radius=0)
        self.frame.grid_columnconfigure(2, weight=1)
        self.frame.grid_rowconfigure((0, 1), weight=1)

        tk.Frame(self.frame, bg=self.colour, width=4).grid(
            row=0, column=0, rowspan=2, sticky="ns")

        head = ctk.CTkFrame(self.frame, fg_color="transparent")
        head.grid(row=0, column=1, sticky="sw", padx=(12, 8), pady=(8, 0))
        ctk.CTkLabel(head, text=stem.name.capitalize(), text_color=INK, width=70,
                     anchor="w", font=ctk.CTkFont(size=15, weight="bold")).pack(side="left")
        self.mute_btn = self._toggle(head, "M", self._on_mute)
        self.mute_btn.pack(side="left", padx=(4, 4))
        self.solo_btn = self._toggle(head, "S", self._on_solo)
        self.solo_btn.pack(side="left")

        knobs = ctk.CTkFrame(self.frame, fg_color="transparent")
        knobs.grid(row=1, column=1, sticky="nw", padx=(12, 8), pady=(2, 8))
        ctk.CTkLabel(knobs, text="Vol", text_color=INK_FAINT, width=26,
                     anchor="w").grid(row=0, column=0)
        self.volume = ctk.CTkSlider(
            knobs, from_=0, to=MAX_VOLUME, width=120, command=self._on_volume,
            progress_color=self.colour, button_color=INK, button_hover_color=BRASS,
            fg_color=SURFACE_000)
        self.volume.grid(row=0, column=1, padx=(0, 4))
        self.volume_text = ctk.CTkLabel(knobs, text="", text_color=INK_MUTED,
                                        width=44, anchor="e")
        self.volume_text.grid(row=0, column=2)
        ctk.CTkLabel(knobs, text="Pan", text_color=INK_FAINT, width=26,
                     anchor="w").grid(row=1, column=0)
        self.pan = ctk.CTkSlider(
            knobs, from_=-1, to=1, width=120, command=self._on_pan,
            progress_color=SURFACE_000, button_color=INK, button_hover_color=BRASS,
            fg_color=SURFACE_000)
        self.pan.grid(row=1, column=1, padx=(0, 4))
        self.pan_text = ctk.CTkLabel(knobs, text="", text_color=INK_MUTED,
                                     width=44, anchor="e")
        self.pan_text.grid(row=1, column=2)
        # Double-click a slider to put it back.
        self.volume.bind("<Double-Button-1>", lambda _e: self._set(volume=1.0))
        self.pan.bind("<Double-Button-1>", lambda _e: self._set(pan=0.0))

        self.canvas = tk.Canvas(self.frame, height=WAVE_HEIGHT, bg=SURFACE_100,
                                highlightthickness=0, cursor="hand2")
        self.canvas.grid(row=0, column=2, rowspan=2, sticky="nsew", padx=(4, 10), pady=8)
        self.canvas.bind("<Configure>", lambda _e: self.draw())
        self.canvas.bind("<Button-1>", self._on_seek)
        self.canvas.bind("<B1-Motion>", self._on_seek)
        # Shift+drag, or a drag with the right button, marks the section to loop.
        for press, drag in (("<Shift-Button-1>", "<Shift-B1-Motion>"),
                            ("<Button-3>", "<B3-Motion>")):
            self.canvas.bind(press, self._on_mark_start)
            self.canvas.bind(drag, self._on_mark_drag)

        self.refresh()

    def _toggle(self, parent, text, command):
        return ctk.CTkButton(parent, text=text, width=30, height=26, corner_radius=0,
                             command=command, font=ctk.CTkFont(size=13, weight="bold"))

    # ---------------------------------------------------------- controls

    def _on_mute(self):
        self.stem.mute = not self.stem.mute
        self.app.refresh_lanes()

    def _on_solo(self):
        self.stem.solo = not self.stem.solo
        self.app.refresh_lanes()

    def _on_volume(self, value):
        self.stem.volume = float(value)
        self._labels()

    def _on_pan(self, value):
        value = float(value)
        self.stem.pan = 0.0 if abs(value) < 0.06 else value  # snap to centre
        self._labels()

    def _set(self, volume=None, pan=None):
        if volume is not None:
            self.stem.volume = volume
        if pan is not None:
            self.stem.pan = pan
        self.refresh()

    def _fraction(self, event) -> float:
        return max(0.0, min(1.0, event.x / max(1, self.canvas.winfo_width())))

    def _on_seek(self, event):
        self.app.seek_fraction(self._fraction(event))

    def _on_mark_start(self, event):
        self.app.mark_from = self._fraction(event)
        return "break"

    def _on_mark_drag(self, event):
        self.app.mark_section(self.app.mark_from, self._fraction(event))
        return "break"

    def _labels(self):
        self.volume_text.configure(text=f"{round(self.stem.volume * 100)}%")
        pan = self.stem.pan
        side = "C" if pan == 0 else (f"L{round(-pan * 100)}" if pan < 0 else f"R{round(pan * 100)}")
        self.pan_text.configure(text=side)

    def refresh(self):
        """Make the controls match the stem (after a toggle, reset or load)."""
        self.volume.set(self.stem.volume)
        self.pan.set(self.stem.pan)
        self._labels()
        on, off = (BRASS, ON_BRASS, BRASS_HOVER), (SURFACE_000, INK_MUTED, SURFACE_300)
        for button, active, fill in ((self.mute_btn, self.stem.mute, (WARN, ON_BRASS, WARN)),
                                     (self.solo_btn, self.stem.solo, on)):
            fg, text, hover = fill if active else off
            button.configure(fg_color=fg, text_color=text, hover_color=hover)
        self.colour_wave()

    # ---------------------------------------------------------- waveform

    def draw(self):
        width, height = self.canvas.winfo_width(), self.canvas.winfo_height()
        if width < 8 or height < 8 or (width, height) == self._drawn_on:
            return
        self._drawn_on = (width, height)
        self.canvas.delete("all")
        mid = height / 2
        columns = min(width, len(self.peaks))
        step = len(self.peaks) / columns
        tops = [float(self.peaks[int(i * step):max(int(i * step) + 1, int((i + 1) * step))].max())
                for i in range(columns)]
        reach = (mid - 2) / self.scale if self.scale > 0 else 0
        xs = [i * width / columns for i in range(columns)]
        points = []
        for x, top in zip(xs, tops):
            points += [x, mid - max(0.5, top * reach)]
        for x, top in zip(reversed(xs), reversed(tops)):
            points += [x, mid + max(0.5, top * reach)]
        self._section = self.canvas.create_rectangle(0, 0, 0, 0, outline="", state="hidden")
        self._shape = self.canvas.create_polygon(points, outline="", fill=self.colour)
        self._edges = [self.canvas.create_line(0, 0, 0, 0, width=1, state="hidden")
                       for _ in range(2)]
        self._playhead = self.canvas.create_line(0, 0, 0, height, fill=INK, width=1)
        self.colour_wave()
        self.place_section()
        self.place_saved()
        self.app.place_playheads()

    def place_saved(self):
        """A thin bar along the top for each saved section."""
        mixer = self.app.mixer
        if self._shape is None or mixer is None:
            return
        self.canvas.delete("saved")
        width = self.canvas.winfo_width()
        for section in mixer.sections:
            left = section["start"] / max(1, mixer.length - 1) * width
            right = section["end"] / max(1, mixer.length - 1) * width
            self.canvas.create_rectangle(left, 0, max(left + 2, right - 1), 3, outline="",
                                         fill=INK_FAINT, tags="saved")

    def place_section(self):
        """Show the marked section: lit when looping, a faint outline when not."""
        mixer = self.app.mixer
        if self._shape is None or mixer is None:
            return
        if mixer.loop_start is None:
            for item in [self._section] + self._edges:
                self.canvas.itemconfigure(item, state="hidden")
            return
        width, height = self.canvas.winfo_width(), self.canvas.winfo_height()
        left = mixer.loop_start / max(1, mixer.length - 1) * width
        right = mixer.loop_end / max(1, mixer.length - 1) * width
        self.canvas.coords(self._section, left, 0, right, height)
        self.canvas.itemconfigure(self._section, state="normal",
                                  fill=SURFACE_300 if mixer.loop_on else SURFACE_200)
        for item, x in zip(self._edges, (left, right)):
            self.canvas.coords(item, x, 0, x, height)
            self.canvas.itemconfigure(item, state="normal",
                                      fill=BRASS if mixer.loop_on else INK_FAINT)

    def colour_wave(self):
        if self._shape is not None:
            heard = self.app.mixer is not None and self.app.mixer.is_audible(self.stem)
            self.canvas.itemconfigure(self._shape, fill=self.colour if heard else WAVE_OFF)

    def place_playhead(self, fraction: float):
        if self._playhead is not None:
            x = fraction * self.canvas.winfo_width()
            self.canvas.coords(self._playhead, x, 0, x, self.canvas.winfo_height())


class StemRemixerApp(ctk.CTk):
    def __init__(self):
        super().__init__()
        ctk.set_appearance_mode("dark")
        self.title("Stem Remixer")
        self.geometry("1180x760")
        self.minsize(1120, 640)
        self.configure(fg_color=SURFACE_000)
        icon_path = os.path.join(APP_DIR, "assets", "icon.ico")
        if os.path.exists(icon_path):
            try:
                self.iconbitmap(icon_path)
            except tk.TclError:
                pass  # not Windows; cosmetic only

        self.mixer = None
        self.folder = None          # the open project's folder
        self.project = None         # its project.json (None for loose stems)
        self.song_name = ""
        self.player = Player()
        self.lanes = []
        self._events = queue.Queue()
        self._cancel = threading.Event()
        self._splitting = False
        self._split_started = 0.0
        self._clip_until = 0.0
        self.mark_from = 0.0        # where a section drag began, as a fraction of the song

        self._build()
        self.bind("<space>", self._on_space)
        self.bind("<l>", lambda _e: self._on_loop())
        for number in range(1, MAX_SECTIONS + 1):
            self.bind(str(number), lambda _e, i=number - 1: self._on_section(i))
        self.bind("<bracketleft>", lambda _e: self._mark_at_playhead(start=True))
        self.bind("<bracketright>", lambda _e: self._mark_at_playhead(start=False))
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(TICK_MS, self._tick)

    # ------------------------------------------------------------- layout

    def _button(self, parent, text, command, primary=False, width=110):
        if primary:
            colours = dict(fg_color=BRASS, hover_color=BRASS_HOVER, text_color=ON_BRASS)
        else:
            colours = dict(fg_color=SURFACE_200, hover_color=SURFACE_300, text_color=INK,
                           border_width=1, border_color=RULE)
        return ctk.CTkButton(parent, text=text, command=command, width=width, height=34,
                             corner_radius=0, text_color_disabled=INK_FAINT, **colours)

    def _build(self):
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(3, weight=1)

        top = ctk.CTkFrame(self, fg_color=SURFACE_100, corner_radius=0)
        top.grid(row=0, column=0, sticky="ew")
        top.grid_columnconfigure(5, weight=1)
        self.open_btn = self._button(top, "Open song…", self._on_open, primary=True, width=120)
        self.open_btn.grid(row=0, column=0, padx=(16, 8), pady=12)
        self.model_label = tk.StringVar(value=separator.DEFAULT_MODEL_LABEL)
        self.model_menu = ctk.CTkOptionMenu(
            top, variable=self.model_label, values=list(separator.MODELS), width=290,
            height=34, corner_radius=0, fg_color=SURFACE_200, button_color=SURFACE_300,
            button_hover_color=RULE, text_color=INK, dropdown_fg_color=SURFACE_200,
            dropdown_hover_color=SURFACE_300, dropdown_text_color=INK)
        self.model_menu.grid(row=0, column=1, padx=(0, 8))
        self.folder_btn = self._button(top, "Open stems folder…", self._on_open_folder, width=150)
        self.folder_btn.grid(row=0, column=2, padx=(0, 8))
        self.show_btn = self._button(top, "Show stems", self._on_show_folder, width=100)
        self.show_btn.grid(row=0, column=3, padx=(0, 8))
        self.reset_btn = self._button(top, "Reset mix", self._on_reset, width=90)
        self.reset_btn.grid(row=0, column=4)
        self.song_label = ctk.CTkLabel(top, text="", text_color=INK_MUTED, anchor="e")
        self.song_label.grid(row=0, column=5, sticky="e", padx=16)

        status = ctk.CTkFrame(self, fg_color="transparent")
        status.grid(row=1, column=0, sticky="ew", padx=16, pady=(10, 6))
        status.grid_columnconfigure(0, weight=1)
        self.status = ctk.CTkLabel(status, text="", text_color=INK_MUTED, anchor="w",
                                   justify="left")
        self.status.grid(row=0, column=0, sticky="w")
        self.progress = ctk.CTkProgressBar(status, height=6, corner_radius=0,
                                           fg_color=SURFACE_200, progress_color=BRASS)
        self.cancel_btn = self._button(status, "Cancel", self._on_cancel, width=80)

        # Saved sections: shown once a song is open.
        self.sections_row = ctk.CTkFrame(self, fg_color="transparent")
        ctk.CTkLabel(self.sections_row, text="Sections", text_color=INK_FAINT).pack(
            side="left", padx=(0, 8))
        self.chips_frame = ctk.CTkFrame(self.sections_row, fg_color="transparent")
        self.chips_frame.pack(side="left")
        self.save_section_btn = ctk.CTkButton(
            self.sections_row, text="+  Save section", command=self._on_save_section,
            width=110, height=26, corner_radius=0, fg_color=SURFACE_200,
            hover_color=SURFACE_300, text_color=INK, border_width=1, border_color=RULE)
        self.save_section_btn.pack(side="left")
        self.chips = []

        self.body = ctk.CTkFrame(self, fg_color=SURFACE_000, corner_radius=0)
        self.body.grid(row=3, column=0, sticky="nsew", padx=16)
        self.body.grid_columnconfigure(0, weight=1)
        self.empty = ctk.CTkLabel(
            self.body, text_color=INK_FAINT, justify="center",
            text="Press  Open song…  and pick a music file.\n\n"
                 "It is split into vocals, drums, bass and the rest, each on its own lane.\n"
                 "Then mute, solo, rebalance and pan the parts, and export your mix.")
        self.body.grid_rowconfigure(0, weight=1)
        self.empty.grid(row=0, column=0)

        bar = ctk.CTkFrame(self, fg_color=SURFACE_100, corner_radius=0)
        bar.grid(row=4, column=0, sticky="ew")
        bar.grid_columnconfigure(12, weight=1)
        self.play_btn = self._button(bar, "▶  Play", self._on_play, primary=True, width=100)
        self.play_btn.grid(row=0, column=0, padx=(16, 8), pady=12)
        self.stop_btn = self._button(bar, "■  Stop", self._on_stop, width=80)
        self.stop_btn.grid(row=0, column=1)
        self.time_label = ctk.CTkLabel(bar, text="0:00 / 0:00", text_color=INK, width=100,
                                       font=ctk.CTkFont(size=15))
        self.time_label.grid(row=0, column=2, padx=(10, 6))
        self.loop_btn = self._button(bar, "Loop", self._on_loop, width=64)
        self.loop_btn.grid(row=0, column=3)

        ctk.CTkLabel(bar, text="Tempo", text_color=INK_FAINT).grid(row=0, column=4, padx=(12, 6))
        self.tempo = self._slider(bar, MIN_TEMPO, MAX_TEMPO, self._on_tempo)
        self.tempo.grid(row=0, column=5)
        self.tempo_text = ctk.CTkLabel(bar, text="100%", text_color=INK_MUTED, width=44)
        self.tempo_text.grid(row=0, column=6)
        ctk.CTkLabel(bar, text="Pitch", text_color=INK_FAINT).grid(row=0, column=7, padx=(12, 6))
        self.pitch = self._slider(bar, -MAX_PITCH, MAX_PITCH, self._on_pitch,
                                  steps=2 * MAX_PITCH, start=0)
        self.pitch.grid(row=0, column=8)
        self.pitch_text = ctk.CTkLabel(bar, text="0", text_color=INK_MUTED, width=30)
        self.pitch_text.grid(row=0, column=9)
        ctk.CTkLabel(bar, text="Master", text_color=INK_FAINT).grid(row=0, column=10, padx=(12, 6))
        self.master_slider = self._slider(bar, 0, MAX_VOLUME, self._on_master)
        self.master_slider.grid(row=0, column=11)
        self.master_text = ctk.CTkLabel(bar, text="100%", text_color=INK_MUTED, width=110,
                                        anchor="w")
        self.master_text.grid(row=0, column=12, sticky="w", padx=(4, 0))
        self.tempo.bind("<Double-Button-1>", lambda _e: self._set_tempo(1.0))
        self.pitch.bind("<Double-Button-1>", lambda _e: self._set_pitch(0))
        self.master_slider.bind("<Double-Button-1>", lambda _e: self._set_master(1.0))

        self.export_btn = self._button(bar, "Export mix…", self._on_export, primary=True, width=110)
        self.export_btn.grid(row=0, column=13, padx=(0, 16))

        self._set_status("Ready. The first split downloads the model (about 80 MB), once.")
        self._enable()

    def _slider(self, parent, low, high, command, steps=None, start=1.0):
        slider = ctk.CTkSlider(parent, from_=low, to=high, width=110, command=command,
                               number_of_steps=steps, progress_color=BRASS, button_color=INK,
                               button_hover_color=BRASS, fg_color=SURFACE_000)
        slider.set(start)
        return slider

    def _set_status(self, text, colour=INK_MUTED):
        self.status.configure(text=text, text_color=colour)

    def _enable(self):
        """Grey out what can't be used right now."""
        loaded = "normal" if self.mixer is not None and not self._splitting else "disabled"
        idle = "disabled" if self._splitting else "normal"
        for widget in (self.play_btn, self.stop_btn, self.reset_btn, self.export_btn,
                       self.show_btn, self.tempo, self.pitch, self.master_slider, self.loop_btn):
            widget.configure(state=loaded)
        for widget in (self.open_btn, self.folder_btn, self.model_menu):
            widget.configure(state=idle)

    # ----------------------------------------------------- opening a song

    def _on_open(self):
        types = " ".join("*" + ext for ext in separator.AUDIO_TYPES)
        path = filedialog.askopenfilename(
            title="Pick a song", filetypes=[("Music", types), ("All files", "*.*")])
        if not path:
            return
        model = separator.MODELS[self.model_label.get()]
        folder = separator.project_dir(path, model, STEMS_DIR)
        project = separator.read_project(folder)
        if project is not None:
            self._load(folder, project)
            return
        self._start_split(path, folder, model)

    def _on_open_folder(self):
        os.makedirs(STEMS_DIR, exist_ok=True)
        folder = filedialog.askdirectory(title="Pick a folder of stems", initialdir=STEMS_DIR)
        if not folder:
            return
        project = separator.read_project(folder)
        if project is None and not separator.loose_stems(folder):
            messagebox.showinfo("Stem Remixer", "There are no WAV stems in that folder.")
            return
        self._load(folder, project)

    def _start_split(self, path, folder, model):
        self._save_mix()
        self.player.stop()
        self._splitting = True
        self._split_started = time.monotonic()
        self._cancel.clear()
        self.progress.set(0)
        self.progress.configure(mode="indeterminate")
        self.progress.grid(row=1, column=0, sticky="ew", pady=(6, 0))
        self.progress.start()
        self.cancel_btn.grid(row=0, column=1, rowspan=2, padx=(12, 0))
        self._enable()

        def work():
            try:
                project = separator.split(
                    path, folder, model,
                    lambda text, fraction: self._events.put(("status", text, fraction)),
                    self._cancel)
                self._events.put(("done", folder, project))
            except separator.Cancelled:
                self._events.put(("cancelled",))
            except separator.SplitError as err:
                self._events.put(("failed", str(err)))
            except Exception as err:  # anything Demucs or torch throws
                self._events.put(("failed", f"The split failed.\n\n({type(err).__name__}: {err})"))

        threading.Thread(target=work, daemon=True).start()

    def _on_cancel(self):
        self._cancel.set()
        self._set_status("Cancelling…")

    def _split_finished(self):
        self._splitting = False
        self.progress.stop()
        self.progress.grid_forget()
        self.cancel_btn.grid_forget()
        self._enable()

    def _handle(self, event):
        kind = event[0]
        if kind == "status":
            _, text, fraction = event
            if self._cancel.is_set():
                return
            if fraction is None:
                self._set_status(text)
                return
            if self.progress.cget("mode") != "determinate":
                self.progress.stop()
                self.progress.configure(mode="determinate")
                self._split_started = time.monotonic()
            self.progress.set(fraction)
            elapsed = time.monotonic() - self._split_started
            left = f", {time_left(elapsed * (1 - fraction) / fraction)}" if fraction > 0.05 else ""
            self._set_status(f"Splitting the song: {round(fraction * 100)}%{left}")
        elif kind == "done":
            self._split_finished()
            self._load(event[1], event[2])
        elif kind == "cancelled":
            self._split_finished()
            self._set_status("Split cancelled.")
        elif kind == "failed":
            self._split_finished()
            self._set_status("The split didn't finish.", WARN)
            messagebox.showerror("Stem Remixer", event[1])

    def _load(self, folder, project):
        """Open a finished split (project) or a loose folder of WAVs (None)."""
        self._save_mix()
        self.player.stop()
        names = project["stems"] if project else separator.loose_stems(folder)
        try:
            audio, rate = separator.load_stems(folder, names)
        except Exception as err:
            messagebox.showerror("Stem Remixer", f"Couldn't open those stems.\n\n({err})")
            return
        self.mixer = Mixer([Stem(name, audio[name]) for name in names], rate)
        if project:
            self.mixer.apply_settings(project.get("mix", {}))
        self.folder, self.project = folder, project
        self.song_name = os.path.basename(folder).rsplit(" [", 1)[0]
        self.player.load(self.mixer)

        for row, lane in enumerate(self.lanes):
            lane.frame.destroy()
            self.body.grid_rowconfigure(row, weight=0)
        self.empty.grid_forget()
        loudest = max((float(waveform_peaks(s.data).max(initial=0.0)) for s in self.mixer.stems),
                      default=1.0) or 1.0
        self.lanes = [StemLane(self, self.body, stem, loudest) for stem in self.mixer.stems]
        for row, lane in enumerate(self.lanes):
            self.body.grid_rowconfigure(row, weight=1)
            lane.frame.grid(row=row, column=0, sticky="nsew", pady=(0, 8))

        self.song_label.configure(text=self.song_name)
        self.tempo.set(self.mixer.tempo)
        self.pitch.set(self.mixer.pitch)
        self.master_slider.set(self.mixer.master)
        self._labels()
        self._enable()
        self._set_status("Space plays and pauses. Click a waveform to jump. "
                         "M mutes a part, S plays it alone. Shift+drag marks a "
                         "section to loop. Double-click a slider to reset it.")
        self.sections_row.grid(row=2, column=0, sticky="w", padx=16, pady=(0, 8))
        self._refresh_sections()
        if self.mixer.loop_start is not None:
            self._show_loop()
        else:
            self._show_loop_button_off()

    # ----------------------------------------------------------- transport

    def _on_space(self, _event):
        if self.mixer is not None and not self._splitting:
            self._on_play()
        return "break"

    def _on_play(self):
        if self.mixer is None:
            return
        if self.player.playing:
            self.player.stop()
        else:
            try:
                self.player.play()
                if self.player.mono:
                    self._set_status(
                        f"Playing in mono through {self.player.device_name or 'this output'}"
                        ", so panning won't be heard. Exports are still stereo.")
            except Exception as err:
                self._set_status("Couldn't start the sound output.", WARN)
                messagebox.showerror("Stem Remixer", str(err))
        self._play_label()

    def _on_stop(self):
        self.player.stop()
        if self.mixer is not None:
            self.mixer.seek(0)
        self._play_label()
        self.place_playheads()

    def _play_label(self):
        self.play_btn.configure(text="❚❚  Pause" if self.player.playing else "▶  Play")

    def seek_fraction(self, fraction: float):
        if self.mixer is not None:
            self.mixer.seek(max(0.0, min(1.0, fraction)) * self.mixer.length)
            self.place_playheads()

    def place_playheads(self):
        if self.mixer is None:
            return
        fraction = self.mixer.position / max(1, self.mixer.length - 1)
        for lane in self.lanes:
            lane.place_playhead(fraction)
        self.time_label.configure(
            text=f"{clock(self.mixer.position / self.mixer.samplerate)} / "
                 f"{clock(self.mixer.duration)}")

    # ---------------------------------------------------------------- loop

    def mark_section(self, one: float, other: float):
        """Mark the section between two fractions of the song and loop it."""
        if self.mixer is None or self._splitting:
            return
        if self.mixer.set_loop(one * self.mixer.length, other * self.mixer.length):
            self.mixer.loop_on = True
            self._show_loop()

    def _mark_at_playhead(self, start: bool):
        """[ and ] move the start or end of the section to the playhead."""
        mixer = self.mixer
        if mixer is None or self._splitting:
            return
        here = mixer.position
        if mixer.loop_start is None:
            ok = mixer.set_loop(here, mixer.length) if start else mixer.set_loop(0, here)
        elif start:
            ok = here < mixer.loop_end and mixer.set_loop(here, mixer.loop_end)
        else:
            ok = here > mixer.loop_start and mixer.set_loop(mixer.loop_start, here)
        if ok:
            mixer.loop_on = True
            self._show_loop()

    # ------------------------------------------------------ saved sections

    def _section_label(self, index: int) -> str:
        section = self.mixer.sections[index]
        rate = self.mixer.samplerate
        name = section["name"] or f"{clock(section['start'] / rate)} to {clock(section['end'] / rate)}"
        return f"  {index + 1}   {name}  "

    def _refresh_sections(self):
        """Rebuild the row of saved-section buttons."""
        for chip in self.chips:
            chip.destroy()
        self.chips = []
        if self.mixer is None:
            return
        for index in range(len(self.mixer.sections)):
            chip = ctk.CTkButton(
                self.chips_frame, text=self._section_label(index), height=26, width=40,
                corner_radius=0, border_width=1, border_color=RULE,
                command=lambda i=index: self._on_section(i))
            chip.bind("<Button-3>", lambda event, i=index: self._section_menu(event, i))
            chip.bind("<Double-Button-1>", lambda _e, i=index: self._rename_section(i))
            chip.pack(side="left", padx=(0, 6))
            self.chips.append(chip)
        self._colour_chips()
        for lane in self.lanes:
            lane.place_saved()

    def _colour_chips(self):
        active = self.mixer.active_section() if self.mixer is not None else None
        for index, chip in enumerate(self.chips):
            on = index == active
            chip.configure(fg_color=BRASS if on else SURFACE_200,
                           text_color=ON_BRASS if on else INK,
                           hover_color=BRASS_HOVER if on else SURFACE_300)

    def _on_save_section(self):
        mixer = self.mixer
        if mixer is None or self._splitting:
            return
        if mixer.loop_start is None:
            self._set_status("Mark a section first: hold Shift and drag across a waveform "
                             "(or drag with the right mouse button). Then save it.")
            return
        if mixer.active_section() is None and len(mixer.sections) >= MAX_SECTIONS:
            self._set_status(f"A song can keep {MAX_SECTIONS} sections. Right-click one to delete it.")
            return
        index = mixer.save_section()
        self._refresh_sections()
        self._save_mix()
        self._set_status(f"Saved as section {index + 1}. Press {index + 1} to come back to it; "
                         "double-click it to name it, right-click to delete it.")

    def _on_section(self, index: int):
        if self.mixer is None or self._splitting:
            return
        if self.mixer.select_section(index):
            self._show_loop()
            self.place_playheads()

    def _section_menu(self, event, index: int):
        menu = tk.Menu(self, tearoff=0)
        menu.add_command(label="Rename…", command=lambda: self._rename_section(index))
        menu.add_command(label="Delete", command=lambda: self._delete_section(index))
        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()

    def _rename_section(self, index: int):
        if self.mixer is None or index >= len(self.mixer.sections):
            return
        section = self.mixer.sections[index]
        name = simpledialog.askstring("Stem Remixer", f"Name for section {index + 1}:",
                                      initialvalue=section["name"], parent=self)
        if name is not None:
            section["name"] = name.strip()[:24]
            self._refresh_sections()
            self._save_mix()

    def _delete_section(self, index: int):
        if self.mixer is None:
            return
        self.mixer.delete_section(index)
        self._refresh_sections()
        self._save_mix()

    def _show_loop_button_off(self):
        self.loop_btn.configure(fg_color=SURFACE_200, text_color=INK, hover_color=SURFACE_300)

    def _on_loop(self):
        mixer = self.mixer
        if mixer is None or self._splitting:
            return
        if mixer.loop_start is None:
            self._set_status("To loop a section, hold Shift and drag across a waveform "
                             "(or drag with the right mouse button). Or press [ and ] "
                             "while it plays to mark the start and end.")
            return
        mixer.loop_on = not mixer.loop_on
        self._show_loop()

    def _show_loop(self):
        mixer = self.mixer
        on = mixer is not None and mixer.loop_on
        self.loop_btn.configure(
            fg_color=BRASS if on else SURFACE_200, text_color=ON_BRASS if on else INK,
            hover_color=BRASS_HOVER if on else SURFACE_300)
        for lane in self.lanes:
            lane.place_section()
        self._colour_chips()
        if mixer is not None and mixer.loop_start is not None:
            start, end = mixer.loop_start / mixer.samplerate, mixer.loop_end / mixer.samplerate
            self._set_status(
                f"{'Looping' if on else 'Loop is off. Marked:'} {clock(start)} to {clock(end)} "
                f"({end - start:.1f} seconds). L turns the loop on and off; "
                "[ and ] move its start and end to the playhead.")

    def _on_tempo(self, value):
        value = float(value)
        self._set_tempo(1.0 if abs(value - 1.0) < 0.025 else round(value, 2), move=False)

    def _set_tempo(self, value, move=True):
        if self.mixer is not None:
            self.mixer.tempo = value
            if move:
                self.tempo.set(value)
            self._labels()

    def _on_pitch(self, value):
        self._set_pitch(int(round(float(value))), move=False)

    def _set_pitch(self, value, move=True):
        if self.mixer is not None:
            self.mixer.pitch = value
            if move:
                self.pitch.set(value)
            self._labels()

    def _on_master(self, value):
        self._set_master(float(value), move=False)

    def _set_master(self, value, move=True):
        if self.mixer is not None:
            self.mixer.master = value
            if move:
                self.master_slider.set(value)
            self._labels()

    def _labels(self):
        if self.mixer is None:
            return
        self.tempo_text.configure(text=f"{round(self.mixer.tempo * 100)}%")
        self.pitch_text.configure(text=f"{self.mixer.pitch:+d}" if self.mixer.pitch else "0")
        clipping = time.monotonic() < self._clip_until
        self.master_text.configure(
            text=f"{round(self.mixer.master * 100)}%" + ("  too loud" if clipping else ""),
            text_color=WARN if clipping else INK_MUTED)

    def refresh_lanes(self):
        for lane in self.lanes:
            lane.refresh()

    def _on_reset(self):
        if self.mixer is None:
            return
        self.mixer.reset()
        self.tempo.set(1.0)
        self.pitch.set(0)
        self.master_slider.set(1.0)
        self._labels()
        self.refresh_lanes()
        self._show_loop()
        self._set_status("Mix reset.")

    # -------------------------------------------------------------- files

    def _on_show_folder(self):
        if self.folder and os.path.isdir(self.folder):
            try:
                os.startfile(self.folder)  # Windows
            except AttributeError:
                self._set_status(self.folder)

    def _on_export(self):
        if self.mixer is None:
            return
        section = None
        if self.mixer.loop_start is not None:
            answer = messagebox.askyesnocancel(
                "Stem Remixer", "Export just the marked section?\n\n"
                "Yes saves the section once through. No saves the whole song.")
            if answer is None:
                return
            if answer:
                section = (self.mixer.loop_start, self.mixer.loop_end)
        path = filedialog.asksaveasfilename(
            title="Export mix", defaultextension=".wav",
            initialfile=f"{self.song_name} ({'loop' if section else 'remix'})",
            filetypes=[("WAV, full quality", "*.wav"), ("MP3, 320 kbps", "*.mp3")])
        if not path:
            return
        self._set_status("Exporting…")
        self.update_idletasks()
        try:
            audio, factor = self.mixer.render_all(section)
            write_audio(path, audio, self.mixer.samplerate)
        except Exception as err:
            self._set_status("The export failed.", WARN)
            messagebox.showerror("Stem Remixer", f"Couldn't save the mix.\n\n({err})")
            return
        note = ("" if factor == 1.0 else
                f" It was turned down to {round(factor * 100)}% so it doesn't distort.")
        self._set_status(f"Saved {os.path.basename(path)}.{note}")
        self._save_mix()

    def _save_mix(self):
        """Remember the mix with the project, so reopening the song restores it."""
        if self.mixer is None or self.project is None or not self.folder:
            return
        self.project["mix"] = self.mixer.settings()
        try:
            separator.write_project(self.folder, self.project)
        except OSError:
            pass  # not worth interrupting anyone over

    def _on_close(self):
        self._cancel.set()
        self.player.stop()
        self._save_mix()
        self.destroy()

    # --------------------------------------------------------------- tick

    def _tick(self):
        try:
            while True:
                self._handle(self._events.get_nowait())
        except queue.Empty:
            pass
        if self.mixer is not None:
            if self.mixer.clipped:
                self.mixer.clipped = False
                self._clip_until = time.monotonic() + 1.5
            if self.mixer.ended and self.player.playing:
                self.player.stop()
                self._play_label()
            if self.player.playing or self._clip_until:
                self._labels()
                if time.monotonic() >= self._clip_until:
                    self._clip_until = 0.0
            if self.player.playing:
                self.place_playheads()
        self.after(TICK_MS, self._tick)
