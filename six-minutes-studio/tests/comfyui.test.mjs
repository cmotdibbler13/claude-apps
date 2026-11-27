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

const inQueue = JSON.stringify({ queue_running: [[0, "P1", {}, {}, []]], queue_pending: [] });
const inPending = JSON.stringify({ queue_running: [], queue_pending: [[1, "P1", {}, {}, []]] });
const notInQueue = JSON.stringify({ queue_running: [[0, "OTHER", {}, {}, []]], queue_pending: [] });

function setup({ settings = mkSettings(), post, history = [hist()], queue = [inQueue], withWf = true } = {}) {
  const host = new FakeHost();
  host.t = 1_000_000;
  if (withWf) host.files.set(WF, JSON.stringify(ltx()));
  host.files.set(comfyOut, "ORIGINAL");
  host.dirs.add(DEFAULT_SETTINGS.comfy.outputDir + "\\broll");
  const spawns = [], refs = [], progress = [], bodies = [];
  let h = 0, q = 0;
  host.spawnScript(async (cmd, args, o, p) => {
    spawns.push({ cmd, args });
    if (cmd === "curl" && args.includes("POST")) {
      bodies.push(await host.fs.read(args[args.indexOf("--data-binary") + 1].slice(1), "utf8"));
      if (post) return post(p);
      p.out(JSON.stringify({ prompt_id: "P1" }) + "\n200"); return p.exit(0);
    }
    if (cmd === "curl" && args.at(-1).endsWith("/queue")) {
      const v = queue[Math.min(q++, queue.length - 1)];
      if (v === null) { p.err("connection refused"); return p.exit(7); }
      p.out(v); return p.exit(0);
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

test("submit writes the body to studio\\tmp\\comfy_body.json, uses an arg list, and leaves it (no Recycle Bin)", async () => {
  const t = setup();
  await t.runner.start(job(), t.ctx);
  const post = t.spawns[0];
  assert.deepEqual(post.args.slice(0, 5), ["-sS", "-X", "POST", "-H", "Content-Type: application/json"]);
  assert.equal(post.args[6], "@" + FILM + "\\studio\\tmp\\comfy_body.json");
  assert.deepEqual(post.args.slice(7), ["-w", "\n%{http_code}", "http://127.0.0.1:8188/prompt"]);
  assert.ok(!post.args.includes("--fail"));
  const body = JSON.parse(t.bodies[0]);
  assert.match(body.prompt[9999].inputs.filename_prefix, /^broll\/sixmin_Film_A_HF-05_t2_\d+$/);
  assert.equal(body.prompt[339].inputs.noise_seed, 1073741824);
  assert.equal(t.host.files.has(FILM + "\\studio\\tmp\\comfy_body.json"), true);
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
  assert.deepEqual(ff.args, ["-y", "-i", comfyOut, "-vf", "crop=min(iw\\,1920):min(ih\\,1080)", "-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", FILM + "\\studio\\media\\HF-05_t2.part.mp4"]);
  assert.equal(t.host.files.get(OUT), "CROPPED");
  assert.equal(t.host.files.has(FILM + "\\studio\\media\\HF-05_t2.part.mp4"), false);
  assert.equal(t.host.files.get(comfyOut), "ORIGINAL");
});

test("failed ffmpeg discards the .part and rejects", async () => {
  const t = setup();
  t.host.spawnScript(async (cmd, args, o, p) => {
    if (cmd === "ffmpeg") { await t.host.fs.write(args[args.length - 1], "half"); p.err("bad"); return p.exit(1); }
    if (args.includes("POST")) { p.out('{"prompt_id":"P1"}\n200'); return p.exit(0); }
    p.out(hist()); p.exit(0);
  });
  await assert.rejects(t.runner.start(job(), t.ctx), /ffmpeg failed/);
  assert.equal(t.host.files.has(FILM + "\\studio\\media\\HF-05_t2.part.mp4"), false);
  assert.equal(t.host.files.has(OUT), false);
  assert.equal(t.host.files.get(comfyOut), "ORIGINAL");
});

test("HTTP 400 from ComfyUI reports the workflow error, not not-running", async () => {
  const body = JSON.stringify({ error: { message: "Prompt outputs failed validation" }, node_errors: { 364: { errors: [{ message: "Required input is missing" }] }, 12: { errors: [{ message: "Bad value" }] } } });
  const t = setup({ post: (p) => { p.out(body + "\n400"); p.exit(0); } });
  await assert.rejects(t.runner.start(job(), t.ctx), (e) => /^ComfyUI rejected the workflow: Prompt outputs failed validation/.test(e.message) && /node 364: Required input is missing/.test(e.message) && /node 12: Bad value/.test(e.message) && !/isn't running/.test(e.message));
  assert.deepEqual(t.refs, []);
});

test("HTTP 400 with a non-JSON body falls back to an excerpt", async () => {
  const t = setup({ post: (p) => { p.out("x".repeat(500) + "\n500"); p.exit(0); } });
  await assert.rejects(t.runner.start(job(), t.ctx), (e) => /rejected the workflow: x{200}$/.test(e.message));
});

test("connection refused (exit 7) and could not resolve (exit 6) mean not running", async () => {
  for (const code of [6, 7]) {
    const t = setup({ post: (p) => { p.err("refused"); p.exit(code); } });
    await assert.rejects(t.runner.start(job(), t.ctx), /isn't running at 127\.0\.0\.1:8188/);
  }
});

test("POST timing out is ambiguous", async () => {
  for (const post of [(p) => p.exit(28), null]) {
    const t = setup({ post: post ?? (() => {}) });
    if (!post) {
      const ms = globalThis.setTimeout;
      globalThis.setTimeout = (f, n, ...a) => ms(f, n === 30_000 ? 1 : n, ...a);
      try {
        await assert.rejects(t.runner.start(job(), t.ctx), (e) => e.ambiguous === true && /didn't answer in time/.test(e.message));
      } finally { globalThis.setTimeout = ms; }
    } else {
      await assert.rejects(t.runner.start(job(), t.ctx), (e) => e.ambiguous === true && /ComfyUI didn't answer in time; the render may have been queued\. Check ComfyUI before running again\./.test(e.message));
    }
  }
});

test("unsafe output paths from history are refused before ffmpeg", async () => {
  for (const [sub, name] of [["..\\..", "x.mp4"], ["broll", "..\\x.mp4"], ["C:\\Windows", "x.mp4"], ["\\evil", "x.mp4"], ["/etc", "x.mp4"], ["broll", "../x.mp4"]]) {
    const t = setup({ history: [hist({ outputs: { 9999: { videos: [{ filename: name, subfolder: sub }] } } })] });
    await assert.rejects(t.runner.start(job(), t.ctx), /unsafe output path/);
    assert.equal(t.spawns.some((s) => s.cmd === "ffmpeg"), false);
  }
});

test("a failing rename discards the .part", async () => {
  const t = setup();
  t.host.fs.rename = async () => { throw new Error("EBUSY"); };
  await assert.rejects(t.runner.start(job(), t.ctx), /EBUSY/);
  assert.equal(t.host.files.has(FILM + "\\studio\\media\\HF-05_t2.part.mp4"), false);
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

test("empty history and the prompt absent from the queue twice running fails plainly", async () => {
  const t = setup({ history: ["{}"], queue: [notInQueue] });
  await assert.rejects(t.runner.resume(job({ jobRef: "P1" }), t.ctx), (e) => !e.ambiguous && e.message === "ComfyUI no longer has this render (was it restarted?). Run again.");
  assert.equal(t.sleeps.length, 2);
  const q = t.spawns.filter((s) => s.args.at(-1) === "http://127.0.0.1:8188/queue");
  assert.equal(q.length, 2);
  assert.ok(q[0].args.includes("--fail") && q[0].args.includes("-sS"));
});

test("empty history with the prompt pending in the queue keeps waiting", async () => {
  const t = setup({ history: ["{}", "{}", "{}", hist()], queue: [inPending] });
  assert.deepEqual(await t.runner.resume(job({ jobRef: "P1" }), t.ctx), { file: OUT });
});

test("absent from the queue once, then present, keeps waiting (the count resets)", async () => {
  const t = setup({ history: ["{}", "{}", "{}", "{}", hist()], queue: [notInQueue, inQueue, notInQueue, inQueue] });
  assert.deepEqual(await t.runner.resume(job({ jobRef: "P1" }), t.ctx), { file: OUT });
});

test("a failing /queue call counts as a failed poll (5 strikes, ambiguous)", async () => {
  const t = setup({ history: ["{}"], queue: [null] });
  await assert.rejects(t.runner.resume(job({ jobRef: "P1" }), t.ctx), (e) => e.ambiguous === true && /Couldn't reach ComfyUI/.test(e.message));
  assert.equal(t.sleeps.length, 5);
});

test("fillWorkflow throws on a bad node map entry and accepts the node.input string form", () => {
  const wf = { 6: { inputs: {} }, 3: { inputs: {} } };
  const base = { ...DEFAULT_SETTINGS.comfy, nodes: { prompt: "6.text", seed: ["3", "seed"] } };
  const r = fillWorkflow(wf, base, { prompt: "p", seed: 4, prefix: "a" });
  assert.equal(r[6].inputs.text, "p");
  assert.equal(r[3].inputs.seed, 4);
  for (const bad of [{ prompt: "nodot" }, { prompt: ["6"] }, { prompt: [6, "text"] }, { prompt: {} }, { prompt: 5 }, { prompt: ["6", "text", "x"] }]) {
    assert.throws(() => fillWorkflow(wf, { ...base, nodes: bad }, { prompt: "p", seed: 1, prefix: "a" }), /Bad ComfyUI node map entry for prompt/);
  }
  assert.doesNotThrow(() => fillWorkflow(wf, { ...base, nodes: { prompt: ["6", "text"], width: null } }, { prompt: "p", seed: 1, prefix: "a" }));
});

test("lane is gpu", () => assert.equal(makeComfyRunner({ settings: mkSettings() }).lane, "gpu"));

// ---- image to video ----
import { i2vReady } from "../js/tools/comfyui.js";
const I2V_WF = "S:\\Youtube video ideas\\ComfyUI workflows\\animate_i2v.json";
const i2vWf = () => ({ 1: { inputs: { image: "" } }, 2: { inputs: { text: "" } }, 3: { inputs: { noise_seed: 0 } }, 4: { inputs: { filename_prefix: "x" } } });
const i2vSettings = (i2v = {}) => mkSettings({ i2v: { workflow: I2V_WF, nodes: { image: ["1", "image"], prompt: ["2", "text"], seed: ["3", "noise_seed"], output: ["4", "filename_prefix"] }, ...i2v } });
const ajob = () => job({ input: { kind: "animated", prompt: "it turns", out: OUT, sourceFile: "S:\\Film A\\my drawing.png" } });
const animSetup = (post) => {
  const t = setup({ settings: i2vSettings(), history: [hist({ outputs: { 4: { images: [{ filename: "clip_00001_.mp4", subfolder: "broll" }] } } })] });
  t.host.files.set(I2V_WF, JSON.stringify(i2vWf()));
  return t;
};

test("animated: uploads the drawing and fills the image node with the returned name", async () => {
  const t = animSetup();
  const calls = [];
  t.host.spawnScript(async (cmd, args, o, p) => {
    calls.push([cmd, ...args]);
    if (cmd === "curl" && args.includes("overwrite=true")) { p.out(JSON.stringify({ name: "my drawing.png", subfolder: "sub", type: "input" })); return p.exit(0); }
    if (cmd === "curl" && args.includes("POST")) {
      t.bodies.push(await t.host.fs.read(args[args.indexOf("--data-binary") + 1].slice(1), "utf8"));
      p.out(JSON.stringify({ prompt_id: "P1" }) + "\n200"); return p.exit(0);
    }
    if (cmd === "curl" && args.at(-1).endsWith("/queue")) { p.out(inQueue); return p.exit(0); }
    if (cmd === "curl") { p.out(hist({ outputs: { 4: { images: [{ filename: "clip_00001_.mp4", subfolder: "broll" }] } } })); return p.exit(0); }
    if (cmd === "ffmpeg") { await t.host.fs.write(args[args.length - 1], "CROPPED"); return p.exit(0); }
    p.exit(0);
  });
  const r = await t.runner.start(ajob(), t.ctx);
  assert.equal(r.file, OUT);
  assert.deepEqual(calls[0], ["curl", "-sS", "--fail", "-F", "image=@S:\\Film A\\my drawing.png", "-F", "overwrite=true", "http://127.0.0.1:8188/upload/image"]);
  const sent = JSON.parse(t.bodies[0]).prompt;
  assert.equal(sent[1].inputs.image, "sub/my drawing.png");
  assert.equal(sent[2].inputs.text, "it turns");
  assert.match(sent[4].inputs.filename_prefix, /^broll\/sixmin_/);
});

test("animated: an upload failure says so", async () => {
  const t = animSetup();
  t.host.spawnScript(async (cmd, args, o, p) => { p.err("curl: (22) bad"); p.exit(22); });
  await assert.rejects(t.runner.start(ajob(), t.ctx), /^Error: Couldn't send the drawing to ComfyUI: curl: \(22\) bad/);
});

test("animated: refuses when the workflow or image node is missing", async () => {
  const t = setup({ settings: i2vSettings() }); // no animate_i2v.json on disk
  await assert.rejects(t.runner.start(ajob(), t.ctx), /^Error: Set up the image-to-video workflow \(see Probe\): animate_i2v.json isn't in ComfyUI workflows/);
  assert.equal(t.spawns.length, 0);
  const t2 = setup({ settings: i2vSettings({ nodes: { prompt: ["2", "text"], output: ["4", "filename_prefix"] } }) });
  t2.host.files.set(I2V_WF, "{}");
  await assert.rejects(t2.runner.start(ajob(), t2.ctx), /Set up the image-to-video workflow \(see Probe\): comfy\.i2v\.nodes needs image, prompt and output/);
});

test("i2vReady", async () => {
  const host = new FakeHost();
  const c = mkSettings().comfy;
  assert.equal((await i2vReady(host, { ...c, i2v: { workflow: I2V_WF, nodes: {} } })).ok, false);
  host.files.set(I2V_WF, "{}");
  const ok = await i2vReady(host, i2vSettings().comfy);
  assert.deepEqual(ok, { ok: true, why: "" });
});
