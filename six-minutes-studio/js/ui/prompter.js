// The prompter bar: stays at the top of the Review while Jon scrolls. Previous / play-pause / next, the time, and
// the line being spoken, autocue style, with the same words, ‖ marks, ＋ gap, note box and Re-record as the list.
// It follows the review's audio element itself (no re-render on timeupdate).
import { h } from "./dom.js";
import { lineEl } from "./pacing.js";

const BACK_S = 1.5; // ⏮ more than this far into a line goes to its start, else to the line before

// The last line whose start is at or before t (0 before the first). Lines without a start are skipped.
export function lineAt(lines, t) {
  let at = 0;
  lines.forEach((l, i) => { if (l.start != null && l.start <= t) at = i; });
  return at;
}

const mmss = (s) => {
  const t = Math.max(0, Math.floor(Number(s) || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

// index: the line the previous bar showed (a repaint builds a new bar; it starts on the same line, so the caret
// paint puts back finds its note box and a note being typed is not swapped away).
export function prompterBar(m, actions, { index = 0 } = {}) {
  const lines = m?.lines ?? [];
  let audio = null, idx = Math.min(Math.max(0, index | 0), Math.max(0, lines.length - 1)), pendingSwap = false;
  const slot = h("div", { class: "pbline" });
  const time = h("span", { class: "pbtime" });
  const play = h("button", { type: "button", class: "pplay" });
  const prev = h("button", { type: "button", class: "pbnav", "aria-label": "Previous line", title: "Previous line" }, "⏮");
  const next = h("button", { type: "button", class: "pbnav", "aria-label": "Next line", title: "Next line" }, "⏭");
  const el = h("div", { class: "prompter", role: "region", "aria-label": "Prompter" },
    h("div", { class: "pbctl" }, prev, play, next, time), slot);
  el.hidden = true;
  showLine(); // before attach, so a repaint's caret restore finds the note box

  const seek = (t) => {
    if (!audio || t == null) return;
    try { audio.currentTime = Math.max(0, t); } catch { /* not loaded yet */ }
    update();
  };
  prev.addEventListener("click", () => {
    const cur = lines[idx];
    if (!audio || !cur || cur.start == null) return;
    const into = (Number(audio.currentTime) || 0) - cur.start;
    if (into > BACK_S) return seek(cur.start);
    for (let i = idx - 1; i >= 0; i--) if (lines[i].start != null) return seek(lines[i].start);
    seek(cur.start);
  });
  next.addEventListener("click", () => {
    for (let i = idx + 1; i < lines.length; i++) if (lines[i].start != null) return seek(lines[i].start);
  });
  play.addEventListener("click", () => {
    if (!audio) return;
    if (audio.paused) Promise.resolve(audio.play?.()).catch(() => {});
    else audio.pause();
    showPlay();
  });

  function showPlay() {
    const going = !!audio && !audio.paused;
    play.setAttribute("aria-label", going ? "Pause" : "Play");
    play.title = going ? "Pause" : "Play";
    play.textContent = going ? "❚❚" : "▶";
  }
  function showLine() {
    const l = lines[idx];
    slot.replaceChildren(l ? lineEl(l, actions, { prefix: "pace-bar" }) : h("span", { class: "hist", text: "No lines yet." }));
    pendingSwap = false;
  }
  // Typing in the bar's note box: the line stays until Jon leaves the box (a focused button doesn't count).
  const typing = () => {
    const a = globalThis.document?.activeElement;
    return !!a && String(a.tagName ?? a.tag ?? "").toLowerCase() === "textarea" && !!slot.contains?.(a);
  };
  function update() {
    const t = Number(audio?.currentTime) || 0;
    const dur = Number(audio?.duration);
    time.textContent = `${mmss(t)} / ${Number.isFinite(dur) && dur > 0 ? mmss(dur) : "–:––"}`;
    const i = lineAt(lines, t);
    if (i !== idx) { idx = i; pendingSwap = true; }
    if (pendingSwap && !typing()) showLine();
    showPlay();
  }
  slot.addEventListener("focusout", () => { if (pendingSwap) setTimeout(() => { if (!typing()) showLine(); }, 0); });

  const EVENTS = ["timeupdate", "seeked", "play", "pause", "loadedmetadata"];
  return {
    el,
    // (Re)binds to the element the review follows; the same element again does nothing; null hides the bar.
    attach(next) {
      if (next === audio) return;
      if (audio) for (const k of EVENTS) audio.removeEventListener(k, update);
      audio = next ?? null;
      el.hidden = !audio || !lines.length;
      if (!audio) return;
      for (const k of EVENTS) audio.addEventListener(k, update);
      update();
    },
    update,
    index: () => idx,
  };
}
