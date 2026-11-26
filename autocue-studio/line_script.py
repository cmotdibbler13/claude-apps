"""The line script format of Autocue Studio's line mode.

Kept apart from app.py so tools without a UI (the voiceover join) can read a
line script without importing Tk or CustomTkinter.
"""

import os
import re


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
