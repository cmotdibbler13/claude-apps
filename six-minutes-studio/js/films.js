// Discover films under the project root and derive part status from handover files.
import { join } from "./paths.js";

const PART_FILES = ["part1_handover.md", "part2_handover.md", "part3_handover.md"];

async function readText(host, p) {
  try { return await host.fs.read(p, "utf8"); } catch { return null; }
}

function partStatus(done) {
  // done: [bool, bool, bool]. The first missing part is "now"; shorts follow part 3.
  const parts = { 1: "none", 2: "none", 3: "none", shorts: "none" };
  const keys = [1, 2, 3, "shorts"];
  let nowSet = false;
  keys.forEach((k, i) => {
    if (i < 3 && done[i]) parts[k] = "done";
    else if (!nowSet) { parts[k] = "now"; nowSet = true; }
  });
  return parts;
}

export async function scanFilms(host, root) {
  let entries;
  try { entries = await host.fs.list(root); } catch { return []; }
  const films = [];
  for (const e of entries) {
    if (!e.isDirectory) continue;
    try {
      const film = await scanOne(host, root, e);
      if (film) films.push(film);
    } catch { /* one unreadable folder must not hide the others */ }
  }
  films.sort((a, b) => a.title.localeCompare(b.title));
  return films;
}

// Film = {dir, title, number: string|null (digits as written), parts, waiting, hasStudio}
async function scanOne(host, root, e) {
  {
    const dir = join(root, e.name);
    const hasHandover = await host.fs.exists(join(dir, "handover"));
    const hasStudio = await host.fs.exists(join(dir, "studio"));
    if (!hasHandover && !hasStudio) return null;

    const done = [];
    let number = null;
    for (const f of PART_FILES) {
      const text = await readText(host, join(dir, "handover", f));
      done.push(text !== null);
      if (number === null && text !== null) {
        const m = /^\s*Episode:\s*(\d+)/mi.exec(text);
        if (m) number = m[1];
      }
    }

    let waiting = null;
    const raw = await readText(host, join(dir, "studio", "state.json"));
    if (raw !== null) {
      try {
        const w = JSON.parse(raw)?.waiting;
        if (typeof w === "string" && w) waiting = w;
      } catch { /* unreadable state: treat as nothing waiting */ }
    }

    return { dir, title: e.name, number, parts: partStatus(done), waiting, hasStudio };
  }
}
