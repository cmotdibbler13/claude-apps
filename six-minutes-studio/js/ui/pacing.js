// Pacing review under the Mix preview player: the script's lines with their words, ‖ pause marks, a note box
// and a Re-record tick per line, Place pauses and Apply pauses. pacingModel is pure; pacingSection builds the DOM;
// followPlayer lights the line being spoken without a re-render.
import { h, btn, playerKey } from "./dom.js";
import { lineWords, takeSig, markState, norm, toUnpaused, notesToPlace, newTakeIds, alignScript } from "../pacing.js";
import { goodFrame } from "../mixplan.js";

const SIZES = [["short", "Short"], ["medium", "Medium"], ["long", "Long"]];
const SIZE_LABEL = Object.fromEntries(SIZES);
const STEP = { VOICEOVER: "joining the voiceover…", FIT: "fitting the score…", MIX: "making the mix…" };
const TIGHT_S = 0.2;
export const COPY = {
  tight: "Tight cut: have a listen",
  "take-changed": "The take changed. Place again",
  "not-found": "Couldn't find this word. Place again",
  older: "Playing the voiceover: the mix is older than it.",
  newTake: "Join again to mark the new take",
};

const keyOf = (word, nth) => `${norm(word)}#${nth}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function countsText(marks, rerecords) {
  const head = marks ? `${plural(marks, "pause", "pauses")} marked` : "No pauses marked";
  return rerecords ? `${head} · ${plural(rerecords, "line", "lines")} to re-record` : head;
}

// Tight: the last good join (frame) reported the quietest spot near the at_s sent for this mark was still loud.
function isTight(frame, id, mark, words, sentence) {
  if (mark.key === "end") return false;
  const w = words.find((x) => norm(x.word) === norm(mark.word) && x.nth === mark.nth);
  const next = w ? words[w.i + 1] : null;
  if (!next) return false;
  const applied = frame?.applied?.[id] ?? [];
  const at = toUnpaused((w.end + next.start) / 2 - (sentence?.start ?? 0), applied);
  const sent = applied.find((a) => Math.abs(a.at_s - at) <= TIGHT_S);
  if (!sent) return false;
  return (frame?.tight ?? []).some((t) => t.id === id && Math.abs(Number(t.at_s) - sent.at_s) <= TIGHT_S);
}

// chain: { applying: {step} | null, placing, error }. canApply: pacingchain.canApply's answer. menu: {id, key} of the open ‖.
export function pacingModel({ state, transcript = null, narration = null, lineScript = null, sig = null, chain = {}, canApply = null, menu = null } = {}) {
  const vo = state?.mix?.voiceover;
  // While the voiceover is joined again the list stays, from the last join's transcript, so marks and notes can still change.
  const voDone = vo?.status === "done";
  if (!vo || (!voDone && !transcript)) return null;
  const pacing = state?.mix?.pacing ?? { lines: {} };
  const rows = narration?.rows ?? [];
  const sigs = Object.fromEntries(rows.map((r) => [r.id, takeSig(r)]));
  // Shown as joined only once the join with these marks is done (not while one runs, or after one failed).
  const applied = voDone && vo.pausesSig != null && vo.pausesSig === sig;
  const frame = goodFrame(vo);
  const newer = newTakeIds(narration, frame);
  const script = lineScript?.lines?.length ? lineScript.lines
    : (transcript?.sentences ?? []).map((s) => ({ id: s.sentence, text: s.text ?? "" }));
  let marks = 0, rerecords = 0;
  const lines = script.map((sl) => {
    const id = sl.id;
    const line = pacing.lines?.[id] ?? {};
    const sentence = (transcript?.sentences ?? []).find((s) => s.sentence === id) ?? null;
    const words = lineWords(transcript, id);
    // A take newer than the last good join: its words here are the old take's.
    const newTake = newer.has(id);
    const markOf = (m) => {
      const own = m.take ?? line.take ?? null;
      let st = markState(m, words, line, id in sigs ? sigs[id] : own);
      if (newTake && m.key !== "end" && st === "ok") st = "take-changed";
      const tight = st === "ok" && isTight(frame, id, m, words, sentence);
      if (st === "ok") marks++;
      return { key: m.key, size: m.size, by: m.by ?? null, state: st, tight, applied: applied && st === "ok",
        text: tight ? COPY.tight : COPY[st] ?? null, open: !!menu && menu.id === id && menu.key === m.key };
    };
    const pauses = line.pauses ?? [];
    const byKey = new Map(pauses.map((m) => [m.key, m]));
    // Jon sees the agreed script; each word points at the recogniser word its pause goes after.
    const toks = words.length && String(sl.text ?? "").trim() ? alignScript(sl.text, words) : words.map((w, i) => ({ word: w.word, i }));
    const ws = toks.map((t, j) => ({ i: t.i, word: t.word, key: t.i != null ? keyOf(words[t.i].word, words[t.i].nth) : null, mark: null,
      first: t.i == null || t.i === 0, last: j === toks.length - 1 }));
    const wordKeys = new Set();
    words.forEach((w, ti) => {
      const k = keyOf(w.word, w.nth);
      const m = byKey.get(k);
      if (!m || !ws.length) return;
      // after the last script word pointing at it, else the last one pointing before it, else the first
      let at = -1;
      ws.forEach((x, j) => { if (x.i === ti) at = j; });
      if (at < 0) ws.forEach((x, j) => { if (x.i != null && x.i < ti) at = j; });
      if (at < 0) at = 0;
      if (ws[at].mark) return; // two marks on one script word: the other shows as a loose mark
      ws[at].mark = markOf(m);
      ws[at].markKey = k;
      wordKeys.add(k);
    });
    const end = byKey.get("end");
    const lost = pauses.filter((m) => m.key !== "end" && !wordKeys.has(m.key)).map(markOf);
    if (line.rerecord) rerecords++;
    const gap = end ? markOf(end) : null;
    return {
      id, start: sentence?.start ?? null, end: sentence?.end ?? null, text: sl.text ?? "",
      words: ws, gap, lost, note: line.note ?? "", reply: line.reply ?? null, rerecord: !!line.rerecord, newTake,
      takeChanged: [...ws.map((w) => w.mark), ...lost, gap].some((m) => m?.state === "take-changed"),
    };
  });

  const x = state?.mix?.mix;
  const mixDone = x?.status === "done";
  const source = voDone && mixDone && x.fromVoiceoverAt === vo.at ? "mix" : "voiceover";
  const applying = chain?.applying ?? null;
  const placing = !!chain?.placing;
  const ca = canApply ?? { ok: true, why: null };
  let why = null;
  if (applying) why = "Applying pauses is already running.";
  else if (placing) why = "Wait for Place pauses to finish.";
  else if (!ca.ok) why = ca.why ?? null;
  return {
    lines,
    counts: countsText(marks, rerecords),
    apply: { enabled: !applying && !placing && ca.ok !== false, label: "Apply pauses", why },
    place: { enabled: !applying && !placing && notesToPlace(pacing).length > 0, label: placing ? "Placing…" : "Place pauses" },
    source,
    player: voDone && source === "voiceover" && vo.wav ? { file: vo.wav, key: playerKey(vo.wav, vo.at) } : null,
    status: voDone && source === "voiceover" && mixDone ? COPY.older : null,
    running: applying ? `Applying pauses: ${STEP[applying.step] ?? "starting…"}` : null,
    error: chain?.error ?? null,
    info: chain?.info ?? null,
  };
}

// ---- DOM ----

function markButton(id, m, label, actions, { gap = false } = {}) {
  const cls = ["pmark", `ps-${m.size}`, m.by === "claude" ? "by-claude" : "by-jon", m.applied ? "applied" : "", m.state !== "ok" ? "off" : "", m.tight ? "tight" : "", gap ? "pgapmark" : ""]
    .filter(Boolean).join(" ");
  return h("button", { type: "button", class: cls, "aria-expanded": String(m.open), "aria-label": `${label}, ${SIZE_LABEL[m.size] ?? m.size}${m.text ? `. ${m.text}` : ""}`,
    title: m.text ?? `${SIZE_LABEL[m.size] ?? m.size} pause${m.by === "claude" ? ", placed by Claude" : ""}`, onclick: () => actions.openMark(id, m.key) }, gap ? "‖ gap" : "‖");
}

function markMenu(id, m, actions, { first = false, gap = false, lost = false } = {}) {
  const op = (o) => () => actions.editMark(id, m.key, o);
  const kids = lost ? [] : [
    ...SIZES.map(([k, t]) => h("button", { type: "button", class: `pop${m.size === k ? " on" : ""}`, "aria-pressed": String(m.size === k), onclick: op(k) }, t)),
    h("button", { type: "button", class: "pop", "aria-label": "Move to the word before", disabled: first, onclick: op("left") }, "◀"),
    h("button", { type: "button", class: "pop", "aria-label": "Move to the word after", disabled: gap, onclick: op("right") }, "▶"),
  ];
  kids.push(h("button", { type: "button", class: "pop rm", onclick: op("remove") }, "Remove"));
  return h("span", { class: "pmenu", role: "group", "aria-label": "Change this pause",
    onkeydown: (e) => { if (e.key === "Escape") actions.openMark(id, m.key); } }, kids);
}

// The field key is shared with the prompter bar's copy of the box, so text typed in either survives a re-render.
function noteBox(l, actions, prefix = "pace") {
  const key = `pace-${l.id}-note`;
  const ta = h("textarea", { id: `${prefix}-${l.id}-note`, class: "pnote", rows: 1, placeholder: "Note", "aria-label": `Note for ${l.id}` });
  ta.value = actions.field?.(key) ?? l.note;
  ta.addEventListener("input", () => actions.setField(key, ta.value));
  ta.addEventListener("blur", () => {
    if (actions.rendering?.()) return; // replaced by a re-render, not left by Jon
    const v = ta.value;
    if (v === l.note) { actions.setField(key, undefined); return; }
    actions.setField(key, v);
    Promise.resolve(actions.saveNote(l.id, v)).then((ok) => { if (ok === true && actions.field(key) === v) actions.setField(key, undefined); });
  });
  return ta;
}

// prefix: element ids (the prompter bar shows the same line with "pace-bar").
export function lineEl(l, actions, { prefix = "pace" } = {}) {
  const text = [];
  if (l.words.length) {
    for (const w of l.words) {
      text.push(h("button", { type: "button", class: "pword", title: l.newTake ? COPY.newTake : w.i == null ? "Nothing heard before this word yet" : "Add a pause after this word", disabled: l.newTake || w.i == null,
        onclick: () => actions.markWord(l.id, w.i) }, w.word));
      if (w.mark) {
        text.push(markButton(l.id, w.mark, `Pause after “${w.word}”`, actions));
        if (w.mark.open) text.push(markMenu(l.id, w.mark, actions, { first: w.first }));
      }
    }
  } else text.push(h("span", { class: "psilent", text: l.text }));
  for (const m of l.lost) {
    text.push(markButton(l.id, m, "Pause on a word not in this take", actions));
    if (m.open) text.push(markMenu(l.id, m, actions, { lost: true }));
  }
  if (l.gap) {
    text.push(markButton(l.id, l.gap, `Pause after line ${l.id}`, actions, { gap: true }));
    if (l.gap.open) text.push(markMenu(l.id, l.gap, actions, { first: !l.words.length, gap: true }));
  } else text.push(h("button", { type: "button", class: "pgap", title: "Add a pause after this line", "aria-label": `Add a pause after line ${l.id}`, onclick: () => actions.markGap(l.id) }, "＋"));

  const notes = [];
  const seen = new Set();
  for (const m of [...l.words.map((w) => w.mark), ...l.lost, l.gap].filter((m) => m?.text)) {
    if (seen.has(m.text)) continue;
    seen.add(m.text);
    notes.push(h("p", { class: `pwarn${m.tight ? " tight" : ""}`, text: m.text }));
  }
  const cb = h("input", { type: "checkbox", id: `${prefix}-${l.id}-rr` });
  cb.checked = l.rerecord;
  cb.addEventListener("change", () => actions.setRerecord(l.id, cb.checked));
  const attrs = { class: `pline${l.rerecord ? " rr" : ""}` };
  if (l.start != null) { attrs["data-start"] = String(l.start); attrs["data-end"] = String(l.end ?? l.start); }
  return h("li", attrs,
    h("button", { type: "button", class: "pid", title: "Play from this line", disabled: l.start == null, onclick: () => actions.seekReview(l.start) }, l.id),
    h("div", { class: "ptext" }, text),
    h("div", { class: "pside" }, noteBox(l, actions, prefix), h("label", { class: "prr", for: `${prefix}-${l.id}-rr` }, cb, h("span", { text: "Re-record" }))),
    notes.length || l.reply ? h("div", { class: "pinfo" }, notes, l.reply ? h("p", { class: "preply", text: l.reply }) : null) : null);
}

export function pacingSection(m, actions) {
  if (!m) return null;
  return h("div", { class: "pacing", role: "region", "aria-label": "Line by line review" },
    m.player ? h("div", { class: "mplayer" }, actions.reviewPlayer?.(m.player.file, m.player.key, "the voiceover")) : null,
    m.status ? h("p", { class: "hist", text: m.status }) : null,
    h("ul", { class: "pace" }, m.lines.map((l) => lineEl(l, actions))),
    h("div", { class: "row pfoot" },
      h("span", { class: "pcounts", text: m.counts }),
      btn(m.place.label, () => actions.placePauses(), { ghost: true, disabled: !m.place.enabled }),
      btn(m.apply.label, () => actions.applyPauses(), { disabled: !m.apply.enabled })),
    m.running ? h("p", { class: "mstatus hist" }, h("span", { class: "dot live" }), m.running) : null,
    !m.running && m.apply.why ? h("p", { class: "hist", text: m.apply.why }) : null,
    m.info ? h("p", { class: "hist", text: m.info }) : null,
    m.error ? h("p", { class: "err", text: m.error }) : null);
}

// Scrolls the list (only the list, never the page) so the line is inside it.
function scrollInList(list, li) {
  const a = list.getBoundingClientRect?.(), b = li.getBoundingClientRect?.();
  if (!a || !b) return;
  if (b.top < a.top) list.scrollTop -= a.top - b.top;
  else if (b.bottom > a.bottom) list.scrollTop += Math.min(b.bottom - a.bottom, b.top - a.top);
}

// Lights the line whose [start, end) holds the player's time, scrolling the list when the line changes.
// A freshly painted list is lit at once without scrolling. Returns a function that stops following.
export function followPlayer(el, list) {
  let cur = null;
  const sync = (scroll = true) => {
    const t = Number(el.currentTime) || 0;
    let hit = null;
    for (const li of list.children ?? []) {
      const s = li.getAttribute?.("data-start");
      if (s == null) continue;
      if (t >= Number(s) && t < Number(li.getAttribute("data-end"))) { hit = li; break; }
    }
    if (hit === cur) return;
    if (cur) { cur.classList.remove("now"); cur.removeAttribute?.("aria-current"); }
    cur = hit;
    if (hit) {
      hit.classList.add("now");
      hit.setAttribute("aria-current", "true");
      if (scroll) scrollInList(list, hit);
    }
  };
  const onTime = () => sync(true);
  el.addEventListener("timeupdate", onTime);
  el.addEventListener("seeked", onTime);
  if (!el.paused || Number(el.currentTime) > 0) sync(false);
  return () => { el.removeEventListener("timeupdate", onTime); el.removeEventListener("seeked", onTime); };
}
