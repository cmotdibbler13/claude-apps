// Folding a Review section: a ▾ / ▸ button on its heading row hides everything else in the section (kept in the
// page, so a player inside it keeps playing). Remembered per viewer in localStorage; open by default.
import { h } from "./dom.js";

const KEY = (name) => `studio.fold.${name}`;
const memory = new Map(); // when localStorage is blocked: remembered for this session only

export function isFolded(name) {
  try {
    const v = globalThis.localStorage?.getItem(KEY(name));
    if (v != null) return v === "1";
  } catch { /* blocked */ }
  return memory.get(name) ?? false;
}

export function setFolded(name, folded) {
  memory.set(name, !!folded);
  try {
    if (folded) globalThis.localStorage?.setItem(KEY(name), "1");
    else globalThis.localStorage?.removeItem(KEY(name));
  } catch { /* blocked: memory keeps it */ }
}

// section: an element whose first child is its heading row (.h2row). Returns the section.
export function foldable(section, name) {
  if (!section?.children?.length) return section;
  const [row, ...rest] = [...section.children];
  if (typeof row?.append !== "function") return section;
  const btn = h("button", { type: "button", class: "fold" });
  const show = (folded) => {
    for (const el of rest) el.hidden = folded;
    btn.setAttribute("aria-expanded", String(!folded));
    btn.setAttribute("aria-label", `${folded ? "Unfold" : "Fold"} ${name}`);
    btn.title = folded ? "Show this section" : "Fold this section away";
    btn.textContent = folded ? "▸" : "▾";
  };
  btn.addEventListener("click", () => {
    const folded = !isFolded(name);
    setFolded(name, folded);
    show(folded);
  });
  row.append(btn);
  show(isFolded(name));
  return section;
}
