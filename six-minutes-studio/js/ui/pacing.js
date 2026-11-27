// Pacing review under the Mix preview player: the script's lines with their words, ‖ pause marks, a note box
// and a Re-record tick per line, Place pauses and Apply pauses. pacingModel is pure; pacingSection builds the DOM;
// followPlayer lights the line being spoken without a re-render.
import { h, btn, playerKey } from "./dom.js";
import { lineWords, takeSig, markState, norm, toUnpaused, notesToPlace } from "../pacing.js";

const SIZES = [["short", "Short"], ["medium", "Medium"], ["long", "Long"]];
const SIZE_LABEL = Object.fromEntries(SIZES);
const STEP = { VOICEOVER: "joining the voiceover…", FIT: "fitting the score…", MIX: "making the mix…" };
const TIGHT_S = 0.2;
export const COPY = {
  tight: "Tight cut: have a listen",
  "take-changed": "The take changed. Place again",
  "not-found": "Couldn't find this word. Place again",
  older: "Playing the voiceover: the mix is older than it.",
};

const keyOf = (word, nth) => `${norm(word)}#${nth}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function countsText(marks, rerecords) {
  const head = marks ? `${plural(marks, "pause", "pauses")} marked` : "No pauses marked";
  return rerecords ? `${head} · ${plural(rerecords, "line", "lines")} to re-record` : head;
}

// Script words as Jon wrote them, when they line up one for one with the transcript's words.
function labels(text, words) {
  const toks = String(text ?? "").split(/\s+/).filter(Boolean);
  if (toks.length !== words.length) return words.map((w) => w.word);
  return toks.every((t, i) => norm(t) === norm(words[i].word)) ? toks : words.map((w) => w.word);
}

// Tight: the join reported the quietest spot near the at_s sent for this mark was still loud.
function isTight(vo, id, mark, words, sentence) {
  if (mark.key === "end") return false;
  const w = words.find((x) => norm(x.word) === norm(mark.word) && x.nth === mark.nth);
  const next = w ? words[w.i + 1] : null;
  if (!next) return false;
  const applied = vo?.pausesApplied?.[id] ?? [];
  const at = toUnpaused((w.end + next.start) / 2 - (sentence?.start ?? 0), applied);
  const sent = applied.find((a) => Math.abs(a.at_s - at) <= TIGHT_S);
  if (!sent) return false;
  return (vo?.tight ?? []).some((t) => t.id === id && Math.abs(Number(t.at_s) - sent.at_s) <= TIGHT_S);
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
  const applied = vo.pausesSig != null && vo.pausesSig === sig;
  const script = lineScript?.lines?.length ? lineScript.lines
    : (transcript?.sentences ?? []).map((s) => ({ id: s.sentence, text: s.text ?? "" }));
  let marks = 0, rerecords = 0;
  const lines = script.map((sl) => {
    const id = sl.id;
    const line = pacing.lines?.[id] ?? {};
    const sentence = (transcript?.sentences ?? []).find((s) => s.sentence === id) ?? null;
    const words = lineWords(transcript, id);
    const markOf = (m) => {
      const own = m.take ?? line.take ?? null;
      const st = markState(m, words, line, id in sigs ? sigs[id] : own);
      const tight = st === "ok" && isTight(vo, id, m, words, sentence);
      if (st === "ok") marks++;
      return { key: m.key, size: m.size, by: m.by ?? null, state: st, tight, applied: applied && st === "ok",
        text: tight ? COPY.tight : COPY[st] ?? null, open: !!menu && menu.id === id && menu.key === m.key };
    };
    const pauses = line.pauses ?? [];
    const byKey = new Map(pauses.map((m) => [m.key, m]));
    const shown = labels(sl.text, words);
    const ws = words.map((w, i) => {
      const key = keyOf(w.word, w.nth);
      const m = byKey.get(key);
      return { i, word: shown[i], key, mark: m ? markOf(m) : null, first: i === 0, last: i === words.length - 1 };
    });
    const wordKeys = new Set(ws.map((w) => w.key));
    const end = byKey.get("end");
    const lost = pauses.filter((m) => m.key !== "end" && !wordKeys.has(m.key)).map(markOf);
    if (line.rerecord) rerecords++;
    const gap = end ? markOf(end) : null;
    return {
      id, start: sentence?.start ?? null, end: sentence?.end ?? null, text: sl.text ?? "",
      words: ws, gap, lost, note: line.note ?? "", reply: line.reply ?? null, rerecord: !!line.rerecord,
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

function noteBox(l, actions) {
  const key = `pace-${l.id}-note`;
  const ta = h("textarea", { id: key, class: "pnote", rows: 1, placeholder: "Note", "aria-label": `Note for ${l.id}` });
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

function lineEl(l, actions) {
  const text = [];
  if (l.words.length) {
    for (const w of l.words) {
      text.push(h("button", { type: "button", class: "pword", title: "Add a pause after this word", onclick: () => actions.markWord(l.id, w.i) }, w.word));
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
  const cb = h("input", { type: "checkbox", id: `pace-${l.id}-rr` });
  cb.checked = l.rerecord;
  cb.addEventListener("change", () => actions.setRerecord(l.id, cb.checked));
  const attrs = { class: `pline${l.rerecord ? " rr" : ""}` };
  if (l.start != null) { attrs["data-start"] = String(l.start); attrs["data-end"] = String(l.end ?? l.start); }
  return h("li", attrs,
    h("button", { type: "button", class: "pid", title: "Play from this line", disabled: l.start == null, onclick: () => actions.seekReview(l.start) }, l.id),
    h("div", { class: "ptext" }, text),
    h("div", { class: "pside" }, noteBox(l, actions), h("label", { class: "prr", for: `pace-${l.id}-rr` }, cb, h("span", { text: "Re-record" }))),
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

// Lights the line whose [start, end) holds the player's time. Returns a function that stops following.
export function followPlayer(el, list) {
  let cur = null;
  const sync = () => {
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
      hit.scrollIntoView?.({ block: "nearest" });
    }
  };
  el.addEventListener("timeupdate", sync);
  el.addEventListener("seeked", sync);
  if (!el.paused || Number(el.currentTime) > 0) sync();
  return () => { el.removeEventListener("timeupdate", sync); el.removeEventListener("seeked", sync); };
}
