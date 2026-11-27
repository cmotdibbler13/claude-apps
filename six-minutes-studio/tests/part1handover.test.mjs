import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { openFilm } from "../js/store.js";
import { approvePart1 } from "../js/part1run.js";
import { renderPart1Handover, decisionsFrom, appendPronunciations } from "../js/part1handover.js";
import { scanFilms } from "../js/films.js";
import { takenPrefixes } from "../js/part1setup.js";
import { findLineScript } from "../js/narration.js";
import { scriptCandidates } from "../js/ui/review.js";

const ROOT = "S:\\Youtube video ideas";
const DIR = `${ROOT}\\China Clay`;
const AUTOCUE = "C:\\Users\\Jon\\desktop autocue";
const PRON = `${ROOT}\\pronunciations.md`;
const clip = (t, extra = {}) => ({ narration: t, spoken: t, cue: "Line art.", delivery: null, pronunciations: [], ...extra });
const script = () => ({
  title: "China Clay", buildLine: "Remotion.", key: { graphics: [], extra: null },
  sections: [
    { name: "Open", clips: [clip("The pits of St Austell glow white. Nothing grows there."), clip("Second clip is here now for you.")] },
    { name: "End", clips: [clip("Third clip is here now for you.")] },
  ],
  shots: [], sfx: [{ cue: "Wind", clip: 1, idea: "Soft wind | low" }], music: null, archive: [],
  notes: { corrections: [], myths: [], softer: [], conflicts: [], timeSensitive: [], leftOut: [], filmYourself: [], pronunciationTests: [], cutOrder: [] },
  pronunciations: [{ name: "St Austell", say: "Saint Ostul" }],
});

async function setup({ autocue = true, settings = {} } = {}) {
  const host = new FakeHost();
  await host.fs.mkdir(DIR);
  await host.fs.write(`${DIR}\\brief.md`, "Brief.");
  if (autocue) await host.fs.mkdir(AUTOCUE);
  const store = await openFilm(host, DIR);
  await store.update((s) => {
    s.part1 = {
      setup: { folder: DIR, brief: `${DIR}\\brief.md`, topic: "China Clay", prefix: "china_clay", episode: "008", runtime: "6:00–6:45", voice: "own" },
      drafts: [
        { n: 1, at: 1, why: "Written", note: null, script: script() },
        { n: 2, at: 2, why: "Revised from your note", note: "Make it punchier", script: script() },
        { n: 3, at: 3, why: "Clip 02 redone: shorter", note: "shorter", script: script() },
      ],
      picks: [{ id: "01.1", text: "The pits of St Austell glow white.", from: "jon", why: "" }], pickNotes: ["Pick again."], approvedAt: null,
    };
  });
  const ctx = { host, store, root: ROOT, settings: { autocueDir: AUTOCUE, autocueRecordings: `${AUTOCUE}\\Recordings`, pronunciationsFile: PRON, ...settings } };
  return { host, store, ctx };
}

test("handover: Episode line, scanFilms, takenPrefixes, findLineScript, scriptCandidates", async () => {
  const { host, ctx, store } = await setup();
  const r = await approvePart1(ctx);
  assert.equal(r.handover, `${DIR}\\handover\\part1_handover.md`);
  const text = await host.fs.read(r.handover, "utf8");
  assert.match(text, /^Episode: 008$/m);
  assert.match(text, /^- File prefix: china_clay$/m);
  assert.match(text, /Voice[\s\S]*- Own voice \(Autocue Studio\)\n- Recordings folder: C:\\Users\\Jon\\desktop autocue\\Recordings\\china_clay/);
  assert.match(text, /- 01\.1: The pits of St Austell glow white\./);
  assert.match(text, /Revise: "Make it punchier"/);
  assert.match(text, /Clip 02: "shorter"/);
  assert.match(text, /Draft 3 approved/);
  assert.match(text, /Record every line in Autocue Studio \(Load script → china_clay_line_script\.txt\)/);
  const [film] = await scanFilms(host, ROOT);
  assert.equal(film.number, "008");
  assert.equal(film.parts[1], "done");
  assert.equal(film.parts[2], "now");
  assert.ok((await takenPrefixes(host, ROOT, ctx.settings)).includes("china_clay"));
  assert.equal(await findLineScript(host, DIR, text, ctx.settings), `${DIR}\\narration\\china_clay_line_script.txt`);
  assert.equal(scriptCandidates(text, DIR)[0], `${DIR}\\china_clay_script.md`);
  assert.equal(store.state.part1.approvedAt, host.now());
  assert.ok((await store.readLog()).some((l) => l.text === "Part 1 approved (draft 3)"));
  assert.ok(await host.fs.exists(`${AUTOCUE}\\china_clay_line_script.txt`));
  assert.ok(r.openItems.includes("Pick again."));
});

test("an existing reading script is moved aside, the new one written", async () => {
  const { host, ctx } = await setup();
  await host.fs.write(`${DIR}\\china_clay_script.md`, "OLD");
  await approvePart1(ctx);
  const files = (await host.fs.list(DIR)).map((e) => e.name);
  const aside = files.find((n) => /^china_clay_script_\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(n));
  assert.ok(aside);
  assert.equal(await host.fs.read(`${DIR}\\${aside}`, "utf8"), "OLD");
  assert.match(await host.fs.read(`${DIR}\\china_clay_script.md`, "utf8"), /Reading Script/);
});

test("no autocue folder: handover written with the open item, approval resolves", async () => {
  const { host, ctx } = await setup({ autocue: false });
  const r = await approvePart1(ctx);
  const want = `Copy the line script to Autocue Studio's folder by hand: ${AUTOCUE}\\china_clay_line_script.txt`;
  assert.ok(r.openItems.includes(want));
  const text = await host.fs.read(r.handover, "utf8");
  assert.ok(text.includes(want));
  assert.ok(await host.fs.exists(`${DIR}\\narration\\china_clay_line_script.txt`));
});

test("a failing reading-script write: no handover, error thrown, approvedAt stays null", async () => {
  const { host, ctx, store } = await setup();
  const write = host.fs.write;
  host.fs.write = async (p, d) => { if (/china_clay_script\.md\.tmp$/.test(p)) throw new Error("disk full"); return write(p, d); };
  await assert.rejects(() => approvePart1(ctx), /disk full/);
  assert.equal(await host.fs.exists(`${DIR}\\handover\\part1_handover.md`), false);
  assert.equal(store.state.part1.approvedAt, null);
});

test("refuses with no draft or an empty episode", async () => {
  const a = await setup();
  await a.store.update((s) => { s.part1.drafts = []; });
  await assert.rejects(() => approvePart1(a.ctx), /no draft/);
  const b = await setup();
  await b.store.update((s) => { s.part1.setup.episode = " "; });
  await assert.rejects(() => approvePart1(b.ctx), /episode/i);
});

test("pronunciations file: created when missing, then only new or changed lines are added", async () => {
  const { host, ctx, store } = await setup();
  await approvePart1(ctx);
  const first = await host.fs.read(PRON, "utf8");
  assert.match(first, /## China Clay\n\nSt Austell = "Saint Ostul"/);
  await store.update((s) => { s.part1.drafts.at(-1).script.pronunciations = [{ name: "St Austell", say: "Saint Ostul" }, { name: "Par", say: "Parr" }]; });
  await approvePart1(ctx);
  const second = await host.fs.read(PRON, "utf8");
  assert.equal(second.match(/St Austell = /g).length, 1);
  assert.match(second, /Par = "Parr"/);
});

test("appendPronunciations: skips identical, adds changed, null when nothing new", () => {
  const text = "## Old\n\nSt Austell = \"Saint Ostul\"\n";
  assert.equal(appendPronunciations(text, "New", [{ name: "St Austell", say: "Saint Ostul" }]), null);
  const out = appendPronunciations(text, "New", [{ name: "St Austell", say: "Sint Aw-stl" }]);
  assert.match(out, /Saint Ostul"\n\n## New\n\nSt Austell = "Sint Aw-stl"\n$/);
  assert.equal(appendPronunciations(null, "T", [{ name: "A", say: "b" }]), "## T\n\nA = \"b\"\n");
});

test("decisionsFrom and renderPart1Handover basics", () => {
  const d = decisionsFrom([{ n: 1, why: "Written", note: null }, { n: 2, why: "Revised from your note", note: "X" }], { episode: "008" });
  assert.deepEqual(d, ['Revise: "X"', "Draft 2 approved", "Episode 008"]);
  const t = renderPart1Handover({ topic: "T", prefix: "t", episode: "001", dir: "D", root: "R", brief: "B", files: { script: "S", lineScript: "L", autocueCopy: null }, recordings: "Rec", picks: [], pronunciations: [], sfx: [], decisions: [], openItems: [], approvedAt: null });
  assert.match(t, /^# Part 1 handover — Six minutes on… T\n\nEpisode: 001\n/);
  assert.match(t, /## Open items\n\n- None\./);
});

test("unreadable pronunciations file is left alone and becomes an open item", async () => {
  const { host, ctx } = await setup();
  await host.fs.write(PRON, "KEEP");
  const read = host.fs.read;
  host.fs.read = async (p, e) => { if (p === PRON) throw new Error("locked"); return read(p, e); };
  const r = await approvePart1(ctx);
  host.fs.read = read;
  assert.equal(await host.fs.read(PRON, "utf8"), "KEEP");
  const item = `Couldn't add the approved pronunciations to ${PRON}: locked`;
  assert.ok(r.openItems.includes(item));
  assert.ok((await host.fs.read(r.handover, "utf8")).includes(item));
});

test("repeat press moves the autocue copy and the handover aside", async () => {
  const { host, ctx } = await setup();
  await approvePart1(ctx);
  await host.fs.write(`${AUTOCUE}\\china_clay_line_script.txt`, "OLDCOPY");
  await host.fs.write(`${DIR}\\handover\\part1_handover.md`, "OLDHANDOVER");
  host.t += 120000;
  await approvePart1(ctx);
  const a = (await host.fs.list(AUTOCUE)).map((e) => e.name).find((n) => /^china_clay_line_script_\d{4}-.*\.txt$/.test(n));
  const h = (await host.fs.list(`${DIR}\\handover`)).map((e) => e.name).find((n) => /^part1_handover_\d{4}-.*\.md$/.test(n));
  assert.ok(a && h);
  assert.equal(await host.fs.read(`${AUTOCUE}\\${a}`, "utf8"), "OLDCOPY");
  assert.equal(await host.fs.read(`${DIR}\\handover\\${h}`, "utf8"), "OLDHANDOVER");
  assert.match(await host.fs.read(`${DIR}\\handover\\part1_handover.md`, "utf8"), /^Episode: 008$/m);
});

test("empty autocueRecordings gives a clear line, not a bogus path", async () => {
  const { host, ctx } = await setup({ settings: { autocueRecordings: "" } });
  const r = await approvePart1(ctx);
  assert.match(await host.fs.read(r.handover, "utf8"), /- Recordings folder: not set \(set autocueRecordings in \.studio-settings\.json\)/);
});
