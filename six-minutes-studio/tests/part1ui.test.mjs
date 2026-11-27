import { test } from "node:test";
import assert from "node:assert/strict";
import { newFilmModel, createInput, briefPickProblem, NEW_FOLDER, DEFAULT_RUNTIME, CREATING } from "../js/ui/newfilm.js";
import { part1Model, listRows, listFromRows, nextStepText, WRITING, NO_DRAFT, WAIT, NO_EPISODE } from "../js/ui/part1.js";
import { reviewModel } from "../js/ui/review.js";
import { scriptStats, mmss } from "../js/part1script.js";

const ROOT = "S:\\Youtube video ideas";
const REC = "C:\\Users\\Jon\\desktop autocue\\Recordings";
const folders = [{ name: "Coal Tar", dir: `${ROOT}\\Coal Tar` }, { name: "Storms", dir: `${ROOT}\\Storms` }];
const briefs = [{ name: "new.md", path: `${ROOT}\\Coal Tar\\new.md` }, { name: "old.txt", path: `${ROOT}\\Coal Tar\\old.txt` }];
const films = [{ number: "007" }, { number: null }, { number: "003" }];

// ---------- New film ----------

test("new film: the first folder, its newest brief, and the suggestions filled in", () => {
  const m = newFilmModel({ folders, briefs, form: {}, taken: [], films, recordings: REC });
  assert.equal(m.folder, `${ROOT}\\Coal Tar`);
  assert.equal(m.folders.at(-1).value, NEW_FOLDER);
  assert.equal(m.brief, briefs[0].path);
  assert.equal(m.topic, "Coal Tar");
  assert.equal(m.prefix, "coal_tar");
  assert.equal(m.episode, "008");
  assert.equal(m.runtime, DEFAULT_RUNTIME);
  assert.equal(m.prefixProblem, null);
  assert.equal(m.canCreate, true);
});

test("new film: the recordings example path", () => {
  const m = newFilmModel({ folders, briefs, form: {}, films, recordings: REC });
  assert.equal(m.recordingsPath, `${REC}\\coal_tar\\coal_tar_<NN.s>.wav`);
  const unset = newFilmModel({ folders, briefs, form: {}, films });
  assert.equal(unset.recordingsPath, "<autocueRecordings>\\coal_tar\\coal_tar_<NN.s>.wav");
});

test("new film: the prefix follows the topic until Jon types one; a taken or bad prefix is said", () => {
  assert.equal(newFilmModel({ folders, briefs, form: { topic: "The Big Storm!" } }).prefix, "the_big_storm");
  assert.equal(newFilmModel({ folders, briefs, form: { topic: "x", prefix: "mine" } }).prefix, "mine");
  const taken = newFilmModel({ folders, briefs, form: {}, taken: ["coal_tar"] });
  assert.equal(taken.prefixProblem, "Another film already uses coal_tar.");
  assert.equal(taken.canCreate, false);
  const bad = newFilmModel({ folders, briefs, form: { prefix: "Coal Tar" } });
  assert.equal(bad.prefixProblem, "Use lower-case letters, digits and _ only.");
  const empty = newFilmModel({ folders, briefs, form: { prefix: "" } });
  assert.equal(empty.prefix, "");
  assert.equal(empty.canCreate, false);
});

test("new film: no films with episodes gives 001; Jon's episode is kept", () => {
  assert.equal(newFilmModel({ folders, briefs }).episode, "001");
  assert.equal(newFilmModel({ folders, briefs, films, form: { episode: "012" } }).episode, "012");
});

test("new film: voice is own voice, cloned voice shown but not offered", () => {
  const m = newFilmModel({ folders, briefs });
  assert.deepEqual(m.voices.map((v) => [v.label, v.selected, v.disabled]), [["Own voice", true, false], ["Cloned voice (coming later)", false, true]]);
});

test("new film: a new folder takes its name as the topic and waits for a brief", () => {
  const m = newFilmModel({ folders, briefs: [], form: { folder: NEW_FOLDER, newFolder: "Bells" }, films });
  assert.equal(m.isNew, true);
  assert.equal(m.topic, "Bells");
  assert.equal(m.prefix, "bells");
  assert.equal(m.noBriefs, "Add the brief for the new folder.");
  assert.equal(m.canCreate, false);
  const withPick = newFilmModel({ folders, briefs: [], form: { folder: NEW_FOLDER, newFolder: "Bells" }, films, pending: { name: "bells.md" } });
  assert.equal(withPick.canCreate, true);
  assert.match(withPick.briefs[0].label, /^bells\.md/);
  assert.deepEqual(createInput(withPick), { brief: withPick.brief, topic: "Bells", prefix: "bells", episode: "008", runtime: DEFAULT_RUNTIME, newFolder: "Bells" });
});

test("new film: createInput for an existing folder; busy and the error show", () => {
  const m = newFilmModel({ folders, briefs, form: { brief: briefs[1].path }, films });
  assert.deepEqual(createInput(m), { brief: briefs[1].path, topic: "Coal Tar", prefix: "coal_tar", episode: "008", runtime: DEFAULT_RUNTIME, folder: `${ROOT}\\Coal Tar` });
  const busy = newFilmModel({ folders, briefs, busy: true, error: "A folder called X is already there." });
  assert.equal(busy.createLabel, CREATING);
  assert.equal(busy.canCreate, false);
  assert.equal(busy.error, "A folder called X is already there.");
  assert.equal(newFilmModel({ folders: null }).loading, true);
});

test("new film: a PDF or other file gets the save-as-text message", () => {
  assert.equal(briefPickProblem("brief.pdf"), "Save the brief as Markdown or text in the film's folder first.");
  assert.equal(briefPickProblem("brief.docx"), "Save the brief as Markdown or text in the film's folder first.");
  assert.equal(briefPickProblem("brief.MD"), null);
  assert.equal(briefPickProblem("brief.txt"), null);
});

// ---------- Part 1 step ----------

const words = (n, w = "word") => Array.from({ length: n }, () => w).join(" ");
const clip = (text, o = {}) => ({ narration: text, spoken: text, cue: "Line art.", delivery: null, pronunciations: [], ...o });
const script = () => ({
  title: "Coal Tar", buildLine: "Remotion.", key: { graphics: [], extra: null },
  sections: [
    { name: "Cold open", clips: [clip(`${words(6)}. ${words(5, "More")}.`, { delivery: "slowly", cue: "Wide shot, HF-01" }), clip(words(54))] },
    { name: "The works", clips: [clip(words(10))] },
  ],
  pronunciations: [{ name: "St Austell", say: "Saint Ostul" }],
  shots: [{ id: "HF-01", usedIn: [1], prompt: "Hill at dusk" }],
  sfx: [{ cue: "Wind", clip: 1, idea: "low wind" }],
  music: "Slow strings.", archive: [],
  notes: { corrections: ["Date fixed."], myths: [], softer: [], conflicts: [], timeSensitive: [], leftOut: [], filmYourself: [], pronunciationTests: [], cutOrder: [] },
});
const state = (o = {}) => ({
  part1: {
    setup: { folder: `${ROOT}\\Coal Tar`, brief: "b.md", topic: "Coal Tar", prefix: "coal_tar", episode: "008", runtime: "6:00–6:45", voice: "own" },
    drafts: [{ n: 1, at: 1, why: "Written", note: null, script: script() }, { n: 2, at: 2, why: "Revised from your note", note: "shorter cold open", script: script() }],
    picks: [{ id: "01.2", text: `${words(5, "More")}.`, from: "claude", why: "" }],
    pickNotes: [], approvedAt: null, ...o,
  },
});
const SETTINGS = { titleHoldS: 6, endCardS: 12 };

test("part 1: numbers raw and expected, warnings, and the current draft", () => {
  const m = part1Model({ state: state(), settings: SETTINGS });
  const s = scriptStats(script(), SETTINGS);
  assert.equal(m.expectedS, s.expectedS);
  assert.equal(m.numbers, `${mmss(s.rawS)} est · ${mmss(s.expectedS)} expected · ${s.words} words · 3 clips · 2 sections`);
  assert.ok(m.warnings.includes("Clip 02 is 54 words (5–50)."));
  assert.ok(m.warnings.includes("Clips: 3 (aim for 26–29)."));
  assert.equal(m.draft, 'Draft 2 of 2 (from your note "shorter cold open")');
  assert.deepEqual(m.drafts.map((d) => [d.n, d.current]), [[1, false], [2, true]]);
  assert.equal(m.drafts[0].label, "Draft 1 of 2 (Written)");
});

test("part 1: sections with times, clips with line ids, picked ids marked", () => {
  const m = part1Model({ state: state(), settings: SETTINGS });
  assert.match(m.sections[0].heading, /^SECTION 1 — COLD OPEN \(about 0:00–\d:\d\d\)$/);
  const c = m.sections[0].clips[0];
  assert.equal(c.num, "01");
  assert.equal(c.delivery, "slowly");
  assert.equal(c.cue, "Wide shot, HF-01");
  assert.deepEqual(c.ids, ["01.1", "01.2"]);
  assert.deepEqual(c.picked, ["01.2"]);
  assert.deepEqual(m.sections[1].clips[0].picked, []);
  assert.equal(m.sections[1].clips[0].n, 3);
  assert.deepEqual(m.picks, [{ id: "01.2", text: `${words(5, "More")}.`, from: "suggested" }]);
  assert.ok(!m.addable.some((l) => l.id === "01.2"));
  assert.ok(m.addable.some((l) => l.id === "01.1"));
  assert.deepEqual(m.pronunciations, [{ name: "St Austell", say: "Saint Ostul" }]);
  assert.deepEqual(m.notes, [{ heading: "Corrections to the brief", items: ["Date fixed."] }]);
  assert.equal(m.episode, "008");
});

test("part 1: approve locked with the reason", () => {
  const none = part1Model({ state: state({ drafts: [] }) });
  assert.equal(none.canApprove, false);
  assert.equal(none.approveWhy, NO_DRAFT);
  assert.equal(NO_DRAFT, "Write the script first.");
  assert.equal(none.hasDraft, false);
  const busy = part1Model({ state: state(), busy: true });
  assert.equal(busy.canApprove, false);
  assert.equal(busy.approveWhy, WAIT);
  assert.equal(WAIT, "Wait for Claude to finish.");
  const st = state();
  st.part1.setup.episode = " ";
  const noEp = part1Model({ state: st });
  assert.equal(noEp.canApprove, false);
  assert.equal(noEp.approveWhy, NO_EPISODE);
  assert.equal(NO_EPISODE, "Add the episode number.");
  const ok = part1Model({ state: state() });
  assert.equal(ok.canApprove, true);
  assert.equal(ok.approveWhy, null);
});

test("part 1: busy shows Writing… (about a minute); a quick edit locks without it; the error shows", () => {
  assert.equal(part1Model({ state: state(), busy: true }).busyText, WRITING);
  assert.equal(WRITING, "Writing… (about a minute)");
  assert.equal(part1Model({ state: state(), busy: true, ui: { writing: false } }).busyText, null);
  assert.equal(part1Model({ state: state() }).busyText, null);
  assert.equal(part1Model({ state: state(), error: "boom" }).error, "boom");
});

test("part 1: after approval the next step and open items, nothing to approve", () => {
  const m = part1Model({ state: state({ approvedAt: 5 }), ui: { openItems: ["Copy the line script to Autocue Studio's folder by hand: C:\\x"] } });
  assert.equal(m.approved, true);
  assert.equal(m.canApprove, false);
  assert.equal(m.nextStep, nextStepText("coal_tar"));
  assert.match(m.nextStep, /^Record every line in Autocue Studio \(Load script → coal_tar_line_script\.txt\)\./);
  assert.deepEqual(m.openItems, ["Copy the line script to Autocue Studio's folder by hand: C:\\x"]);
  assert.equal(part1Model({ state: state() }).nextStep, null);
});

test("part 1: list rows round trip; a bad sfx clip or half a pronunciation is refused", () => {
  const sc = script();
  assert.deepEqual(listRows("sfx", sc.sfx), [{ cue: "Wind", clip: "01", idea: "low wind" }]);
  assert.deepEqual(listFromRows("sfx", [{ cue: "Wind", clip: "01", idea: "low wind" }, { cue: "", clip: "", idea: "" }], { script: sc }), [{ cue: "Wind", clip: 1, idea: "low wind" }]);
  assert.throws(() => listFromRows("sfx", [{ cue: "x", clip: "9", idea: "" }], { script: sc }), /Sound effect 1: the clip is a number from 01 to 03\./);
  assert.throws(() => listFromRows("pronunciations", [{ name: "Fowey", say: "" }], { script: sc }), /Pronunciation 1: add both/);
  assert.deepEqual(listFromRows("shots", [{ id: "HF-01", usedIn: "01", prompt: "New prompt" }], { script: sc }), [{ id: "HF-01", usedIn: [1], prompt: "New prompt" }]);
});

// ---------- Review ----------

test("review: with part1 set (not approved) only the heading and the Part 1 step", () => {
  const film = { dir: `${ROOT}\\Coal Tar`, title: "Coal Tar" };
  const p1 = part1Model({ state: state() });
  const m = reviewModel({ film, state: state(), part1: p1 });
  assert.equal(m.part1Only, true);
  assert.equal(m.title, "Coal Tar");
  assert.equal(m.part1, p1);
  assert.equal(m.cards, undefined);
  const after = reviewModel({ film, state: state({ approvedAt: 5 }), part1: part1Model({ state: state({ approvedAt: 5 }) }) });
  assert.equal(after.part1Only, undefined);
  assert.ok(Array.isArray(after.cards));
  assert.equal(after.part1.approved, true);
  const plain = reviewModel({ film, state: { assets: [] } });
  assert.equal(plain.part1, null);
});
