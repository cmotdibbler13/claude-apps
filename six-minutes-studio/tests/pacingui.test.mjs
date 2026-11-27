import { test } from "node:test";
import assert from "node:assert/strict";
import { pacingModel, countsText } from "../js/ui/pacing.js";
import { mixModel } from "../js/ui/mix.js";
import { marksSig, takeSig } from "../js/pacing.js";

// A stub DOM with just enough for h(), classList, getAttribute and a timeupdate listener.
function withDom(fn) {
  const mk = (tag) => {
    const el = { tag, attrs: {}, children: [], listeners: {}, style: {}, className: "",
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
      removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(k, f) { (this.listeners[k] ||= []).push(f); },
      removeEventListener(k, f) { this.listeners[k] = (this.listeners[k] || []).filter((g) => g !== f); },
      append(...k) { this.children.push(...k); },
      scrolled: 0, scrollIntoView() { this.scrolled++; }, scrollTop: 0, rect: { top: 0, bottom: 0 }, getBoundingClientRect() { return this.rect; } };
    Object.setPrototypeOf(el, globalThis.Node.prototype);
    el.classList = {
      add: (c) => { const s = new Set(el.className.split(" ").filter(Boolean)); s.add(c); el.className = [...s].join(" "); },
      remove: (c) => { el.className = el.className.split(" ").filter((x) => x && x !== c).join(" "); },
      contains: (c) => el.className.split(" ").includes(c),
    };
    return el;
  };
  globalThis.Node = class {};
  globalThis.document = { createElement: mk, createTextNode: (t) => ({ t }) };
  return Promise.resolve().then(fn).finally(() => { delete globalThis.document; delete globalThis.Node; });
}
const all = (el, pred, out = []) => {
  if (!el || typeof el !== "object") return out;
  if (pred(el)) out.push(el);
  for (const c of el.children ?? []) all(c, pred, out);
  return out;
};
const textOf = (el) => (el.textContent ?? "") + (el.children ?? []).map((c) => (c.t ?? textOf(c))).join("");
const hasClass = (el, c) => String(el.className ?? "").split(" ").includes(c);
const fire = (el, k, ev = {}) => { for (const f of el.listeners?.[k] ?? []) f(ev); };

const W = (sentence, word, start, end) => ({ sentence, word, start, end });
const TRANSCRIPT = {
  sentences: [{ sentence: "01.1", start: 0, end: 3 }, { sentence: "01.2", start: 3.5, end: 6 }, { sentence: "01.3", start: 6.5, end: 8 }],
  words: [
    W("01.1", "Pictish", 0.0, 0.4), W("01.1", "village", 0.45, 0.8), W("01.1", "in", 0.85, 0.95), W("01.1", "Orkney.", 1.0, 1.5),
    W("01.1", "Pictish", 1.6, 2.0), W("01.1", "he", 2.05, 2.2), W("01.1", "was", 2.25, 2.4), W("01.1", "out.", 2.45, 3.0),
    W("01.2", "Nobody", 3.5, 3.9), W("01.2", "knows", 3.95, 4.3), W("01.2", "how", 4.35, 4.5), W("01.2", "long.", 4.55, 6.0),
  ],
};
const LINES = { lines: [
  { id: "01.1", text: "Pictish village in Orkney. Pictish he was out." },
  { id: "01.2", text: "Nobody knows how long." },
  { id: "01.3", text: "And the sea took the rest." },
] };
const row = (id, takeS = 100) => ({ id, text: "", status: "ok", flags: [], notes: [], file: `C:\\rec\\film_${id}.wav`, takeS });
const NARR = { rows: [row("01.1"), row("01.2"), row("01.3")], counts: { total: 3, recorded: 3, ok: 3 } };
const SIG = (id) => takeSig(row(id));

function film({ pacing = { lines: {} }, mix = null, vo = {} } = {}) {
  return { assets: [], audio: {}, mix: {
    voiceover: { id: "VOICEOVER", status: "done", at: 500000, wav: "C:\\f\\vo.wav", transcript: "C:\\f\\t.json", takes: [], ...vo },
    ...(mix ? { mix } : {}),
    pacing,
  } };
}
const model = (state, extra = {}) => pacingModel({ state, transcript: TRANSCRIPT, narration: NARR, lineScript: LINES,
  sig: marksSig(state.mix.pacing, {}), chain: {}, canApply: { ok: true, why: null }, ...extra });

test("the model highlights nothing at rest and lists every script line with its times", () => withDom(async () => {
  const { pacingSection } = await import("../js/ui/pacing.js");
  const m = model(film());
  assert.deepEqual(m.lines.map((l) => [l.id, l.start, l.end]), [["01.1", 0, 3], ["01.2", 3.5, 6], ["01.3", 6.5, 8]]);
  assert.equal(m.lines[0].text, "Pictish village in Orkney. Pictish he was out.");
  assert.ok(m.lines.every((l) => !("now" in l)));
  const el = pacingSection(m, {});
  const lis = all(el, (e) => e.tag === "li");
  assert.equal(lis.length, 3);
  assert.ok(lis.every((li) => !hasClass(li, "now")));
  assert.equal(lis[1].attrs["data-start"], "3.5");
  assert.equal(lis[1].attrs["data-end"], "6");
}));

test("a mark renders as ‖ right after the word it follows", () => withDom(async () => {
  const { pacingSection } = await import("../js/ui/pacing.js");
  const pacing = { lines: { "01.1": { pauses: [{ key: "pictish#2", word: "Pictish", nth: 2, size: "medium", by: "jon", take: SIG("01.1") }] } } };
  const m = model(film({ pacing }));
  assert.equal(m.lines[0].words[4].mark.size, "medium");
  assert.equal(m.lines[0].words[0].mark, null);
  const el = pacingSection(m, {});
  const li = all(el, (e) => e.tag === "li")[0];
  const seq = all(li, (e) => hasClass(e, "pword") || hasClass(e, "pmark")).map((e) => (hasClass(e, "pmark") ? "‖" : textOf(e)));
  assert.deepEqual(seq, ["Pictish", "village", "in", "Orkney.", "Pictish", "‖", "he", "was", "out."]);
}));

test("a silent line shows its script text, no word buttons, and the ＋ for the gap after it", () => withDom(async () => {
  const { pacingSection } = await import("../js/ui/pacing.js");
  const m = model(film());
  assert.deepEqual(m.lines[2].words, []);
  assert.equal(m.lines[2].start, 6.5);
  const li = all(pacingSection(m, {}), (e) => e.tag === "li")[2];
  assert.equal(all(li, (e) => hasClass(e, "pword")).length, 0);
  assert.ok(textOf(li).includes("And the sea took the rest."));
  assert.equal(all(li, (e) => hasClass(e, "pgap")).length, 1);
}));

test("the review plays the mix when it is current, else the voiceover with a note", () => {
  const cur = model(film({ mix: { id: "MIX", status: "done", fromVoiceoverAt: 500000, files: { mp3: "m.mp3" } } }));
  assert.equal(cur.source, "mix");
  assert.equal(cur.status, null);
  const old = model(film({ mix: { id: "MIX", status: "done", fromVoiceoverAt: 400000, files: { mp3: "m.mp3" } } }));
  assert.equal(old.source, "voiceover");
  assert.equal(old.status, "Playing the voiceover: the mix is older than it.");
  assert.deepEqual(old.player, { file: "C:\\f\\vo.wav", key: "C:\\f\\vo.wav#500000" });
  const none = model(film());
  assert.equal(none.source, "voiceover");
  assert.equal(none.status, null);
});

test("while Apply pauses runs, Apply and Place are disabled and say why", () => {
  const pacing = { lines: { "01.1": { note: "pause after the second Pictish", noteAt: 10, placedAt: 0, pauses: [] } } };
  const idle = model(film({ pacing }));
  assert.equal(idle.apply.label, "Apply pauses");
  assert.equal(idle.apply.enabled, true);
  assert.equal(idle.place.label, "Place pauses");
  assert.equal(idle.place.enabled, true);
  const busy = model(film({ pacing }), { chain: { applying: { step: "FIT" } }, canApply: { ok: false, why: "Applying pauses is already running." } });
  assert.equal(busy.apply.enabled, false);
  assert.equal(busy.apply.why, "Applying pauses is already running.");
  assert.equal(busy.place.enabled, false);
  assert.equal(busy.running, "Applying pauses: fitting the score…");
  const placing = model(film({ pacing }), { chain: { placing: true } });
  assert.equal(placing.place.label, "Placing…");
  assert.equal(placing.place.enabled, false);
  const refused = model(film({ pacing }), { canApply: { ok: false, why: "The mix is running." } });
  assert.equal(refused.apply.enabled, false);
  assert.equal(refused.apply.why, "The mix is running.");
  // Nothing new to place: Place is off.
  assert.equal(model(film()).place.enabled, false);
});

test("counts line text is exact", () => {
  const pacing = { lines: {
    "01.1": { pauses: [{ key: "pictish#2", word: "Pictish", nth: 2, size: "medium", by: "jon" }, { key: "end", word: null, nth: null, size: "long", by: "jon" }], rerecord: { at: 5 } },
    "01.2": { pauses: [{ key: "knows#1", word: "knows", nth: 1, size: "short", by: "claude" }] },
  } };
  assert.equal(model(film({ pacing })).counts, "3 pauses marked · 1 line to re-record");
  assert.equal(countsText(0, 0), "No pauses marked");
  assert.equal(countsText(1, 0), "1 pause marked");
  assert.equal(countsText(2, 2), "2 pauses marked · 2 lines to re-record");
});

test("tight, take-changed and not-found marks carry their copy", () => {
  // Joined with a 0.6 s pause after "Orkney." inside 01.1; the new transcript has the gap in it.
  const t2 = JSON.parse(JSON.stringify(TRANSCRIPT));
  for (const w of t2.words.filter((x) => x.sentence === "01.1" && x.start >= 1.6)) { w.start += 0.6; w.end += 0.6; }
  const at = (1.5 + 1.6) / 2; // the at_s sent for the mark
  const pacing = { lines: {
    "01.1": { pauses: [
      { key: "orkney#1", word: "Orkney.", nth: 1, size: "medium", by: "jon", take: SIG("01.1") },
      { key: "gone#1", word: "gone", nth: 1, size: "short", by: "claude", take: SIG("01.1") },
    ] },
    "01.2": { pauses: [{ key: "nobody#1", word: "Nobody", nth: 1, size: "medium", by: "jon", take: "old.wav|1" }] },
  } };
  const state = film({ pacing, vo: { pausesApplied: { "01.1": [{ at_s: at, add_s: 0.6 }] }, tight: [{ id: "01.1", at_s: at + 0.1 }] } });
  const m = pacingModel({ state, transcript: t2, narration: NARR, lineScript: LINES, sig: "x", chain: {}, canApply: { ok: true } });
  const ork = m.lines[0].words[3].mark;
  assert.equal(ork.tight, true);
  assert.equal(ork.text, "Tight cut: have a listen");
  assert.deepEqual(m.lines[0].lost.map((x) => [x.key, x.text]), [["gone#1", "Couldn't find this word. Place again"]]);
  const nob = m.lines[1].words[0].mark;
  assert.equal(nob.state, "take-changed");
  assert.equal(nob.text, "The take changed. Place again");
  assert.equal(m.lines[1].takeChanged, true);
  // A tight entry for another place does not count.
  const far = film({ pacing, vo: { pausesApplied: { "01.1": [{ at_s: at, add_s: 0.6 }] }, tight: [{ id: "01.1", at_s: at + 0.5 }] } });
  assert.equal(pacingModel({ state: far, transcript: t2, narration: NARR, lineScript: LINES, sig: "x" }).lines[0].words[3].mark.tight, false);
});

test("words, ids, the ＋, the ‖ menu, the note and Re-record call their actions", () => withDom(async () => {
  const { pacingSection } = await import("../js/ui/pacing.js");
  const calls = [];
  const fields = new Map();
  const actions = {
    seekReview: (t) => calls.push(["seek", t]), markWord: (id, i) => calls.push(["word", id, i]), markGap: (id) => calls.push(["gap", id]),
    openMark: (id, key) => calls.push(["open", id, key]), editMark: (id, key, op) => calls.push(["edit", id, key, op]),
    saveNote: (id, text) => { calls.push(["note", id, text]); return Promise.resolve(true); }, setRerecord: (id, on) => calls.push(["rr", id, on]),
    placePauses: () => calls.push(["place"]), applyPauses: () => calls.push(["apply"]),
    field: (k) => fields.get(k), setField: (k, v) => (v === undefined ? fields.delete(k) : fields.set(k, v)), rendering: () => false,
  };
  const pacing = { lines: { "01.1": { note: "", pauses: [{ key: "pictish#2", word: "Pictish", nth: 2, size: "medium", by: "jon", take: SIG("01.1") }] } } };
  const m = model(film({ pacing }), { menu: { id: "01.1", key: "pictish#2" } });
  const el = pacingSection(m, actions);
  const li = all(el, (e) => e.tag === "li")[0];
  fire(all(li, (e) => hasClass(e, "pid"))[0], "click");
  fire(all(li, (e) => hasClass(e, "pword"))[1], "click");
  fire(all(li, (e) => hasClass(e, "pgap"))[0], "click");
  fire(all(li, (e) => hasClass(e, "pmark"))[0], "click");
  const menu = all(li, (e) => hasClass(e, "pmenu"))[0];
  assert.deepEqual(all(menu, (e) => e.tag === "button").map(textOf), ["Short", "Medium", "Long", "◀", "▶", "Remove"]);
  for (const b of all(menu, (e) => e.tag === "button")) fire(b, "click");
  const ta = all(li, (e) => e.tag === "textarea")[0];
  ta.value = "pause after the second Pictish";
  fire(ta, "input");
  fire(ta, "blur");
  const cb = all(li, (e) => e.tag === "input" && e.attrs.type === "checkbox")[0];
  assert.ok(textOf(all(li, (e) => e.tag === "label").find((l) => l.children.includes(cb))).includes("Re-record"));
  cb.checked = true;
  fire(cb, "change");
  for (const b of all(el, (e) => hasClass(e, "btn"))) fire(b, "click");
  assert.deepEqual(calls, [
    ["seek", 0], ["word", "01.1", 1], ["gap", "01.1"], ["open", "01.1", "pictish#2"],
    ["edit", "01.1", "pictish#2", "short"], ["edit", "01.1", "pictish#2", "medium"], ["edit", "01.1", "pictish#2", "long"],
    ["edit", "01.1", "pictish#2", "left"], ["edit", "01.1", "pictish#2", "right"], ["edit", "01.1", "pictish#2", "remove"],
    ["note", "01.1", "pause after the second Pictish"], ["rr", "01.1", true], ["place"], ["apply"],
  ]);
  // A re-render keeps what Jon typed and not yet saved.
  fields.set("pace-01.2-note", "half typed");
  const again = pacingSection(m, actions);
  assert.equal(all(all(again, (e) => e.tag === "li")[1], (e) => e.tag === "textarea")[0].value, "half typed");
}));

test("followPlayer moves .now with playback and scrolls only when the line changes", () => withDom(async () => {
  const { pacingSection, followPlayer } = await import("../js/ui/pacing.js");
  const el = pacingSection(model(film()), {});
  const list = all(el, (e) => e.tag === "ul" && hasClass(e, "pace"))[0];
  const lis = all(list, (e) => e.tag === "li");
  const audio = document.createElement("audio");
  audio.currentTime = 0; audio.paused = true;
  // The list shows 0..100 px; line 01.2 sits below it (120..160), 01.1 above it after scrolling.
  list.rect = { top: 0, bottom: 100 };
  lis[0].rect = { top: 10, bottom: 50 }; lis[1].rect = { top: 120, bottom: 160 }; lis[2].rect = { top: 170, bottom: 210 };
  const off = followPlayer(audio, list);
  assert.ok(lis.every((li) => !hasClass(li, "now")));
  audio.currentTime = 1; fire(audio, "timeupdate");
  assert.ok(hasClass(lis[0], "now"));
  assert.equal(list.scrollTop, 0); // already in view
  audio.currentTime = 2; fire(audio, "timeupdate");
  audio.currentTime = 4; fire(audio, "timeupdate");
  assert.ok(!hasClass(lis[0], "now"));
  assert.ok(hasClass(lis[1], "now"));
  assert.equal(list.scrollTop, 60); // only the list scrolled, by the overflow
  lis[0].rect = { top: -30, bottom: 10 };
  audio.currentTime = 1; fire(audio, "timeupdate");
  assert.equal(list.scrollTop, 30);
  audio.currentTime = 4; fire(audio, "timeupdate");
  assert.ok(lis.every((li) => li.scrolled === 0)); // never scrollIntoView: the page stays where Jon left it
  audio.currentTime = 3.2; fire(audio, "timeupdate"); // between lines: nothing lit
  assert.ok(lis.every((li) => !hasClass(li, "now")));
  off();
  audio.currentTime = 7; fire(audio, "timeupdate");
  assert.ok(!hasClass(lis[2], "now"));
}));

test("marks changed since the join show on the Join step, without locking Fit or Mix", () => {
  const pacing = { lines: { "01.1": { pauses: [{ key: "pictish#2", word: "Pictish", nth: 2, size: "medium", by: "jon", take: SIG("01.1") }] } } };
  const state = film({ pacing, vo: { pausesSig: marksSig({ lines: {} }, {}), lengthS: 8 } });
  state.audio = { score: { approved: true, chosen: 1, takes: [{ n: 1, status: "done", file: "s.wav" }] } };
  state.mix.fit = { id: "FIT", status: "done", at: 60, fromVoiceoverAt: 500000, fromScoreTake: 1, file: "fit.wav", source: "app", takes: [] };
  const steps = mixModel({ state, narration: NARR, settings: { stemRemixer: true }, pacingUi: { transcript: TRANSCRIPT, lineScript: LINES } }).steps;
  const [join, fit, mix] = steps;
  assert.equal(join.state, "stale");
  assert.equal(join.statusText, "Pause marks changed: press Apply pauses.");
  assert.equal(fit.state, "done");
  assert.equal(mix.state, "ready");
  assert.equal(mix.lock, null);
  // Applied: the join's marks match.
  state.mix.voiceover.pausesSig = marksSig(pacing, { "01.1": SIG("01.1"), "01.2": SIG("01.2"), "01.3": SIG("01.3") });
  assert.equal(mixModel({ state, narration: NARR, settings: { stemRemixer: true } }).steps[0].state, "done");
});

test("the review renders inside the Mix step even while it waits for the fit", () => withDom(async () => {
  const { mixSection } = await import("../js/ui/mix.js");
  const m = mixModel({ state: film(), narration: NARR, pacingUi: { transcript: TRANSCRIPT, lineScript: LINES } });
  const mixStep = m.steps[2];
  assert.equal(mixStep.state, "locked");
  assert.ok(m.pacing);
  const el = mixSection(m, { audioPlayer: () => document.createElement("audio"), reviewPlayer: () => document.createElement("audio"), field: () => undefined });
  const stepEls = all(el, (e) => e.tag === "li" && hasClass(e, "mstep"));
  assert.equal(all(stepEls[2], (e) => e.tag === "ul" && hasClass(e, "pace")).length, 1);
  // No voiceover yet: no review.
  const none = mixModel({ state: { assets: [], mix: {} }, narration: NARR });
  assert.equal(none.pacing, null);
}));

test("while the voiceover is joined again the list stays, without a player", () => {
  const running = film({ vo: { status: "running", wav: null, at: null } });
  const m = model(running);
  assert.equal(m.lines.length, 3);
  assert.equal(m.player, null);
  assert.equal(m.status, null);
  assert.equal(pacingModel({ state: running, transcript: null, lineScript: LINES }), null);
  assert.equal(pacingModel({ state: { mix: {} }, transcript: TRANSCRIPT, lineScript: LINES }), null);
});

test("a freshly painted list gets the highlight at once but is not scrolled", () => withDom(async () => {
  const { pacingSection, followPlayer } = await import("../js/ui/pacing.js");
  const list = all(pacingSection(model(film()), {}), (e) => e.tag === "ul" && hasClass(e, "pace"))[0];
  const lis = all(list, (e) => e.tag === "li");
  list.rect = { top: 0, bottom: 100 };
  lis[1].rect = { top: 120, bottom: 160 };
  const audio = document.createElement("audio");
  audio.currentTime = 4; audio.paused = false;
  followPlayer(audio, list);
  assert.ok(hasClass(lis[1], "now"));
  assert.equal(list.scrollTop, 0);
  assert.ok(lis.every((li) => li.scrolled === 0));
}));
