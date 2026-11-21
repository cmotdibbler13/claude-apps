"""Autocue Studio — teleprompter (top) + voice recorder (bottom) UI.

Two ways to work:

* Scroll mode (default): paste a script, press Record, the text scrolls while
  one long take is recorded as recording_<timestamp>.wav.
* Line mode: press "Load script" and pick a line script (see README). One line
  is shown at a time; each take is saved as <name>_<id>.wav in
  Recordings/<name>/, so takes can be dropped straight back into an edit.
"""

import colorsys
import math
import os
import re
import shutil
import time
import tkinter as tk
import tkinter.filedialog as filedialog
import tkinter.font as tkfont
import tkinter.messagebox as messagebox
from collections import deque
from datetime import datetime

import customtkinter as ctk

from audio_recorder import AudioRecorder

try:
    from mic_gain import MicGainController
except Exception:  # pycaw missing or COM unavailable — gain UI degrades to n/a
    MicGainController = None

APP_DIR = os.path.dirname(os.path.abspath(__file__))
RECORDINGS_DIR = os.path.join(APP_DIR, "Recordings")

SCROLL_TICK_MS = 30
METER_TICK_MS = 50
COUNTDOWN_FROM = 3
LINE_COUNTDOWN_DEFAULT = "2"

DEFAULT_FONT_SIZE = 28
MIN_FONT_SIZE = 14
MAX_FONT_SIZE = 64

MIN_SPEED = 10.0  # pixels per second
MAX_SPEED = 150.0
DEFAULT_SPEED = 40.0

MAX_RECENT_RECORDINGS = 25

# Auto-trim: if the signal clips this often, step the Windows mic level down.
CLIP_LEVEL = 0.985            # peak level treated as clipping
AUTO_TRIM_CLIPS = 4           # clips within the window that trigger a trim
AUTO_TRIM_WINDOW_S = 3.0
AUTO_TRIM_STEP = 5            # percent per trim
AUTO_TRIM_COOLDOWN_S = 2.0
AUTO_TRIM_FLOOR = 10          # never auto-trim below this percent

STARTER_TEXT = (
    "Paste or type your script here.\n\n"
    "Set your font size and scroll speed above, pick a microphone below, "
    "then press  ● Record.  After a 3-2-1 countdown the script scrolls "
    "automatically while your voice is recorded.\n\n"
    "To record one line at a time, press  Load script  and pick a line script."
)

# --- Six Minutes On… palette (Night theme), from the channel design kit ---
SURFACE_000 = "#03070c"   # page ground
SURFACE_100 = "#091a2e"   # bands and sections
SURFACE_200 = "#0d2440"   # cards and panels
SURFACE_300 = "#14304f"   # hover / selected
INK = "#eaebed"
INK_MUTED = "#a3adb8"
INK_FAINT = "#7d8690"
BRASS = "#d5a867"         # the signature accent
BRASS_HOVER = "#c49046"
ON_BRASS = "#1a1206"      # text on brass fills, never white
TIDE = "#86bfdb"          # live / now indicator
RULE = "#24395a"          # decorative hairlines
RULE_STRONG = "#647b98"   # borders that carry meaning

ACCENT_GREEN = BRASS      # saved-state confirmations: the brand has no green
MUTED = INK_MUTED

THIN_SPACE = " "


def tracked(text: str) -> str:
    """The brand's eyebrow style: uppercase, letter-spaced. Tk fonts have no
    letter-spacing, so thin spaces stand in for the 0.22em tracking."""
    return THIN_SPACE.join(text.upper())


PAUSE_TEXT = "‖  " + tracked("Pause")
RESUME_TEXT = "▶  " + tracked("Resume")


# ---------------------------------------------------------------- scripts

def parse_line_script(path: str) -> tuple[str, list[dict]]:
    """Read a line script. Returns (name, lines).

    Format:
        # name: china_clay        -> file prefix (otherwise the file name)
        # anything                -> comment, ignored
        ## Section title          -> section heading for the lines that follow
        [05.2]  (anything)        -> starts a new line with id 05.2
        text...                   -> the words to read (may span lines)
        > note                    -> shown in grey, not read
    """
    name = os.path.splitext(os.path.basename(path))[0]
    lines: list[dict] = []
    section = ""
    current = None
    with open(path, encoding="utf-8-sig") as fh:
        for raw in fh:
            line = raw.strip()
            if not line:
                continue
            m = re.match(r"#\s*name\s*:\s*(\S+)", line, re.I)
            if m:
                name = m.group(1)
                continue
            if line.startswith("## "):
                section = line[3:].strip()
                continue
            if line.startswith("#"):
                continue
            m = re.match(r"\[([^\]]+)\]", line)
            if m:
                current = {"id": m.group(1).strip(), "section": section,
                           "text": "", "notes": []}
                lines.append(current)
                continue
            if current is None:
                continue
            if line.startswith(">"):
                current["notes"].append(line[1:].strip())
            else:
                current["text"] = (current["text"] + " " + line).strip()
    lines = [ln for ln in lines if ln["text"]]
    return name, lines


class LEDMeter(tk.Canvas):
    """Compact LED-style peak meter: stacked segments, green at the bottom
    through yellow and orange to red at the top, with a peak-hold segment.

    Levels are mapped to dB (-48 dB .. 0 dB) so quiet speech still moves the
    bottom of the meter instead of the display sitting near zero.
    """

    SEGMENTS = 12
    COLUMNS = 2
    SEG_W = 18
    SEG_H = 6
    GAP = 3
    COL_GAP = 4
    PAD = 7
    FLOOR_DB = -48.0
    PEAK_DECAY = 0.018  # fraction per tick the held peak falls

    def __init__(self, master):
        width = self.PAD * 2 + self.COLUMNS * self.SEG_W + (self.COLUMNS - 1) * self.COL_GAP
        height = self.PAD * 2 + self.SEGMENTS * self.SEG_H + (self.SEGMENTS - 1) * self.GAP
        super().__init__(
            master,
            width=width,
            height=height,
            bg=SURFACE_000,
            highlightthickness=0,
            bd=0,
        )
        self._on_colors: list[str] = []
        self._off_colors: list[str] = []
        for i in range(self.SEGMENTS):
            hue = 120.0 * (1.0 - i / (self.SEGMENTS - 1)) / 360.0  # green → red
            on = colorsys.hsv_to_rgb(hue, 0.92, 0.95)
            off = colorsys.hsv_to_rgb(hue, 0.85, 0.16)
            self._on_colors.append("#%02x%02x%02x" % tuple(int(c * 255) for c in on))
            self._off_colors.append("#%02x%02x%02x" % tuple(int(c * 255) for c in off))

        # One rectangle item per segment per column, bottom row = index 0.
        self._items: list[list[int]] = []
        for col in range(self.COLUMNS):
            x0 = self.PAD + col * (self.SEG_W + self.COL_GAP)
            column_items = []
            for i in range(self.SEGMENTS):
                y1 = height - self.PAD - i * (self.SEG_H + self.GAP)
                item = self.create_rectangle(
                    x0, y1 - self.SEG_H, x0 + self.SEG_W, y1,
                    fill=self._off_colors[i], width=0,
                )
                column_items.append(item)
            self._items.append(column_items)

        self._peak_frac = 0.0
        self._last_drawn = (0, -1)

    def _to_fraction(self, level: float) -> float:
        if level <= 0.0005:
            return 0.0
        db = 20.0 * math.log10(level)
        return max(0.0, min(1.0, (db - self.FLOOR_DB) / -self.FLOOR_DB))

    def set_level(self, level: float) -> None:
        frac = self._to_fraction(level)
        self._peak_frac = max(self._peak_frac - self.PEAK_DECAY, frac)
        lit = int(round(frac * self.SEGMENTS))
        peak_seg = math.ceil(self._peak_frac * self.SEGMENTS) - 1
        if (lit, peak_seg) == self._last_drawn:
            return
        self._last_drawn = (lit, peak_seg)
        for column_items in self._items:
            for i, item in enumerate(column_items):
                on = i < lit or i == peak_seg
                self.itemconfigure(
                    item, fill=self._on_colors[i] if on else self._off_colors[i]
                )

    def reset(self) -> None:
        self._peak_frac = 0.0
        self.set_level(0.0)


class AutocueApp(ctk.CTk):
    def __init__(self):
        ctk.set_appearance_mode("dark")
        ctk.set_default_color_theme("dark-blue")
        super().__init__()

        self.title("Autocue Studio")
        icon_path = os.path.join(APP_DIR, "assets", "icon.ico")
        if os.path.exists(icon_path):
            self.iconbitmap(icon_path)
        self.geometry("1020x800")
        self.minsize(840, 680)
        self.configure(fg_color=SURFACE_000)

        # Brand type: Inter when installed, else the closest system faces.
        families = set(tkfont.families())
        sans = "Inter" if "Inter" in families else "Segoe UI"
        light = next(
            (f for f in (f"{sans} Light", "Segoe UI Light") if f in families), sans
        )
        self._sans = sans
        self._eyebrow_font = ctk.CTkFont(family=sans, size=12)
        self._ui_font = ctk.CTkFont(family=sans, size=13)
        self._small_font = ctk.CTkFont(family=sans, size=12)
        self._timer_font = ctk.CTkFont(family=light, size=56)
        self._countdown_font = ctk.CTkFont(family=light, size=130)

        self.recorder = AudioRecorder(RECORDINGS_DIR)

        self.font_size = DEFAULT_FONT_SIZE
        self.scroll_speed = ctk.DoubleVar(value=DEFAULT_SPEED)
        self._scrolling = False
        self._scroll_remainder = 0.0
        self._scroll_job = None
        self._device_map: dict[str, int] = {}
        self._counting_down = False

        # mic gain / auto-trim state
        self.mic_gain = MicGainController() if MicGainController else None
        self.auto_trim = ctk.BooleanVar(value=True)
        self._gain_ui_updating = False
        self._clip_times: deque[float] = deque(maxlen=32)
        self._last_trim = -1e9

        # line mode state
        self.line_mode = False
        self.script_name = ""
        self.script_lines: list[dict] = []
        self.line_index = 0
        self._pending_final_path: str | None = None
        self.auto_advance = ctk.BooleanVar(value=True)
        self.line_countdown = ctk.StringVar(value=LINE_COUNTDOWN_DEFAULT)

        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(0, weight=3)
        self.grid_rowconfigure(1, weight=2)

        self._build_teleprompter()
        self._build_recorder_panel()
        self._refresh_devices()
        self._refresh_recordings()
        self._poll_meter()
        self._bind_keys()

        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ------------------------------------------------------ brand widgets

    def _secondary_button(self, master, text, width=100, height=28, command=None):
        """Square, hairline-bordered button — the brand's secondary action."""
        return ctk.CTkButton(
            master, text=text, width=width, height=height, command=command,
            corner_radius=0, fg_color="transparent", hover_color=SURFACE_300,
            border_width=1, border_color=RULE_STRONG,
            text_color=INK, text_color_disabled=INK_FAINT, font=self._small_font,
        )

    def _brand_slider(self, master, **kwargs):
        return ctk.CTkSlider(
            master, fg_color=RULE, progress_color=BRASS,
            button_color=BRASS, button_hover_color=BRASS_HOVER, **kwargs
        )

    def _brand_checkbox(self, master, **kwargs):
        return ctk.CTkCheckBox(
            master, corner_radius=0, border_width=1, border_color=RULE_STRONG,
            fg_color=BRASS, hover_color=BRASS_HOVER, checkmark_color=ON_BRASS,
            font=self._small_font, text_color=INK_MUTED, **kwargs
        )

    def _brand_optionmenu(self, master, **kwargs):
        return ctk.CTkOptionMenu(
            master, corner_radius=0, fg_color=SURFACE_200,
            button_color=SURFACE_300, button_hover_color=RULE_STRONG,
            text_color=INK, font=self._small_font,
            dropdown_fg_color=SURFACE_200, dropdown_text_color=INK,
            dropdown_hover_color=SURFACE_300, **kwargs
        )

    # ------------------------------------------------------------------ UI

    def _build_teleprompter(self) -> None:
        prompter = ctk.CTkFrame(
            self, corner_radius=0, fg_color=SURFACE_100,
            border_width=1, border_color=RULE,
        )
        prompter.grid(row=0, column=0, sticky="nsew", padx=16, pady=(16, 8))
        prompter.grid_columnconfigure(0, weight=1)
        prompter.grid_rowconfigure(2, weight=1)
        self._prompter = prompter

        toolbar = ctk.CTkFrame(prompter, fg_color="transparent")
        toolbar.grid(row=0, column=0, sticky="ew", padx=16, pady=(14, 10))

        ctk.CTkLabel(
            toolbar, text=tracked("Teleprompter"),
            font=self._eyebrow_font, text_color=BRASS,
        ).pack(side="left")
        self.load_btn = self._secondary_button(
            toolbar, tracked("Load script"), width=120, command=self._on_load_script
        )
        self.load_btn.pack(side="left", padx=(18, 0))

        # Scroll speed (right side of toolbar)
        self.speed_value_label = ctk.CTkLabel(
            toolbar, text="", width=70, font=self._small_font, text_color=INK_MUTED
        )
        self.speed_value_label.pack(side="right", padx=(6, 0))
        self.speed_slider = self._brand_slider(
            toolbar,
            from_=MIN_SPEED,
            to=MAX_SPEED,
            variable=self.scroll_speed,
            command=self._on_speed_change,
            width=180,
        )
        self.speed_slider.pack(side="right")
        ctk.CTkLabel(
            toolbar, text=tracked("Scroll speed"),
            font=self._small_font, text_color=INK_MUTED,
        ).pack(side="right", padx=(16, 10))

        # Font size controls
        self.font_size_label = ctk.CTkLabel(
            toolbar, text=f"{self.font_size} pt", width=50,
            font=self._small_font, text_color=INK_MUTED,
        )
        self.font_size_label.pack(side="right", padx=(6, 0))
        self._secondary_button(
            toolbar, "+", width=32, command=lambda: self._change_font(+2)
        ).pack(side="right", padx=2)
        self._secondary_button(
            toolbar, "−", width=32, command=lambda: self._change_font(-2)
        ).pack(side="right", padx=2)
        ctk.CTkLabel(
            toolbar, text=tracked("Font"),
            font=self._small_font, text_color=INK_MUTED,
        ).pack(side="right", padx=(0, 10))

        # -- Line-mode bar (hidden until a script is loaded) --------------
        self.line_bar = ctk.CTkFrame(prompter, fg_color="transparent")
        self.prev_btn = self._secondary_button(
            self.line_bar, "◀  " + tracked("Prev"), width=90,
            command=lambda: self._step(-1),
        )
        self.prev_btn.pack(side="left")
        self.next_btn = self._secondary_button(
            self.line_bar, tracked("Next") + "  ▶", width=90,
            command=lambda: self._step(+1),
        )
        self.next_btn.pack(side="left", padx=(6, 0))
        self.line_pos_label = ctk.CTkLabel(
            self.line_bar, text="", font=self._ui_font, text_color=INK
        )
        self.line_pos_label.pack(side="left", padx=(14, 0))

        self._secondary_button(
            self.line_bar, tracked("Close"), width=70, command=self._close_script
        ).pack(side="right")
        self.next_missing_btn = self._secondary_button(
            self.line_bar, tracked("Next missing"), width=124,
            command=self._jump_next_unrecorded,
        )
        self.next_missing_btn.pack(side="right", padx=(0, 8))
        self.play_take_btn = self._secondary_button(
            self.line_bar, "▶  " + tracked("Play take"), width=110,
            command=self._play_current_take,
        )
        self.play_take_btn.pack(side="right", padx=(0, 8))
        self._brand_checkbox(
            self.line_bar, text=tracked("Auto-next"), variable=self.auto_advance
        ).pack(side="right", padx=(0, 10))
        self._brand_optionmenu(
            self.line_bar, variable=self.line_countdown,
            values=["0", "1", "2", "3"], width=56,
        ).pack(side="right", padx=(0, 4))
        ctk.CTkLabel(
            self.line_bar, text=tracked("Count-in"),
            font=self._small_font, text_color=INK_MUTED,
        ).pack(side="right", padx=(0, 6))

        # -- Scroll-mode text box -----------------------------------------
        self._script_font = ctk.CTkFont(family=self._sans, size=self.font_size)
        self.textbox = ctk.CTkTextbox(
            prompter,
            wrap="word",
            font=self._script_font,
            corner_radius=0,
            fg_color=SURFACE_000,
            text_color=INK,
            border_width=1,
            border_color=RULE,
            scrollbar_button_color=RULE,
            scrollbar_button_hover_color=RULE_STRONG,
            spacing2=6,   # extra space between wrapped lines
            spacing3=14,  # extra space between paragraphs
            padx=28,
            pady=22,
        )
        self.textbox.grid(row=2, column=0, sticky="nsew", padx=16, pady=(0, 16))
        self.textbox.insert("1.0", STARTER_TEXT)

        # -- Line-mode view (one line at a time) --------------------------
        self.line_view = ctk.CTkFrame(
            prompter, corner_radius=0, fg_color=SURFACE_000,
            border_width=1, border_color=RULE,
        )
        self.line_view.grid_columnconfigure(0, weight=1)
        self.line_view.grid_rowconfigure(2, weight=1)
        self.section_label = ctk.CTkLabel(
            self.line_view, text="", text_color=INK_MUTED, anchor="w",
            font=self._small_font,
        )
        self.section_label.grid(row=0, column=0, sticky="ew", padx=24, pady=(14, 0))
        id_row = ctk.CTkFrame(self.line_view, fg_color="transparent")
        id_row.grid(row=1, column=0, sticky="ew", padx=24, pady=(2, 0))
        self.id_label = ctk.CTkLabel(
            id_row, text="", text_color=BRASS, anchor="w",
            font=ctk.CTkFont(family=self._sans, size=14, weight="bold"),
        )
        self.id_label.pack(side="left")
        self.take_label = ctk.CTkLabel(id_row, text="", font=self._small_font)
        self.take_label.pack(side="left", padx=(16, 0))
        self.line_label = ctk.CTkLabel(
            self.line_view, text="", font=self._script_font,
            justify="left", anchor="nw",
        )
        self.line_label.grid(row=2, column=0, sticky="nsew", padx=24, pady=(10, 4))
        self.note_label = ctk.CTkLabel(
            self.line_view, text="", text_color=BRASS, anchor="w",
            justify="left", font=ctk.CTkFont(family=self._sans, size=14),
        )
        self.note_label.grid(row=3, column=0, sticky="ew", padx=24, pady=(0, 6))
        self.next_label = ctk.CTkLabel(
            self.line_view, text="", text_color=INK_FAINT, anchor="w",
            justify="left", font=ctk.CTkFont(family=self._sans, size=14),
        )
        self.next_label.grid(row=4, column=0, sticky="ew", padx=24, pady=(4, 14))
        self.line_view.bind("<Configure>", self._on_line_view_resize)

        # Big 3-2-1 countdown shown over the script before recording starts.
        self.countdown_label = ctk.CTkLabel(
            prompter,
            text="",
            font=self._countdown_font,
            text_color=BRASS,
            fg_color="transparent",
        )

        # LED level meter, bottom-right corner of the teleprompter, small
        # enough to sit clear of the script text. Created after the text
        # widgets so place() stacks it on top of them.
        self.level_meter = LEDMeter(prompter)
        self.level_meter.place(relx=1.0, rely=1.0, anchor="se", x=-26, y=-28)

        self._on_speed_change(self.scroll_speed.get())

    def _build_recorder_panel(self) -> None:
        panel = ctk.CTkFrame(
            self, corner_radius=0, fg_color=SURFACE_100,
            border_width=1, border_color=RULE,
        )
        panel.grid(row=1, column=0, sticky="nsew", padx=16, pady=(8, 16))
        panel.grid_columnconfigure(0, weight=3, uniform="cols")
        panel.grid_columnconfigure(1, weight=2, uniform="cols")
        panel.grid_rowconfigure(0, weight=1)

        # -- Left: recording controls -----------------------------------
        controls = ctk.CTkFrame(panel, fg_color="transparent")
        controls.grid(row=0, column=0, sticky="nsew", padx=(16, 8), pady=16)
        controls.grid_columnconfigure(0, weight=1)

        mic_row = ctk.CTkFrame(controls, fg_color="transparent")
        mic_row.grid(row=0, column=0, sticky="ew")
        mic_row.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(
            mic_row, text=tracked("Microphone"),
            font=self._small_font, text_color=INK_MUTED,
        ).grid(row=0, column=0, padx=(0, 10))
        self.device_var = ctk.StringVar(value="")
        self.device_menu = self._brand_optionmenu(
            mic_row,
            variable=self.device_var,
            values=[""],
            dynamic_resizing=False,
            command=self._on_device_change,
        )
        self.device_menu.grid(row=0, column=1, sticky="ew")
        self._secondary_button(
            mic_row, "↺", width=34, command=self._refresh_devices
        ).grid(row=0, column=2, padx=(6, 0))

        gain_row = ctk.CTkFrame(controls, fg_color="transparent")
        gain_row.grid(row=1, column=0, sticky="ew", pady=(8, 0))
        gain_row.grid_columnconfigure(1, weight=1)
        ctk.CTkLabel(
            gain_row, text=tracked("Mic gain"),
            font=self._small_font, text_color=INK_MUTED,
        ).grid(row=0, column=0, padx=(0, 10))
        self.gain_slider = self._brand_slider(
            gain_row, from_=0, to=100, command=self._on_gain_slider
        )
        self.gain_slider.grid(row=0, column=1, sticky="ew")
        self.gain_value_label = ctk.CTkLabel(
            gain_row, text="--", width=44,
            font=self._small_font, text_color=INK_MUTED,
        )
        self.gain_value_label.grid(row=0, column=2, padx=(6, 0))
        self._brand_checkbox(
            gain_row, text=tracked("Auto-trim on clipping"), variable=self.auto_trim
        ).grid(row=0, column=3, padx=(12, 0))

        self.timer_label = ctk.CTkLabel(
            controls, text="00:00", font=self._timer_font, text_color=INK
        )
        self.timer_label.grid(row=2, column=0, pady=(14, 12))

        buttons = ctk.CTkFrame(controls, fg_color="transparent")
        buttons.grid(row=3, column=0)
        self.record_btn = ctk.CTkButton(
            buttons,
            text="●  " + tracked("Record"),
            width=150,
            height=44,
            corner_radius=0,
            font=self._eyebrow_font,
            fg_color=BRASS,
            hover_color=BRASS_HOVER,
            text_color=ON_BRASS,
            text_color_disabled=INK_FAINT,
            command=self._on_record,
        )
        self.record_btn.pack(side="left", padx=6)
        self.pause_btn = self._secondary_button(
            buttons, PAUSE_TEXT, width=120, height=44, command=self._on_pause
        )
        self.pause_btn.configure(state="disabled")
        self.pause_btn.pack(side="left", padx=6)
        self.stop_btn = self._secondary_button(
            buttons, "■  " + tracked("Stop"), width=120, height=44,
            command=self._on_stop,
        )
        self.stop_btn.configure(state="disabled")
        self.stop_btn.pack(side="left", padx=6)

        self.status_label = ctk.CTkLabel(
            controls, text="Ready", text_color=INK_MUTED, font=self._small_font
        )
        self.status_label.grid(row=4, column=0, pady=(14, 0))
        self.keys_label = ctk.CTkLabel(
            controls, text="", text_color=INK_FAINT, font=self._small_font
        )
        self.keys_label.grid(row=5, column=0, pady=(4, 0))

        # -- Right: recent recordings ------------------------------------
        recordings = ctk.CTkFrame(
            panel, corner_radius=0, fg_color=SURFACE_200,
            border_width=1, border_color=RULE,
        )
        recordings.grid(row=0, column=1, sticky="nsew", padx=(8, 16), pady=16)
        recordings.grid_columnconfigure(0, weight=1)
        recordings.grid_rowconfigure(1, weight=1)

        header = ctk.CTkFrame(recordings, fg_color="transparent")
        header.grid(row=0, column=0, sticky="ew", padx=12, pady=(10, 6))
        self.recordings_header = ctk.CTkLabel(
            header, text=tracked("Recent recordings"),
            font=self._eyebrow_font, text_color=BRASS,
        )
        self.recordings_header.pack(side="left")
        self._secondary_button(
            header, tracked("Folder"), width=76, height=24,
            command=self._open_recordings_folder,
        ).pack(side="right")

        self.recordings_list = ctk.CTkScrollableFrame(
            recordings, fg_color="transparent",
            scrollbar_button_color=RULE, scrollbar_button_hover_color=RULE_STRONG,
        )
        self.recordings_list.grid(row=1, column=0, sticky="nsew", padx=4, pady=(0, 8))
        self.recordings_list.grid_columnconfigure(0, weight=1)

    # ------------------------------------------------------------ keys

    def _bind_keys(self) -> None:
        self.bind_all("<space>", self._key_space)
        self.bind_all("<Right>", lambda e: self._key_step(+1))
        self.bind_all("<Down>", lambda e: self._key_step(+1))
        self.bind_all("<Left>", lambda e: self._key_step(-1))
        self.bind_all("<Up>", lambda e: self._key_step(-1))

    def _key_space(self, _event=None):
        if not self.line_mode:
            return None  # let space type normally in scroll mode
        if self._counting_down:
            return "break"
        if self.recorder.is_recording:
            self._on_stop()
        else:
            self._on_record()
        return "break"

    def _key_step(self, delta: int):
        if not self.line_mode:
            return None
        self._step(delta)
        return "break"

    # ------------------------------------------------------- teleprompter

    def _change_font(self, delta: int) -> None:
        self.font_size = max(MIN_FONT_SIZE, min(MAX_FONT_SIZE, self.font_size + delta))
        self._script_font.configure(size=self.font_size)
        self.font_size_label.configure(text=f"{self.font_size} pt")

    def _on_speed_change(self, value: float) -> None:
        self.speed_value_label.configure(text=f"{int(float(value))} px/s")

    def _start_scrolling(self) -> None:
        self._stop_scrolling()
        if self.line_mode:
            return  # the line is shown whole; nothing to scroll
        self._scrolling = True
        self._scroll_remainder = 0.0
        self._scroll_tick()

    def _stop_scrolling(self) -> None:
        self._scrolling = False
        if self._scroll_job is not None:
            self.after_cancel(self._scroll_job)
            self._scroll_job = None

    def _scroll_tick(self) -> None:
        if not self._scrolling:
            return
        pixels = self.scroll_speed.get() * SCROLL_TICK_MS / 1000.0 + self._scroll_remainder
        whole_pixels = int(pixels)
        self._scroll_remainder = pixels - whole_pixels
        if whole_pixels:
            # The underlying tkinter Text widget supports pixel-level
            # scrolling, which CTkTextbox does not expose directly.
            self.textbox._textbox.yview_scroll(whole_pixels, "pixels")
        self._scroll_job = self.after(SCROLL_TICK_MS, self._scroll_tick)

    # --------------------------------------------------------- line mode

    def _on_load_script(self) -> None:
        if self.recorder.is_recording or self._counting_down:
            return
        path = filedialog.askopenfilename(
            title="Load line script",
            initialdir=APP_DIR,
            filetypes=[("Line scripts", "*.txt"), ("All files", "*.*")],
        )
        if not path:
            return
        try:
            name, lines = parse_line_script(path)
        except (OSError, UnicodeDecodeError) as exc:
            messagebox.showerror("Could not load script", str(exc))
            return
        if not lines:
            messagebox.showerror(
                "No lines found",
                "That file has no [id] lines. See the README for the line-script format.",
            )
            return
        self.script_name = name
        self.script_lines = lines
        self.line_mode = True
        os.makedirs(self._recordings_dir(), exist_ok=True)

        self.textbox.configure(state="disabled")
        self.textbox.grid_remove()
        self.line_bar.grid(row=1, column=0, sticky="ew", padx=12, pady=(0, 6))
        self.line_view.grid(row=2, column=0, sticky="nsew", padx=12, pady=(0, 12))
        self.speed_slider.configure(state="disabled")
        self.keys_label.configure(
            text="Space = record / stop    ← → = previous / next line"
        )
        self.focus_set()

        missing = self._first_unrecorded(0)
        self.line_index = missing if missing is not None else 0
        self._show_line()
        self._refresh_recordings()
        self.status_label.configure(
            text=f"Loaded {len(lines)} lines · saving to Recordings\\{name}",
            text_color=INK_MUTED,
        )

    def _close_script(self) -> None:
        if self.recorder.is_recording or self._counting_down:
            return
        self.line_mode = False
        self.script_lines = []
        self.line_view.grid_remove()
        self.line_bar.grid_remove()
        self.textbox.configure(state="normal")
        self.textbox.grid()
        self.speed_slider.configure(state="normal")
        self.keys_label.configure(text="")
        self.status_label.configure(text="Ready", text_color=INK_MUTED)
        self._refresh_recordings()

    def _recordings_dir(self) -> str:
        if self.line_mode and self.script_name:
            return os.path.join(RECORDINGS_DIR, self.script_name)
        return RECORDINGS_DIR

    def _take_path(self, index: int) -> str:
        line_id = self.script_lines[index]["id"]
        return os.path.join(self._recordings_dir(), f"{self.script_name}_{line_id}.wav")

    def _first_unrecorded(self, start: int) -> int | None:
        n = len(self.script_lines)
        for k in range(n):
            i = (start + k) % n
            if not os.path.exists(self._take_path(i)):
                return i
        return None

    def _recorded_count(self) -> int:
        return sum(
            os.path.exists(self._take_path(i)) for i in range(len(self.script_lines))
        )

    def _step(self, delta: int) -> None:
        if not self.line_mode or self.recorder.is_recording or self._counting_down:
            return
        new = max(0, min(len(self.script_lines) - 1, self.line_index + delta))
        if new != self.line_index:
            self.line_index = new
            self._show_line()

    def _jump_next_unrecorded(self) -> None:
        if self.recorder.is_recording or self._counting_down:
            return
        nxt = self._first_unrecorded(self.line_index + 1)
        if nxt is None:
            self.status_label.configure(
                text="Every line has a take ✓", text_color=ACCENT_GREEN
            )
            return
        self.line_index = nxt
        self._show_line()

    def _show_line(self) -> None:
        line = self.script_lines[self.line_index]
        total = len(self.script_lines)
        self.section_label.configure(text=line["section"])
        self.id_label.configure(text=f"{self.script_name}_{line['id']}")
        self.line_label.configure(text=line["text"])
        self.note_label.configure(text="    ".join(line["notes"]))
        if self.line_index + 1 < total:
            nxt = self.script_lines[self.line_index + 1]
            self.next_label.configure(text=f"Next  ({nxt['id']}):  {nxt['text']}")
        else:
            self.next_label.configure(text="Last line.")
        self.line_pos_label.configure(
            text=f"Line {self.line_index + 1} of {total}  ·  {line['id']}"
        )
        has_take = os.path.exists(self._take_path(self.line_index))
        done = self._recorded_count()
        self.take_label.configure(
            text=(f"✓ take saved   ({done}/{total} done)" if has_take
                  else f"not recorded yet   ({done}/{total} done)"),
            text_color=ACCENT_GREEN if has_take else MUTED,
        )
        self.play_take_btn.configure(state="normal" if has_take else "disabled")
        self.prev_btn.configure(state="normal" if self.line_index > 0 else "disabled")
        self.next_btn.configure(
            state="normal" if self.line_index < total - 1 else "disabled"
        )
        self.timer_label.configure(text="00:00")

    def _on_line_view_resize(self, event) -> None:
        # event.width is in physical pixels, but CTkLabel multiplies
        # wraplength by the widget scaling (e.g. 2x on a high-DPI display),
        # so convert back to unscaled units or the text never wraps.
        try:
            scale = self.line_view._get_widget_scaling() or 1.0
        except AttributeError:
            scale = 1.0
        wrap = max(200, int(event.width / scale) - 60)
        for label in (self.line_label, self.note_label, self.next_label):
            label.configure(wraplength=wrap)

    def _play_current_take(self) -> None:
        if self.line_mode:
            self._open_recording(self._take_path(self.line_index))

    def _set_line_nav_enabled(self, enabled: bool) -> None:
        state = "normal" if enabled else "disabled"
        for btn in (self.next_missing_btn, self.load_btn):
            btn.configure(state=state)
        if enabled:
            if self.line_mode:
                self._show_line()
        else:
            for btn in (self.prev_btn, self.next_btn, self.play_take_btn):
                btn.configure(state="disabled")

    # ----------------------------------------------------------- devices

    def _refresh_devices(self) -> None:
        devices = AudioRecorder.list_input_devices()
        self._device_map = {name: index for index, name in devices}
        names = list(self._device_map.keys()) or ["No microphone found"]
        self.device_menu.configure(values=names)
        if self.device_var.get() not in self._device_map:
            # Prefer a real mic over Windows' virtual routing devices.
            virtual = ("sound mapper", "primary sound capture")
            real = [n for n in names if not any(v in n.lower() for v in virtual)]
            self.device_var.set(real[0] if real else names[0])
        if self.mic_gain:
            self.mic_gain.refresh()
        self._sync_gain_from_device()

    # ---------------------------------------------------------- mic gain

    def _on_device_change(self, _value=None) -> None:
        self._sync_gain_from_device()

    def _sync_gain_from_device(self) -> None:
        """Point the gain slider at the Windows input level of the mic."""
        percent = None
        if self.mic_gain:
            name = self.device_var.get()
            if name in self._device_map and self.mic_gain.resolve(name):
                percent = self.mic_gain.get_percent()
        self._set_gain_ui(percent)

    def _set_gain_ui(self, percent: int | None) -> None:
        self._gain_ui_updating = True
        try:
            if percent is None:
                self.gain_slider.set(0)
                self.gain_slider.configure(state="disabled")
                self.gain_value_label.configure(text="n/a")
            else:
                self.gain_slider.configure(state="normal")
                self.gain_slider.set(percent)
                self.gain_value_label.configure(text=f"{int(percent)}%")
        finally:
            self._gain_ui_updating = False

    def _on_gain_slider(self, value) -> None:
        if self._gain_ui_updating or not (self.mic_gain and self.mic_gain.available):
            return
        percent = int(float(value))
        if self.mic_gain.set_percent(percent):
            self.gain_value_label.configure(text=f"{percent}%")

    def _register_clip(self) -> None:
        now = time.monotonic()
        self._clip_times.append(now)
        if not (self.auto_trim.get() and self.mic_gain and self.mic_gain.available):
            return
        if now - self._last_trim < AUTO_TRIM_COOLDOWN_S:
            return
        recent = [t for t in self._clip_times if now - t <= AUTO_TRIM_WINDOW_S]
        if len(recent) < AUTO_TRIM_CLIPS:
            return
        current = self.mic_gain.get_percent()
        if current is None or current <= AUTO_TRIM_FLOOR:
            return
        new = max(AUTO_TRIM_FLOOR, current - AUTO_TRIM_STEP)
        if self.mic_gain.set_percent(new):
            self._last_trim = now
            self._clip_times.clear()
            self._set_gain_ui(new)
            self.status_label.configure(
                text=f"Clipping — mic gain trimmed to {new}%", text_color=BRASS
            )

    # --------------------------------------------------------- recording

    def _on_record(self) -> None:
        if self.recorder.is_recording or self._counting_down:
            return
        if not self._device_map:
            messagebox.showerror(
                "No microphone", "No input device was found. Plug in a microphone and press ⟳."
            )
            return
        self.record_btn.configure(state="disabled")
        self.device_menu.configure(state="disabled")
        self._set_line_nav_enabled(False)
        if not self.line_mode:
            self.textbox.yview_moveto(0.0)
        self.status_label.configure(text="Get ready…", text_color=TIDE)
        count = int(self.line_countdown.get()) if self.line_mode else COUNTDOWN_FROM
        self._counting_down = True
        self._countdown(count)

    def _countdown(self, n: int) -> None:
        if n > 0:
            self.countdown_label.configure(text=str(n))
            self.countdown_label.place(relx=0.5, rely=0.5, anchor="center")
            self.after(1000, self._countdown, n - 1)
        else:
            self.countdown_label.place_forget()
            self._counting_down = False
            self._start_recording()

    def _start_recording(self) -> None:
        device_index = self._device_map.get(self.device_var.get())
        path = None
        self._pending_final_path = None
        if self.line_mode:
            final = self._take_path(self.line_index)
            # Record to a temp file; it only replaces the saved take on Stop.
            path = final[:-4] + ".recording.tmp.wav"
            self._pending_final_path = final
        try:
            self.recorder.start(device_index, path)
        except Exception as exc:
            messagebox.showerror(
                "Recording error", f"Could not start recording:\n\n{exc}"
            )
            self._pending_final_path = None
            self._reset_controls()
            return
        self._start_scrolling()
        self.pause_btn.configure(state="normal", text=PAUSE_TEXT)
        self.stop_btn.configure(state="normal")
        self.status_label.configure(text="●  " + tracked("Recording"), text_color=TIDE)

    def _on_pause(self) -> None:
        if not self.recorder.is_recording:
            return
        if self.recorder.is_paused:
            self.recorder.resume()
            self._start_scrolling()
            self.pause_btn.configure(text=PAUSE_TEXT)
            self.status_label.configure(text="●  " + tracked("Recording"), text_color=TIDE)
        else:
            self.recorder.pause()
            self._stop_scrolling()
            self.pause_btn.configure(text=RESUME_TEXT)
            self.status_label.configure(text=tracked("Paused"), text_color=BRASS)

    def _on_stop(self) -> None:
        if not self.recorder.is_recording:
            return
        self._stop_scrolling()
        path = self.recorder.stop()
        final = self._pending_final_path
        self._pending_final_path = None
        if path and final:
            path = self._commit_take(path, final)
        self._reset_controls()
        self._refresh_recordings()
        if path:
            self.status_label.configure(
                text=f"Saved  {os.path.basename(path)}", text_color=ACCENT_GREEN
            )
            if self.line_mode and self.auto_advance.get():
                if self.line_index < len(self.script_lines) - 1:
                    self.line_index += 1
                    self._show_line()

    def _commit_take(self, temp_path: str, final_path: str) -> str:
        """Move an earlier take aside, then make the new take the saved one."""
        try:
            if os.path.exists(final_path):
                old_dir = os.path.join(os.path.dirname(final_path), "superseded")
                os.makedirs(old_dir, exist_ok=True)
                stem = os.path.splitext(os.path.basename(final_path))[0]
                stamp = datetime.now().strftime("%H-%M-%S")
                shutil.move(final_path, os.path.join(old_dir, f"{stem}_{stamp}.wav"))
            os.replace(temp_path, final_path)
            return final_path
        except OSError as exc:
            messagebox.showerror(
                "Could not save take",
                f"The take is still in:\n{temp_path}\n\n{exc}",
            )
            return temp_path

    def _reset_controls(self) -> None:
        self.record_btn.configure(state="normal")
        self.device_menu.configure(state="normal")
        self.pause_btn.configure(state="disabled", text=PAUSE_TEXT)
        self.stop_btn.configure(state="disabled")
        self.level_meter.reset()
        self._set_line_nav_enabled(True)

    def _poll_meter(self) -> None:
        if self.recorder.is_recording:
            level = min(1.0, self.recorder.level)
            self.level_meter.set_level(level)
            if level >= CLIP_LEVEL:
                self._register_clip()
            total = int(self.recorder.elapsed_seconds)
            self.timer_label.configure(text=f"{total // 60:02d}:{total % 60:02d}")
        self.after(METER_TICK_MS, self._poll_meter)

    # -------------------------------------------------- recordings list

    def _open_recordings_folder(self) -> None:
        folder = self._recordings_dir()
        os.makedirs(folder, exist_ok=True)
        os.startfile(folder)

    def _refresh_recordings(self) -> None:
        for child in self.recordings_list.winfo_children():
            child.destroy()

        folder = self._recordings_dir()
        self.recordings_header.configure(
            text=tracked(
                f"Takes / {self.script_name}" if self.line_mode else "Recent recordings"
            )
        )
        try:
            files = [
                os.path.join(folder, f)
                for f in os.listdir(folder)
                if f.lower().endswith(".wav") and not f.endswith(".tmp.wav")
            ]
        except OSError:
            files = []
        files.sort(key=os.path.getmtime, reverse=True)

        if not files:
            ctk.CTkLabel(
                self.recordings_list, text="No recordings yet",
                text_color=INK_MUTED, font=self._small_font,
            ).grid(row=0, column=0, pady=12)
            return

        for row, path in enumerate(files[:MAX_RECENT_RECORDINGS]):
            item = ctk.CTkFrame(self.recordings_list, fg_color="transparent")
            item.grid(row=row, column=0, sticky="ew", pady=2)
            item.grid_columnconfigure(0, weight=1)

            size_mb = os.path.getsize(path) / (1024 * 1024)
            name = os.path.basename(path)
            ctk.CTkLabel(
                item, text=f"{name}  ·  {size_mb:.1f} MB", anchor="w",
                font=self._small_font, text_color=INK,
            ).grid(row=0, column=0, sticky="ew", padx=(4, 6))
            self._secondary_button(
                item, "▶", width=30, height=26,
                command=lambda p=path: self._open_recording(p),
            ).grid(row=0, column=1, padx=2)
            self._secondary_button(
                item, "✕", width=30, height=26,
                command=lambda p=path: self._delete_recording(p),
            ).grid(row=0, column=2, padx=(2, 6))

    def _open_recording(self, path: str) -> None:
        if os.path.exists(path):
            os.startfile(path)  # opens in the default audio player

    def _delete_recording(self, path: str) -> None:
        name = os.path.basename(path)
        if messagebox.askyesno("Delete recording", f"Delete {name}?\n\nThis cannot be undone."):
            try:
                os.remove(path)
            except OSError as exc:
                messagebox.showerror("Delete failed", str(exc))
            self._refresh_recordings()
            if self.line_mode:
                self._show_line()

    # ------------------------------------------------------------ close

    def _on_close(self) -> None:
        if self.recorder.is_recording:
            self._stop_scrolling()
            path = self.recorder.stop()  # finish writing the file before exiting
            if path and self._pending_final_path:
                self._commit_take(path, self._pending_final_path)
        self.destroy()
