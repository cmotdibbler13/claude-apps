import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { DEFAULT_SETTINGS } from "../js/settings.js";
import { makeComfyRunner, fillWorkflow, findOutput } from "../js/tools/comfyui.js";

const FILM = "S:\\Youtube video ideas\\Film A";
const OUT = FILM + "\\studio\\media\\HF-05_t2.mp4";
const WF = "S:\\Youtube video ideas\\ComfyUI workflows\\broll_ltx.json";
const comfyOut = DEFAULT_SETTINGS.comfy.outputDir + "\\broll\\clip_00001_.mp4";
const ltx = () => ({ 364: { inputs: { text: "" } }, 372: { inputs: { value: 0 } }, 360: { inputs: { value: 0 } }, 362: { inputs: { value: 0 } }, 361: { inputs: { value: 0 } }, 339: { inputs: { noise_seed: 0 } }, 9999: { inputs: { filename_prefix: "x" } } });
const mkSettings = (over = {}) => ({ ...DEFAULT_SETTINGS, comfy: { ...DEFAULT_SETTINGS.comfy, workflow: WF, ...over } });
const job = (extra = {}) => ({ id: "j1", assetId: "HF-05", take: 2, tool: "comfyui", input: { kind: "broll", prompt: "a magpie", out: OUT }, ...extra });
const hist = (over = {}) => JSON.stringify({ P1: { status: { status_str: "success", completed: true, messages: [] }, outputs: { 9999: { images: [{ filename: "clip_00001_.mp4", subfolder: "broll", type: "output" }] } }, ...over } });

function setup({ settings = mkSettings(), post, history = [hist()], withWf = true } = {}) {
  const host = new FakeHost();
  host.t = 1_000_000;
  if (withWf) host.files.set(WF, JSON.stringify(ltx()));
  host.files.set(comfyOut, "ORIGINAL");
  host.dirs.add(DEFAULT_SETTINGS.comfy.outputDir + "\\broll");
  const spawns = [], refs = [], progress = [], bodies = [];
  let h = 0;
  host.spawnScript(async (cmd, args, o, p) => {
    spawns.push({ cmd, args });
    if (cmd === "curl" && args.includes("POST")) {
      bodies.push(await host.fs.read(args[args.indexOf("--data-binary") + 1].slice(1), "utf8"));
      if (post) return post(p);
      p.out(JSON.stringify({ prompt_id: "P1" })); return p.exit(0);
    }
    if (cmd === "curl") {
      const v = history[Math.min(h++, history.length - 1)];
      if (v === null) { p.err("connection refused"); return p.exit(7); }
      p.out(v); return p.exit(0);
    }
    if (cmd === "ffmpeg") { await host.fs.write(args[args.length - 1], "CROPPED"); return p.exit(0); }
    p.exit(0);
  });
  const sleeps = [];
  const runner = makeComfyRunner({ settings, sleep: async (ms) => { sleeps.push(ms); host.t += ms; }, random: () => 0.5 });
  const ctx = { host, progress: (p, e) => progress.push([p, e]), setRef: (r) => refs.push(r) };
  return { host, runner, ctx, spawns, refs, progress, bodies, sleeps };
}

test("fillWorkflow sets the LTX map with seconds", () => {
  const wf = fillWorkflow(ltx(), DEFAULT_SETTINGS.comfy, { prompt: "p", seed: 7, prefix: "broll/x" });
  assert.equal(wf[364].inputs.text, "p");
  assert.equal(wf[372].inputs.value, 1920);
  assert.equal(wf[360].inputs.value, 1088);
  assert.equal(wf[362].inputs.value, 5);
  assert.equal(wf[361].inputs.value, 24);
  assert.equal(wf[339].inputs.noise_seed, 7);
  assert.equal(wf[9999].inputs.filename_prefix, "broll/x");
});

test("fillWorkflow Wan-style map uses frames 4n+1", () => {
  const c = { ...DEFAULT_SETTINGS.comfy, lengthUnit: "frames", nodes: { prompt: ["6", "text"], width: ["55", "width"], height: ["55", "height"], length: ["55", "length"], fps: ["57", "fps"], seed: ["3", "seed"], output: ["58", "filename_prefix"] } };
  const wf = { 6: { inputs: {} }, 55: { inputs: {} }, 57: { inputs: {} }, 3: { inputs: {} }, 58: { inputs: {} } };
  const r = fillWorkflow(wf, c, { prompt: "p", seed: 1, prefix: "a" });
  assert.equal(r[55].inputs.length, 121);
  assert.equal(r[57].inputs.fps, 24);
  assert.equal(wf[55].inputs.length, undefined, "input not mutated");
});

test("missing mapped node rejects before submit", async () => {
  const t = setup();
  const wf = ltx(); delete wf[372];
  t.host.files.set(WF, JSON.stringify(wf));
  await assert.rejects(t.runner.start(job(), t.ctx), /Workflow has no node 372/);
  assert.equal(t.spawns.length, 0);
});

test("unreadable workflow rejects", async () => {
  const t = setup({ withWf: false });
  await assert.rejects(t.runner.start(job(), t.ctx), /Couldn't read the ComfyUI workflow at /);
});

test("not-running message on a curl failure at submit", async () => {
  const t = setup({ post: (p) => { p.err("refused"); p.exit(7); } });
  await assert.rejects(t.runner.start(job(), t.ctx), /ComfyUI isn't running at 127\.0\.0\.1:8188\. Open ComfyUI Desktop and press Run again\./);
  assert.deepEqual(t.refs, []);
});

test("submit writes a temp body under studio\\tmp, uses an arg list, then trashes it", async () => {
  const t = setup();
  await t.runner.start(job(), t.ctx);
  const post = t.spawns[0];
  assert.deepEqual(post.args.slice(0, 7), ["-sS", "--fail", "-X", "POST", "-H", "Content-Type: application/json", "--data-binary"]);
  assert.equal(post.args[7], "@" + FILM + "\\studio\\tmp\\comfy_j1.json");
  assert.equal(post.args[8], "http://127.0.0.1:8188/prompt");
  const body = JSON.parse(t.bodies[0]);
  assert.match(body.prompt[9999].inputs.filename_prefix, /^broll\/sixmin_Film_A_HF-05_t2_\d+$/);
  assert.equal(body.prompt[339].inputs.noise_seed, 1073741824);
  assert.equal(t.host.files.has(FILM + "\\studio\\tmp\\comfy_j1.json"), false);
});

test("setRef before the first poll", async () => {
  const t = setup();
  const order = [];
  t.ctx.setRef = (r) => order.push("ref:" + r);
  const orig = t.host.spawn.bind(t.host);
  t.host.spawn = (c, a, o) => { if (c === "curl" && !a.includes("POST")) order.push("poll"); return orig(c, a, o); };
  await t.runner.start(job(), t.ctx);
  assert.deepEqual(order, ["ref:P1", "poll"]);
});

test("running then done; progress carries an eta", async () => {
  const t = setup({ history: ["{}", hist()] });
  const r = await t.runner.start(job(), t.ctx);
  assert.deepEqual(r, { file: OUT });
  assert.deepEqual(t.sleeps, [5000, 5000]);
  assert.equal(t.progress[0][0], null);
  assert.match(t.progress[0][1], /about \d+ min left/);
});

test("error status rejects with ComfyUI's message", async () => {
  const e = hist({ status: { status_str: "error", completed: false, messages: [["execution_start", {}], ["execution_error", { exception_message: "Out of memory" }]] } });
  const t = setup({ history: [e] });
  await assert.rejects(t.runner.start(job(), t.ctx), /Out of memory/);
});

test("finds the output under images, gifs or videos", () => {
  for (const k of ["images", "gifs", "videos"]) {
    assert.deepEqual(findOutput({ outputs: { 12: { [k]: [{ filename: "a.mp4", subfolder: "broll", type: "output" }] } } }, "9999"), { filename: "a.mp4", subfolder: "broll" });
  }
  assert.equal(findOutput({ outputs: { 1: { text: ["x"] } } }, "9999"), null);
  assert.equal(findOutput({}, "9999"), null);
});

test("no output at completion rejects", async () => {
  const t = setup({ history: [hist({ outputs: {} })] });
  await assert.rejects(t.runner.start(job(), t.ctx), /ComfyUI finished but saved no video/);
});

test("ffmpeg crops and strips through .part, renames, and leaves ComfyUI's file alone", async () => {
  const t = setup();
  await t.runner.start(job(), t.ctx);
  const ff = t.spawns.find((s) => s.cmd === "ffmpeg");
  assert.deepEqual(ff.args, ["-y", "-i", comfyOut, "-vf", "crop=1920:1080", "-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", FILM + "\\studio\\media\\HF-05_t2.part.mp4"]);
  assert.equal(t.host.files.get(OUT), "CROPPED");
  assert.equal(t.host.files.has(FILM + "\\studio\\media\\HF-05_t2.part.mp4"), false);
  assert.equal(t.host.files.get(comfyOut), "ORIGINAL");
});

test("failed ffmpeg discards the .part and rejects", async () => {
  const t = setup();
  const orig = t.host.spawn.bind(t.host);
  t.host.spawnScript(async (cmd, args, o, p) => {
    if (cmd === "ffmpeg") { await t.host.fs.write(args[args.length - 1], "half"); p.err("bad"); return p.exit(1); }
    if (args.includes("POST")) { await t.host.fs.read(args[7].slice(1)); p.out('{"prompt_id":"P1"}'); return p.exit(0); }
    p.out(hist()); p.exit(0);
  });
  await assert.rejects(t.runner.start(job(), t.ctx), /ffmpeg failed/);
  assert.equal(t.host.files.has(FILM + "\\studio\\media\\HF-05_t2.part.mp4"), false);
  assert.equal(t.host.files.has(OUT), false);
  assert.equal(t.host.files.get(comfyOut), "ORIGINAL");
  void orig;
});

test("resume never POSTs", async () => {
  const t = setup();
  const r = await t.runner.resume(job({ jobRef: "P1" }), t.ctx);
  assert.deepEqual(r, { file: OUT });
  assert.equal(t.spawns.some((s) => s.args.includes("POST")), false);
  assert.equal(t.spawns[0].args.at(-1), "http://127.0.0.1:8188/history/P1");
  await assert.rejects(t.runner.resume(job(), t.ctx), /no jobRef/);
});

test("5 failed polls give an ambiguous error", async () => {
  const t = setup({ history: [null] });
  await assert.rejects(t.runner.resume(job({ jobRef: "P1" }), t.ctx), (e) => e.ambiguous === true && /Couldn't reach ComfyUI; the render may still be running\. Check again\./.test(e.message));
  assert.equal(t.sleeps.length, 5);
});

test("a good poll resets the failure count", async () => {
  const t = setup({ history: [null, null, null, null, "{}", null, null, null, null, hist()] });
  const r = await t.runner.resume(job({ jobRef: "P1" }), t.ctx);
  assert.deepEqual(r, { file: OUT });
});

test("60-min cap is ambiguous", async () => {
  const t = setup({ history: ["{}"] });
  await assert.rejects(t.runner.resume(job({ jobRef: "P1" }), t.ctx), (e) => e.ambiguous === true && /60 min/.test(e.message));
  assert.ok(t.sleeps.length >= 720 && t.sleeps.length <= 721);
});

test("lane is gpu", () => assert.equal(makeComfyRunner({ settings: mkSettings() }).lane, "gpu"));
