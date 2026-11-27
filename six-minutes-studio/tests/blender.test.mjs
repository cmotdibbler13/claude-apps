import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { makeBlenderRunner, blenderRunner, ensureVideoMediaType, NO_PICTURES, BLANK_TWICE, CLAUDE_WAIT_MS } from "../js/tools/blender.js";

const DIR = "S:\\Youtube video ideas\\Film A";
const OUT = DIR + "\\studio\\media\\HF-03_t2.mp4";
const SRC = DIR + "\\studio\\media\\HF-02_t1.png";
const settings = { videoModel: "kling3_0", imageModel: "gpt_image_2", blenderPath: "C:\\Blender\\blender.exe" };
const asset = { id: "HF-03", desc: "3D version of the harbour", line: "The harbour was quiet." };

function setup(spawnFn) {
  const host = new FakeHost();
  const calls = [];
  host.spawnScript((cmd, args, opts, p) => { calls.push({ cmd, args, opts }); return spawnFn(p, host); });
  const progress = [];
  const ctx = { host, progress: (p) => progress.push(p), setRef: () => {} };
  const job = { id: "j", tool: "blender", input: { kind: "blender", script: DIR + "\\studio\\blender\\HF-03_t2.py", sourceFile: SRC, out: OUT, frames: 100 } };
  return { host, calls, progress, ctx, job, runner: makeBlenderRunner({ settings }) };
}

test("lane is gpu; default runner exported", () => {
  assert.equal(blenderRunner.lane, "gpu");
  assert.equal(makeBlenderRunner({ settings }).lane, "gpu");
  assert.equal(blenderRunner.resume, undefined);
});

test("progress follows Fra lines", async () => {
  const t = setup(async (p, host) => {
    p.out("Fra:10 Mem:5M\nFra:50 Mem:5M | Time\n");
    p.err("Fra:250 odd");
    await host.fs.mkdir(DIR + "\\studio\\media");
    await host.fs.write(OUT, "x");
    p.exit(0);
  });
  const r = await t.runner.start(t.job, t.ctx);
  assert.deepEqual(r, { file: OUT });
  assert.deepEqual(t.progress, [0.1, 0.5, 1]);
});

test("progress handles lines split across chunks", async () => {
  const t = setup(async (p, host) => {
    p.out("Fra:2"); p.out("0 Mem\n");
    await host.fs.mkdir(DIR + "\\studio\\media"); await host.fs.write(OUT, "x");
    p.exit(0);
  });
  await t.runner.start(t.job, t.ctx);
  assert.deepEqual(t.progress, [0.2]);
});

test("script path and args are passed after --", async () => {
  const t = setup(async (p, host) => { await host.fs.mkdir(DIR + "\\studio\\media"); await host.fs.write(OUT, "x"); p.exit(0); });
  await t.runner.start(t.job, t.ctx);
  assert.equal(t.calls[0].cmd, settings.blenderPath);
  assert.deepEqual(t.calls[0].args, ["-b", "--python-exit-code", "1", "-P", t.job.input.script, "--", SRC, OUT]);
});

test("non-zero exit marks take failed with log tail", async () => {
  const t = setup(async (p) => {
    for (let i = 1; i <= 30; i++) p.out(`line ${i}\n`);
    p.exit(1);
  });
  await assert.rejects(t.runner.start(t.job, t.ctx), (e) => {
    assert.match(e.message, /line 30/);
    assert.match(e.message, /line 11/);
    assert.doesNotMatch(e.message, /line 10\b/);
    return true;
  });
});

test("exit 0 without output file fails", async () => {
  const t = setup(async (p) => { p.out("done\n"); p.exit(0); });
  await assert.rejects(t.runner.start(t.job, t.ctx), /no output file|didn't write/i);
});

test("exit code null means Blender didn't start", async () => {
  const t = setup(async (p) => { p.err("spawn blender ENOENT"); p.exit(null); });
  await assert.rejects(t.runner.start(t.job, t.ctx), /^Error: Blender didn't start: spawn blender ENOENT\. Check the Blender path in \.studio-settings\.json\.$/);
});

test("a pre-existing output is moved aside and cannot make a failed run pass", async () => {
  const t = setup(async (p) => { p.out("Traceback\n"); p.exit(0); });
  await t.host.fs.mkdir(DIR + "\\studio\\media");
  await t.host.fs.write(OUT, "partial");
  await assert.rejects(t.runner.start(t.job, t.ctx), /didn't write an output file/);
  assert.equal(await t.host.fs.exists(OUT), false);
  const stale = DIR + "\\studio\\media\\HF-03_t2.stale-" + t.host.now() + ".mp4";
  assert.equal(await t.host.fs.read(stale, "utf8"), "partial");
});

test("progress is reported only when it moves by at least 1 %", async () => {
  const t = setup(async (p, host) => {
    for (let i = 1; i <= 200; i++) p.out(`Fra:${i} Mem:1M | Rendering\nFra:${i} Mem:1M | Sample 1/64\n`);
    await host.fs.mkdir(DIR + "\\studio\\media");
    await host.fs.write(OUT, "x");
    p.exit(0);
  });
  t.job.input.frames = 200;
  await t.runner.start(t.job, t.ctx);
  assert.ok(t.progress.length <= 101, `reported ${t.progress.length} times`);
  assert.equal(t.progress.at(-1), 1);
});

// Seen on Jon's PC (Blender 5.2): enum "FFMPEG" not found until media_type is 'VIDEO'.
test("ensureVideoMediaType switches to video before FFMPEG, keeps indentation, leaves good scripts alone", () => {
  const bad = "import bpy\nscene = bpy.context.scene\nscene.render.image_settings.file_format = 'FFMPEG'\n";
  const fixed = ensureVideoMediaType(bad);
  assert.match(fixed, /if hasattr\(scene\.render\.image_settings, "media_type"\):\n    scene\.render\.image_settings\.media_type = 'VIDEO'\nscene\.render\.image_settings\.file_format = 'FFMPEG'/);
  const inner = "def setup(s):\n    img = s.render.image_settings\n    img.file_format = \"FFMPEG\"\n";
  assert.match(ensureVideoMediaType(inner), /    if hasattr\(img, "media_type"\):\n        img\.media_type = 'VIDEO'\n    img\.file_format = "FFMPEG"/);
  const good = "img.media_type = 'VIDEO'\nimg.file_format = 'FFMPEG'\n";
  assert.equal(ensureVideoMediaType(good), good);
  assert.equal(ensureVideoMediaType("img.file_format = 'PNG'\n"), "img.file_format = 'PNG'\n");
});

test("Run again on an old script adds the Blender 5 video switch before Blender starts", async () => {
  let seen = null;
  const t = setup(async (p, host) => { seen = await host.fs.read(t.job.input.script, "utf8"); await host.fs.mkdir(DIR + "\\studio\\media"); await host.fs.write(OUT, "x"); p.exit(0); });
  await t.host.fs.mkdir(DIR + "\\studio\\blender");
  await t.host.fs.write(t.job.input.script, "img = bpy.context.scene.render.image_settings\nimg.file_format = 'FFMPEG'\n");
  await t.runner.start(t.job, t.ctx);
  assert.match(seen, /img\.media_type = 'VIDEO'\nimg\.file_format = 'FFMPEG'/);
});

// ---- Model, check, render: the whole take inside the Blender job ----
const BASE = DIR + "\\studio\\blender\\HF-03_t2";
const BDIR = DIR + "\\studio\\blender";
const asset3 = { id: "HF-03", desc: "3D line-art version of a stone dresser", line: "The dresser stood by the door." };

// stills: per still run, "ok" (write the PNG), "crash" (exit 1 with a traceback) or "nofile" (exit 0, no PNG).
function take3({ answers = [], stills = [], images = true, input = {}, files = {}, wait } = {}) {
  const host = new FakeHost();
  host.limitsScript(() => (images ? { images: { max: 5 } } : {}));
  host.files.set(SRC, "DRAWING");
  for (const [k, v] of Object.entries(files)) host.files.set(k, v);
  const calls = [], asks = [], progress = [];
  let still = 0;
  host.spawnScript(async (cmd, args, opts, p) => {
    calls.push(args);
    const i = args.indexOf("--still");
    if (i >= 0) {
      const how = stills[still++] ?? "ok";
      if (how === "crash") { p.out("Fra:1\n"); p.err(`Traceback: NameError ${still}\n`); return p.exit(1); }
      if (how === "ok") host.files.set(args[i + 1], `STILL${still}`);
      return p.exit(0);
    }
    p.out("Fra:120 Mem\n");
    host.files.set(args.at(-1), "MP4");
    p.exit(0);
  });
  let n = 0;
  host.claudeScript(async (kind, inputText, opts) => {
    const texts = await Promise.all((opts.images ?? []).map((b) => b.text()));
    asks.push({ input: inputText, opts, texts, data: JSON.parse(inputText.split("DATA (JSON):\n")[1].split("\n\nAnswer")[0]) });
    const a = answers[n++];
    if (!a) throw new Error("no answer scripted");
    return typeof a === "function" ? a() : a;
  });
  const ctx = { host, progress: (p, text) => progress.push([p, text]), setRef: () => {} };
  const job = { id: "j", tool: "blender", input: { kind: "blender", asset: asset3, take: 2, sourceFile: SRC, base: BASE, out: OUT, ...input } };
  return { host, calls, asks, progress, ctx, job, runner: makeBlenderRunner({ settings, ...(wait ? { claudeWaitMs: wait } : {}) }) };
}
const SCRIPT = (s, frames = 240) => ({ script: `import bpy\n# ${s}\n`, frames });
const read = (host, p) => host.fs.read(p, "utf8");
const renders = (calls) => calls.filter((a) => !a.includes("--still"));

test("happy path: script, still, matches, render; the check sees drawing then still", async () => {
  const t = take3({ answers: [SCRIPT("one"), { verdict: "matches", note: "looks like the drawing" }] });
  const r = await t.runner.start(t.job, t.ctx);
  assert.deepEqual(r, { file: OUT, meta: { script: BASE + ".py", checks: [{ round: 1, still: BASE + "_check1.png", verdict: "matches", note: "looks like the drawing" }] } });
  assert.equal(t.asks.length, 2);
  assert.deepEqual(t.asks[0].texts, ["DRAWING"]);
  assert.equal(t.asks[0].opts.images[0].type, "image/png");
  assert.match(t.asks[0].input, /expert Blender technical artist writing/);
  assert.deepEqual(t.asks[0].data.asset, asset3);
  assert.equal(t.asks[0].data.take, 2);
  assert.deepEqual(t.asks[1].texts, ["DRAWING", "STILL1"]);
  assert.match(t.asks[1].input, /checking a test render/);
  assert.match(t.asks[1].data.script, /# one/);
  assert.deepEqual(t.calls[0], ["-b", "--python-exit-code", "1", "-P", BASE + "_r1.py", "--", SRC, OUT, "--still", BASE + "_check1.png"]);
  assert.deepEqual(t.calls[1], ["-b", "--python-exit-code", "1", "-P", BASE + ".py", "--", SRC, OUT]);
  assert.equal(await read(t.host, BASE + ".py"), await read(t.host, BASE + "_r1.py"));
  assert.deepEqual(JSON.parse(await read(t.host, BASE + "_check1.json")), { round: 1, still: BASE + "_check1.png", verdict: "matches", note: "looks like the drawing", frames: 240 });
  assert.deepEqual(t.progress.slice(0, 2), [[null, "Modelling"], [null, "Check 1 of 3"]]);
  assert.deepEqual(t.progress.at(-1), [0.5, "Rendering frame 120 of 240"]);
});

test("fix then matches: round 2 script is used for the render; frames kept when the fix leaves them out", async () => {
  const t = take3({ answers: [SCRIPT("one", 200), { verdict: "fix", note: "made the top slab thicker", script: "import bpy\n# two\n" }, { verdict: "matches", note: "close" }] });
  const r = await t.runner.start(t.job, t.ctx);
  assert.equal(await read(t.host, BASE + "_r2.py"), "import bpy\n# two\n");
  assert.equal(await read(t.host, BASE + ".py"), "import bpy\n# two\n");
  assert.deepEqual(t.calls.map((a) => a[4]), [BASE + "_r1.py", BASE + "_r2.py", BASE + ".py"]);
  assert.deepEqual(t.asks[2].texts, ["DRAWING", "STILL2"]);
  assert.deepEqual(r.meta.checks.map((c) => [c.round, c.verdict, c.note]), [[1, "fix", "made the top slab thicker"], [2, "matches", "close"]]);
  assert.ok(t.progress.some(([, s]) => s === "Check 2 of 3"));
  assert.deepEqual(t.progress.at(-1), [0.6, "Rendering frame 120 of 200"]);
});

test("written scripts get the Blender 5 video switch", async () => {
  const t = take3({ answers: [{ script: "img = scene.render.image_settings\nimg.file_format = 'FFMPEG'\n", frames: 48 }, { verdict: "matches", note: "ok" }] });
  await t.runner.start(t.job, t.ctx);
  assert.match(await read(t.host, BASE + "_r1.py"), /img\.media_type = 'VIDEO'\nimg\.file_format = 'FFMPEG'/);
  assert.match(await read(t.host, BASE + ".py"), /img\.media_type = 'VIDEO'/);
});

test("after the third still it renders the current script whatever the verdict", async () => {
  const fix = (s) => ({ verdict: "fix", note: `fixed ${s}`, script: `# ${s}\n`, frames: 100 });
  const t = take3({ answers: [SCRIPT("one"), fix("two"), fix("three"), fix("four")] });
  const r = await t.runner.start(t.job, t.ctx);
  assert.equal(t.asks.length, 4);
  assert.equal(r.meta.checks.length, 3);
  assert.equal(await read(t.host, BASE + ".py"), "# three\n");
  assert.equal(await t.host.fs.exists(BASE + "_r4.py"), false);
  assert.equal(renders(t.calls).length, 1);
});

test("blank twice in a row fails with the blank copy and no MP4 render", async () => {
  const blank = (s) => ({ verdict: "blank", note: "all navy", script: `# ${s}\n` });
  const t = take3({ answers: [SCRIPT("one"), blank("two"), blank("three")] });
  await assert.rejects(t.runner.start(t.job, t.ctx), (e) => e.message === BLANK_TWICE);
  assert.equal(BLANK_TWICE, "The 3D render came out blank. Redo with a note.");
  assert.equal(renders(t.calls).length, 0);
  assert.equal(t.calls[1][4], BASE + "_r2.py");
  assert.equal(await read(t.host, BASE + "_r2.py"), "# two\n");
  assert.equal(await t.host.fs.exists(OUT), false);
});

test("a still crash sends Blender's error and only the drawing; three crashes fail with Blender's error", async () => {
  const fix = (s) => ({ verdict: "fix", note: "fixed the NameError", script: `# ${s}\n` });
  const t = take3({ answers: [SCRIPT("one"), fix("two"), fix("three")], stills: ["crash", "crash", "crash"] });
  await assert.rejects(t.runner.start(t.job, t.ctx), (e) => /exit code 1/.test(e.message) && /NameError 3/.test(e.message));
  assert.deepEqual(t.asks[1].texts, ["DRAWING"]);
  assert.match(t.asks[1].data.error, /Traceback: NameError 1/);
  assert.deepEqual(t.asks[2].texts, ["DRAWING"]);
  assert.equal(t.asks.length, 3);
  assert.equal(renders(t.calls).length, 0);
  assert.equal(JSON.parse(await read(t.host, BASE + "_check1.json")).still, null);
});

test("a crash then a good still goes on to the render", async () => {
  const t = take3({ answers: [SCRIPT("one"), { verdict: "fix", note: "fixed it", script: "# two\n" }, { verdict: "matches", note: "good" }], stills: ["crash", "ok"] });
  const r = await t.runner.start(t.job, t.ctx);
  assert.deepEqual(r.meta.checks.map((c) => c.still), [null, BASE + "_check2.png"]);
  assert.equal(t.asks[1].data.error !== undefined, true);
  assert.equal(t.asks[2].data.error, undefined);
});

test("no image support fails with the copy before any spawn or Claude call", async () => {
  const t = take3({ images: false, answers: [SCRIPT("one")] });
  await assert.rejects(t.runner.start(t.job, t.ctx), (e) => e.message === NO_PICTURES);
  assert.equal(NO_PICTURES, "Claude can't see pictures in this view yet. Allow pictures for Six Minutes Studio when it asks, then press Run again.");
  assert.equal(t.calls.length, 0);
  assert.equal(t.asks.length, 0);
});

test("Run again resumes from the last saved round, never redoing a finished one", async () => {
  const check1 = JSON.stringify({ round: 1, still: BASE + "_check1.png", verdict: "fix", note: "n1", frames: 120 });
  const check2 = JSON.stringify({ round: 2, still: BASE + "_check2.png", verdict: "fix", note: "n2", frames: 120 });
  const t = take3({
    answers: [{ verdict: "matches", note: "good now" }],
    files: { [BASE + "_r1.py"]: "# one\n", [BASE + "_check1.png"]: "STILL1", [BASE + "_check1.json"]: check1, [BASE + "_r2.py"]: "# two\n", [BASE + "_check2.png"]: "STILL2", [BASE + "_check2.json"]: check2, [BASE + "_r3.py"]: "# three\n" },
  });
  const r = await t.runner.start(t.job, t.ctx);
  assert.equal(t.asks.length, 1);
  assert.deepEqual(t.calls.map((a) => a[4]), [BASE + "_r3.py", BASE + ".py"]);
  assert.equal(await read(t.host, BASE + ".py"), "# three\n");
  assert.deepEqual(r.meta.checks.map((c) => c.note), ["n1", "n2", "good now"]);
});

test("Run again after the check loop finished goes straight to the render", async () => {
  const check1 = JSON.stringify({ round: 1, still: BASE + "_check1.png", verdict: "fix", note: "n1", frames: 96 });
  const check2 = JSON.stringify({ round: 2, still: BASE + "_check2.png", verdict: "matches", note: "n2", frames: 96 });
  const t = take3({ files: { [BASE + "_r1.py"]: "# one\n", [BASE + "_check1.json"]: check1, [BASE + "_r2.py"]: "# two\n", [BASE + "_check2.json"]: check2, [BASE + ".py"]: "# two\n" } });
  const r = await t.runner.start(t.job, t.ctx);
  assert.equal(t.asks.length, 0);
  assert.deepEqual(t.calls, [["-b", "--python-exit-code", "1", "-P", BASE + ".py", "--", SRC, OUT]]);
  assert.equal(r.meta.checks.length, 2);
  assert.deepEqual(t.progress.at(-1), [1, "Rendering frame 96 of 96"]);
});

test("Run again re-renders the still of a round whose check was not saved, moving the old still aside", async () => {
  const t = take3({ answers: [{ verdict: "matches", note: "ok" }], files: { [BASE + "_r1.py"]: "# one\nscene.frame_end = 150\n", [BASE + "_check1.png"]: "HALF" } });
  const r = await t.runner.start(t.job, t.ctx);
  assert.equal(t.asks.length, 1);
  assert.deepEqual(t.asks[0].texts, ["DRAWING", "STILL1"]);
  assert.equal(r.meta.checks[0].round, 1);
  assert.ok([...t.host.files.keys()].some((k) => /HF-03_t2_check1\.old-.*\.png$/.test(k)));
  assert.deepEqual(t.progress.at(-1), [0.8, "Rendering frame 120 of 150"]);
});

test("redo: the note and previous script reach the script call; the previous take's last still is image 2", async () => {
  const prevScript = BDIR + "\\HF-03_t1.py", prevStill = BDIR + "\\HF-03_t1_check2.png";
  const t = take3({
    answers: [SCRIPT("two"), { verdict: "matches", note: "ok" }],
    input: { note: "turn the other way", previousScript: prevScript, previousStill: prevStill },
    files: { [prevScript]: "# OLD SCRIPT\n", [prevStill]: "PREVSTILL" },
  });
  await t.runner.start(t.job, t.ctx);
  assert.equal(t.asks[0].data.note, "turn the other way");
  assert.equal(t.asks[0].data.previousScript, "# OLD SCRIPT\n");
  assert.deepEqual(t.asks[0].texts, ["DRAWING", "PREVSTILL"]);
  assert.deepEqual(t.asks[1].texts, ["DRAWING", "STILL1"]);
});

test("redo with a missing previous still sends only the drawing", async () => {
  const t = take3({ answers: [SCRIPT("two"), { verdict: "matches", note: "ok" }], input: { note: "n", previousStill: BDIR + "\\gone.png" } });
  await t.runner.start(t.job, t.ctx);
  assert.deepEqual(t.asks[0].texts, ["DRAWING"]);
  assert.equal(t.asks[0].data.previousScript, undefined);
});

test("blank on the third round fails with the blank copy and no render", async () => {
  const fix = (s) => ({ verdict: "fix", note: `fixed ${s}`, script: `# ${s}\n` });
  const t = take3({ answers: [SCRIPT("one"), fix("two"), fix("three"), { verdict: "blank", note: "all navy", script: "# four\n" }] });
  await assert.rejects(t.runner.start(t.job, t.ctx), (e) => e.message === BLANK_TWICE);
  assert.equal(renders(t.calls).length, 0);
  assert.equal(await t.host.fs.exists(BASE + ".py"), false);
});

test("blank, fix, blank is not blank twice in a row", async () => {
  const t = take3({ answers: [SCRIPT("one"), { verdict: "blank", note: "b", script: "# two\n" }, { verdict: "fix", note: "f", script: "# three\n" }, { verdict: "fix", note: "f2", script: "# four\n" }] });
  const r = await t.runner.start(t.job, t.ctx);
  assert.equal(r.meta.checks.length, 3);
  assert.equal(renders(t.calls).length, 1);
});

test("Run again after a saved blank round fails on a second blank in a row", async () => {
  const check1 = JSON.stringify({ round: 1, still: BASE + "_check1.png", verdict: "blank", note: "navy", frames: 120 });
  const t = take3({
    answers: [{ verdict: "blank", note: "still navy", script: "# three\n" }],
    files: { [BASE + "_r1.py"]: "# one\n", [BASE + "_check1.json"]: check1, [BASE + "_r2.py"]: "# two\n" },
  });
  await assert.rejects(t.runner.start(t.job, t.ctx), (e) => e.message === BLANK_TWICE);
  assert.equal(renders(t.calls).length, 0);
});

test("matches after a crash is not accepted: the same script gets another still", async () => {
  const t = take3({ answers: [SCRIPT("one"), { verdict: "matches", note: "fine" }, { verdict: "matches", note: "good" }], stills: ["crash", "ok"] });
  const r = await t.runner.start(t.job, t.ctx);
  assert.equal(await read(t.host, BASE + "_r2.py"), await read(t.host, BASE + "_r1.py"));
  assert.equal(t.calls.filter((a) => a.includes("--still")).length, 2);
  assert.deepEqual(r.meta.checks.map((c) => [c.round, c.still]), [[1, null], [2, BASE + "_check2.png"]]);
  assert.equal(renders(t.calls).length, 1);
});

test("a Claude refusal mid-loop fails the take with a readable message and no render", async () => {
  const refuse = () => { const e = new Error("Claude declined this request."); e.code = "refused"; throw e; };
  const t = take3({ answers: [SCRIPT("one"), refuse] });
  await assert.rejects(t.runner.start(t.job, t.ctx), (e) => {
    assert.equal(e.message, "Claude stopped on the Blender check: Claude declined this request. Press Run again, or Redo with a note.");
    assert.equal(e.code, "refusal");
    return true;
  });
  assert.equal(renders(t.calls).length, 0);
});

test("a Claude call that never answers fails after the wait, for the script and for the check", async () => {
  const never = () => new Promise(() => {});
  const s = take3({ answers: [never], wait: 20 });
  await assert.rejects(s.runner.start(s.job, s.ctx), (e) => e.message === "Claude didn't answer the Blender script in 5 minutes. Press Run again.");
  assert.equal(s.calls.length, 0);
  const c = take3({ answers: [SCRIPT("one"), never], wait: 20 });
  await assert.rejects(c.runner.start(c.job, c.ctx), (e) => e.message === "Claude didn't answer the Blender check in 5 minutes. Press Run again.");
  assert.equal(renders(c.calls).length, 0);
});

test("the default wait for Claude is 5 minutes", () => {
  assert.equal(CLAUDE_WAIT_MS, 5 * 60 * 1000);
});
