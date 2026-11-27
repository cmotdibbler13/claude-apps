import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FakeHost } from "./fake-host.mjs";
import { openFilm } from "../js/store.js";
import { approvePart2, part2Changed, part2Sig } from "../js/part2run.js";
import { PART1_INSTRUCTIONS, LIBRARY_INSTRUCTIONS, HANDOVER_INSTRUCTIONS } from "../js/part2prose.js";

const ROOT = "S:\\Youtube video ideas";
const DIR = `${ROOT}\\Christmas Tree`;
const LIB = `${ROOT}\\B-roll library`;
const M = `${DIR}\\studio\\media`;
const FIXTURE = readFileSync(new URL("./fixtures/broll_catalogue.json", import.meta.url), "utf8");
const HEAD = "| ID | Shot | Status | Length | What it shows | Period | Tags | Notes |\n|---|---|---|---|---|---|---|---|";
const MD = `# B-roll catalogue\n\n## The Old Lighthouse\n\n${HEAD}\n| BR-010 | HF-01 | used | 5.0 s | a | 1900s | c | d |\n`;
const PART1 = "# Part 1 handover\n\nSix minutes on… Christmas Trees. Episode 14.\n";

const take = (n, file, o = {}) => ({ n, file, status: "done", ...o });
const sample = () => ({
  assets: [
    { id: "HF-01", kind: "broll", tool: "higgsfield", line: "The tree came indoors.", desc: "A tree carried into a house", draftPrompt: "tree indoors",
      approved: true, chosen: 2, takes: [take(1, `${M}\\HF-01_t1.mp4`, { hfId: "hf-a", prompt: "tree indoors", note: "too dark" }), take(2, `${M}\\HF-01_t2.mp4`, { hfId: "hf-b", prompt: "tree indoors, brighter" }), { n: 3, status: "failed", tool: "higgsfield" }] },
    { id: "HF-02", kind: "broll", tool: "comfyui", line: "Candles on the branches.", desc: "Candles flicker on a tree", draftPrompt: "candles",
      approved: true, chosen: 1, takes: [take(1, `${M}\\HF-02_t1.mp4`, { prompt: "candles", workflow: "C:\\ComfyUI\\broll_ltx.json", seed: 7 })] },
    { id: "HF-03", kind: "lineart", tool: "higgsfield", line: "A drawing.", desc: "Line art", draftPrompt: "art",
      approved: true, chosen: 1, takes: [take(1, `${M}\\HF-03_t1.png`, { hfId: "hf-c" })] },
    { id: "HF-04", kind: "broll", tool: "higgsfield", line: "Gone.", desc: "Removed", approved: false, removedAt: 5, chosen: 1, takes: [take(1, `${M}\\HF-04_t1.mp4`)] },
    { id: "TC-01", kind: "presenter", tool: "higgsfield", lineId: "L5", line: "And that is why we still do it today.", approved: true, chosen: 1,
      takes: [take(1, `${DIR}\\studio\\presenter\\TC-01_t1.mp4`, { hfId: "hf-tc" })] },
  ],
  presenter: { portrait: { n: 1, hfId: "port-1", file: `${DIR}\\studio\\presenter\\portrait.png`, approved: true } },
  audio: {
    flowId: "flow-1",
    score: { id: "SCORE", approved: true, chosen: 1, node: { id: "n-score" }, takes: [take(1, `${DIR}\\studio\\audio\\score_1.mp3`, { source: "elevenlabs" })] },
    sfx: [{ id: "SFX-01", cue: "door", approved: true, chosen: 1, startS: 12.5, loop: false, takes: [take(1, `${DIR}\\studio\\audio\\sfx1.wav`, { source: "stableaudio" })] }],
  },
  mix: {
    voiceover: { status: "done", at: 10, wav: `${DIR}\\studio\\voiceover\\v.wav`, csv: `${DIR}\\studio\\voiceover\\v.csv`, transcript: `${DIR}\\studio\\voiceover\\v.json`, takes: [] },
    fit: { status: "done", at: 20, fromVoiceoverAt: 10, fromScoreTake: 1, file: `${DIR}\\studio\\fit\\fit.wav`, note: "Cut the middle bar", takes: [] },
    mix: { status: "done", approved: true, at: 30, fromFitAt: 20, fromVoiceoverAt: 10,
      fromSfx: [{ id: "SFX-01", take: 1, file: `${DIR}\\studio\\audio\\sfx1.wav`, startS: 12.5, loop: false, meanDb: null }],
      files: { wav: `${DIR}\\studio\\mix\\m.wav` }, sfx: [{ id: "SFX-01", gainDb: -3 }], takes: [] },
  },
});

const DATA = /DATA \(JSON\):\n([\s\S]*?)\n\nAnswer with JSON only\./;
const approvedFields = { description: "A tree.", setting: "a living room", period: "1900s", tags: ["a", "b", "c", "d", "e", "f", "g", "h"], notes: "Higgsfield kling3_0, 16:9, 1920x1080 24 fps, sound off." };

async function setup({ state = sample(), md = MD, json = FIXTURE, part1 = PART1 } = {}) {
  const h = new FakeHost();
  const put = (p, v = new Uint8Array(1000)) => h.files.set(p, v);
  for (const p of [`${M}\\HF-01_t1.mp4`, `${M}\\HF-01_t2.mp4`, `${M}\\HF-02_t1.mp4`, `${M}\\HF-03_t1.png`, `${DIR}\\studio\\presenter\\TC-01_t1.mp4`,
    `${DIR}\\studio\\presenter\\portrait.png`, `${DIR}\\studio\\audio\\score_1.mp3`, `${DIR}\\studio\\audio\\sfx1.wav`, `${DIR}\\studio\\voiceover\\v.wav`,
    `${DIR}\\studio\\voiceover\\v.csv`, `${DIR}\\studio\\fit\\fit.wav`, `${DIR}\\studio\\mix\\m.wav`]) put(p);
  put(`${DIR}\\studio\\voiceover\\v.json`, JSON.stringify({ sentences: [{ sentence: "L5", start: 30, end: 34 }] }));
  if (part1 != null) put(`${DIR}\\handover\\part1_handover.md`, part1);
  if (json != null) put(`${LIB}\\broll_catalogue.json`, json);
  if (md != null) put(`${LIB}\\broll_catalogue.md`, md);
  h.dirs.add(`${LIB}`);
  h.dirs.add("C:/Rec/christmas_tree");
  h.claude_calls = [];
  h.claudeScript((kind, text) => {
    const data = JSON.parse(DATA.exec(text)[1]);
    if (text.startsWith(PART1_INSTRUCTIONS)) { h.claude_calls.push("part1"); return { topic: "Christmas Trees", episode: "14" }; }
    if (text.startsWith(LIBRARY_INSTRUCTIONS)) {
      h.claude_calls.push("library");
      h.libraryItems = data.items;
      return { items: data.items.map((i) => i.kind === "approved" ? { key: i.key, ...approvedFields }
        : { key: i.key, description: "Too dark.", setting: "", period: "", tags: ["tree", "rejected"], notes: `Rejected: ${i.note || "not chosen in review"}` }) };
    }
    if (text.startsWith(HANDOVER_INSTRUCTIONS)) { h.claude_calls.push("prose"); h.proseData = data; return { decisions: ["Chose take 2 of HF-01."], openItems: ["Check the candles."] }; }
    throw new Error("unexpected Claude call");
  });
  h.events = [];
  h.sheetFails = false;
  h.spawnScript(async (cmd, args, o, p) => {
    if (cmd === "ffprobe") { p.out(JSON.stringify({ streams: [{ width: 1920, height: 1080, r_frame_rate: "24/1" }], format: { duration: "5.04" } })); p.exit(0); return; }
    const out = args[args.length - 1];
    if (h.sheetFails && /contact_sheets/.test(out)) { p.err("font missing"); p.exit(1); return; }
    h.events.push(["ffmpeg", out]);
    await h.fs.mkdir(out.replace(/\\[^\\]+$/, ""));
    h.files.set(out, new Uint8Array(5));
    p.exit(0);
  });
  const store = await openFilm(h, DIR);
  await store.update((d) => Object.assign(d, state));
  const write = h.fs.write, rename = h.fs.rename;
  h.fs.write = async (pa, d) => { h.events.push(["write", pa]); return write(pa, d); };
  h.fs.rename = async (a, b) => { h.events.push(["rename", a, b]); return rename(a, b); };
  const jobs = [{ id: "j1", film: DIR, status: "done", jobRef: "x" }, { id: "j2", film: `${ROOT}\\Other Film`, status: "running" }];
  const ctx = { host: h, store, jobs: { list: () => jobs }, settings: { autocueRecordings: "C:\\Rec", videoModel: "kling3_0" }, root: ROOT,
    lineScript: { name: "christmas_tree", path: `${DIR}\\narration\\christmas_tree_line_script.txt` } };
  h.files.set(ctx.lineScript.path, "# name: christmas_tree\n");
  return { h, store, ctx, jobs };
}

const snapshot = (h) => ({ files: new Map([...h.files].map(([k, v]) => [k, typeof v === "string" ? v : Array.from(v).join(",")])), dirs: new Set(h.dirs) });
const assertUntouched = (h, before) => {
  const now = snapshot(h);
  assert.deepEqual([...now.files.keys()].sort(), [...before.files.keys()].sort());
  for (const [k, v] of before.files) assert.equal(now.files.get(k), v, `${k} changed`);
  assert.deepEqual([...now.dirs].sort(), [...before.dirs].sort());
  assert.equal(h.events.length, 0, `wrote: ${JSON.stringify(h.events)}`);
};
const read = (h, p) => h.fs.read(p, "utf8");
const has = (h, p) => h.fs.exists(p);

test("happy path: reads everything, then writes in order, and records part2", async () => {
  const { h, store, ctx } = await setup();
  const steps = [];
  const r = await approvePart2(ctx, { onStep: (s) => steps.push(s) });
  assert.deepEqual(steps.map((s) => s.text), ["Reading the library", "Adding 2 clips", "Thumbnails and contact sheet", "Hand-off files", "Writing the handover"]);
  assert.deepEqual(steps.map((s) => s.step), [1, 2, 3, 4, 5]);
  assert.deepEqual(h.claude_calls, ["part1", "library", "prose"]);

  // Catalogue JSON: other properties kept, three new entries (two approved, one rejected), key order.
  const doc = JSON.parse(await read(h, `${LIB}\\broll_catalogue.json`));
  assert.equal(doc.generated, "2026-11-20");
  const added = doc.entries.slice(3);
  assert.deepEqual(added.map((e) => [e.id, e.shot, e.status]), [["BR-013", "HF-01", "approved"], ["BR-014", "HF-01", "rejected"], ["BR-015", "HF-02", "approved"]]);
  const a = added[0];
  assert.deepEqual(Object.keys(a), ["id", "film", "shot", "status", "aspect", "description", "setting", "period", "tags", "prompt", "job_id", "notes", "size_mb",
    "source_path", "library_path", "in_library", "duplicate_of", "duration_s", "width", "height", "fps"]);
  assert.equal(a.film, "Christmas Trees");
  assert.equal(a.job_id, "higgsfield:hf-b");
  assert.equal(a.prompt, "tree indoors, brighter");
  assert.equal(a.aspect, "16:9");
  assert.equal(a.source_path, "Christmas Tree\\studio\\media\\HF-01_t2.mp4");
  assert.equal(a.library_path, "B-roll library\\clips\\christmas_trees\\christmas_trees_HF-01.mp4");
  assert.deepEqual([a.duration_s, a.width, a.height, a.fps], [5.04, 1920, 1080, 24]);
  assert.equal(added[1].job_id, "higgsfield:hf-a");
  assert.equal(added[1].notes, "Rejected: too dark");
  assert.equal(added[1].library_path, null);
  assert.equal(added[2].job_id, "local ComfyUI broll_ltx.json seed 7");
  assert.ok(!doc.entries.some((e) => /HF-03|HF-04|TC-01/.test(e.source_path)), "line art, removed and on-camera clips stay out");
  assert.ok((await read(h, `${LIB}\\broll_catalogue.json`)).endsWith("}\n"));
  // The Claude items carry Jon's redo note on the rejected take.
  assert.equal(h.libraryItems.find((i) => i.key === "BR-014").note, "too dark");

  // Clips copied, thumbs, MD rows under a new film table, contact sheet.
  assert.ok(await has(h, `${LIB}\\clips\\christmas_trees\\christmas_trees_HF-01.mp4`));
  assert.ok(await has(h, `${LIB}\\clips\\christmas_trees\\christmas_trees_HF-02.mp4`));
  assert.ok(!(await has(h, `${LIB}\\clips\\christmas_trees\\christmas_trees_HF-01.mp4.tmp`)));
  assert.ok(await has(h, `${LIB}\\thumbs\\BR-013.jpg`));
  assert.ok(await has(h, `${LIB}\\thumbs\\BR-015.jpg`));
  assert.ok(!(await has(h, `${LIB}\\thumbs\\BR-014.jpg`)));
  const md = await read(h, `${LIB}\\broll_catalogue.md`);
  assert.ok(md.startsWith(MD));
  assert.match(md, /## Christmas Trees\n\n\| ID \|/);
  assert.match(md, /\| BR-013 \| HF-01 \| approved \| 5\.0 s \| A tree\. \|/);
  assert.match(md, /\| BR-014 \| HF-01 \| rejected \(not copied\) \| – \|/);
  assert.ok(await has(h, `${LIB}\\contact_sheets\\christmas_trees.jpg`));
  // Dated copies of the catalogues were made first.
  const stamp = (await import("../js/libraryio.js")).stampName;
  assert.equal(await read(h, stamp(`${LIB}\\broll_catalogue.json`, h.now())), FIXTURE);
  assert.equal(await read(h, stamp(`${LIB}\\broll_catalogue.md`, h.now())), MD);

  // Hand-off files and the handover.
  const cues = JSON.parse(await read(h, `${DIR}\\studio\\handover\\sfx_cues.json`));
  assert.deepEqual(cues, [{ id: "SFX-01", file: `${DIR}\\studio\\audio\\sfx1.wav`, startS: 12.5, loop: false, endS: null, gainDb: -3 }]);
  const mix = JSON.parse(await read(h, `${DIR}\\studio\\handover\\mix_settings.json`));
  assert.equal(mix.score.file, `${DIR}\\studio\\fit\\fit.wav`);
  const hand = await read(h, `${DIR}\\handover\\part2_handover.md`);
  assert.match(hand, /^# Part 2 handover: Six minutes on… Christmas Trees/);
  assert.match(hand, /- Episode: 14/);
  assert.match(hand, /HF-01 \(BR-013\)/);
  assert.match(hand, /HF-02 \(BR-015\)/);
  assert.match(hand, /- Chose take 2 of HF-01\./);
  assert.match(hand, /- Check the candles\./);
  assert.ok(hand.includes(`read ${DIR}\\handover\\part2_handover.md, and carry on.`));
  assert.equal(r.handover, `${DIR}\\handover\\part2_handover.md`);
  assert.deepEqual(r.brIds, ["BR-013", "BR-015"]);
  assert.deepEqual(r.added, ["BR-013", "BR-014", "BR-015"]);
  assert.deepEqual(r.warnings, []);
  assert.match(r.message, /^Part 3 of Six minutes on… Christmas Trees\./);
  // The prose call got Jon's notes and choices.
  assert.ok(h.proseData.notes.some((n) => n.id === "HF-01" && n.take === 1 && n.note === "too dark"));
  assert.ok(h.proseData.notes.some((n) => n.note === "Cut the middle bar"));

  // Order of the writes.
  const firstAt = (re) => h.events.findIndex((e) => re.test(e[e.length - 1]));
  const order = [/clips\\christmas_trees\\christmas_trees_HF-01\.mp4$/, /thumbs\\BR-013\.jpg$/, /broll_catalogue\.json$/, /broll_catalogue\.md$/,
    /contact_sheets\\christmas_trees\.jpg$/, /sfx_cues\.json$/, /mix_settings\.json$/, /part2_handover\.md$/, /state\.json$/];
  const at = order.map(firstAt);
  assert.ok(at.every((i) => i >= 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((x, y) => x - y), at, JSON.stringify(h.events));

  // part2 recorded, and the log line.
  const p2 = store.state.part2;
  assert.deepEqual(Object.keys(p2), ["approvedAt", "handover", "brIds", "sig"]);
  assert.equal(p2.approvedAt, h.now());
  assert.equal(p2.handover, `${DIR}\\handover\\part2_handover.md`);
  assert.deepEqual(p2.brIds, ["BR-013", "BR-015"]);
  assert.equal(p2.sig, part2Sig(store.state));
  assert.equal(part2Changed(store.state), false);
  assert.match((await store.readLog())[0].text, /Part 2 approved/);
});

test("catalogue invalid or without a list: nothing is written anywhere (Review Focus 2)", async () => {
  for (const json of ["{ not json", JSON.stringify({ a: [], b: [] }), null]) {
    const { h, ctx } = await setup({ json });
    h.events = [];
    const before = snapshot(h);
    await assert.rejects(approvePart2(ctx), (e) => /broll_catalogue\.json|no list of clips/.test(e.message));
    assertUntouched(h, before);
    assert.ok(!(await has(h, `${DIR}\\handover\\part2_handover.md`)));
  }
});

test("a missing take: stops naming the file, nothing written", async () => {
  const { h, ctx } = await setup();
  h.files.delete(`${M}\\HF-01_t1.mp4`);
  h.events = [];
  const before = snapshot(h);
  await assert.rejects(approvePart2(ctx), /^Error: Missing file: .*HF-01_t1\.mp4$/);
  assertUntouched(h, before);
  const t = await setup();
  t.h.files.delete(`${DIR}\\studio\\mix\\m.wav`);
  t.h.events = [];
  const b2 = snapshot(t.h);
  await assert.rejects(approvePart2(t.ctx), /Missing file: .*m\.wav/);
  assertUntouched(t.h, b2);
});

test("a Claude failure: nothing written", async () => {
  const { h, ctx } = await setup();
  const prev = h._claude;
  h.claudeScript((kind, text, o) => (text.startsWith(HANDOVER_INSTRUCTIONS) ? { decisions: [] } : prev(kind, text, o)));
  h.events = [];
  const before = snapshot(h);
  await assert.rejects(approvePart2(ctx));
  assertUntouched(h, before);
});

test("second run adds nothing new, skips the library call and moves the old handover aside", async () => {
  const { h, store, ctx } = await setup();
  await approvePart2(ctx);
  const json1 = await read(h, `${LIB}\\broll_catalogue.json`);
  const md1 = await read(h, `${LIB}\\broll_catalogue.md`);
  const hand1 = await read(h, `${DIR}\\handover\\part2_handover.md`);
  h.t += 3600_000;
  h.claude_calls = [];
  const steps = [];
  const r = await approvePart2(ctx, { onStep: (s) => steps.push(s.text) });
  assert.deepEqual(h.claude_calls, ["part1", "prose"]);
  assert.equal(steps[1], "Adding 0 clips");
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.brIds, ["BR-013", "BR-015"]);
  assert.equal(await read(h, `${LIB}\\broll_catalogue.json`), json1);
  assert.equal(await read(h, `${LIB}\\broll_catalogue.md`), md1);
  const { stampName } = await import("../js/libraryio.js");
  assert.equal(await read(h, stampName(`${DIR}\\handover\\part2_handover.md`, h.now())), hand1);
  assert.match(await read(h, `${DIR}\\handover\\part2_handover.md`), /HF-01 \(BR-013\)/);
  assert.equal(JSON.parse(json1).entries.length, 6);
  assert.equal(store.state.part2.approvedAt, h.now());
});

test("a new approved shot on a second run is added with the next number", async () => {
  const { h, store, ctx } = await setup();
  await approvePart2(ctx);
  h.files.set(`${M}\\HF-05_t1.mp4`, new Uint8Array(1000));
  await store.update((d) => d.assets.push({ id: "HF-05", kind: "blender", tool: "blender", line: "A model.", desc: "A model", approved: true, chosen: 1,
    takes: [take(1, `${M}\\HF-05_t1.mp4`, { script: `${DIR}\\studio\\blender\\HF-05_t1.py` })] }));
  assert.equal(part2Changed(store.state), true);
  const r = await approvePart2(ctx);
  assert.deepEqual(r.added, ["BR-016"]);
  const doc = JSON.parse(await read(h, `${LIB}\\broll_catalogue.json`));
  const e = doc.entries.find((x) => x.id === "BR-016");
  assert.equal(e.job_id, "Blender: Christmas Tree\\studio\\blender\\HF-05_t1.py");
  assert.equal(e.library_path, "B-roll library\\clips\\christmas_trees\\christmas_trees_HF-05.mp4");
});

test("a library clip already there: same size is kept, a different file stops with nothing written", async () => {
  const dest = `${LIB}\\clips\\christmas_trees\\christmas_trees_HF-01.mp4`;
  const t = await setup();
  t.h.files.set(dest, new Uint8Array(7));
  t.h.events = [];
  const before = snapshot(t.h);
  await assert.rejects(approvePart2(t.ctx), (e) => e.message === `${dest} already exists in the library`);
  assertUntouched(t.h, before);

  const s = await setup();
  const same = new Uint8Array(1000).fill(9);
  s.h.files.set(dest, same);
  await approvePart2(s.ctx);
  assert.equal(await s.h.fs.read(dest), same, "not overwritten");
  assert.ok(!s.h.events.some((e) => e[0] === "write" && e[1].startsWith(dest)));
});

test("refused: not ready (the lock sentence) or a job of this film running (Review Focus 5)", async () => {
  const st = sample();
  st.assets[0].approved = false;
  st.audio.score.approved = false;
  const a = await setup({ state: st });
  a.h.events = [];
  await assert.rejects(approvePart2(a.ctx), /^Error: 1 shot, the score and the mix still to approve$/);
  assert.equal(a.h.events.length, 0);

  for (const status of ["queued", "running"]) {
    const b = await setup();
    b.jobs.push({ id: "j3", film: "\\\\192.168.1.171\\jon\\Youtube video ideas\\christmas tree", status, assetId: "HF-02" });
    b.h.events = [];
    const before = snapshot(b.h);
    await assert.rejects(approvePart2(b.ctx), /^Error: Wait for the running jobs to finish\.$/);
    assertUntouched(b.h, before);
    assert.deepEqual(b.h.claude_calls, []);
  }
});

test("contact sheet failure is a warning, in the result and under Open items", async () => {
  const { h, ctx } = await setup();
  h.sheetFails = true;
  const r = await approvePart2(ctx);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /^The contact sheet couldn't be made: /);
  const hand = await read(h, `${DIR}\\handover\\part2_handover.md`);
  assert.ok(hand.split("## Open items")[1].split("## Usage")[0].includes(r.warnings[0]));
});

test("no part1 handover: film named after its folder, not an error", async () => {
  const { h, ctx } = await setup({ part1: null });
  const r = await approvePart2(ctx);
  assert.ok(!h.claude_calls.includes("part1"));
  const doc = JSON.parse(await read(h, `${LIB}\\broll_catalogue.json`));
  assert.equal(doc.entries[3].film, "Christmas Tree");
  assert.equal(doc.entries[3].library_path, "B-roll library\\clips\\christmas_tree\\christmas_tree_HF-01.mp4");
  assert.match(await read(h, r.handover), /Episode: not found in part1_handover\.md/);
});

test("part2Changed after unapprove or a new chosen take; false before approval", async () => {
  const { store, ctx } = await setup();
  assert.equal(part2Changed(store.state), false);
  await approvePart2(ctx);
  assert.equal(part2Changed(store.state), false);
  await store.update((d) => { d.assets[0].approved = false; });
  assert.equal(part2Changed(store.state), true);
  await store.update((d) => { d.assets[0].approved = true; });
  assert.equal(part2Changed(store.state), false);
  await store.update((d) => { d.mix.mix.at = 31; });
  assert.equal(part2Changed(store.state), true);
});

test("an unlabelled contact sheet is a warning; the font is passed", async () => {
  const { h, ctx } = await setup();
  h.files.set("C:/Windows/Fonts/arial.ttf", new Uint8Array(1));
  const prev = h._spawn;
  const sheets = [];
  h.spawnScript((cmd, args, o, p) => {
    const fc = args[args.indexOf("-filter_complex") + 1] ?? "";
    if (/contact_sheets/.test(args[args.length - 1])) sheets.push(fc);
    if (/drawtext/.test(fc)) { p.err("no font"); p.exit(1); return; }
    return prev(cmd, args, o, p);
  });
  const r = await approvePart2(ctx);
  assert.match(sheets[0], /fontfile='C\\:\/Windows\/Fonts\/arial\.ttf'/);
  assert.deepEqual(r.warnings, ["The contact sheet was made without BR labels."]);
  assert.match(await read(h, r.handover), /- The contact sheet was made without BR labels\./);
});
