import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { AUTOCUE_FILES } from "../js/autocue-bundle.js";
import { makeChecks, runChecks } from "../js/ui/probe.js";

const settings = { videoModel: "kling3_0", imageModel: "gpt_image_2", blenderPath: "C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe" };

test("checks Blender at the settings path, ffmpeg and curl with spawn; no Python check", async () => {
  const host = new FakeHost();
  const spawned = [];
  host.spawnScript((cmd, args, o, p) => { spawned.push([cmd, ...args]); p.out(`${cmd} 1.0\nmore`); p.exit(0); });
  host.fs.list = async () => [];
  const names = makeChecks(settings).map((c) => c.name);
  assert.ok(names.includes("curl"));
  assert.ok(!names.some((n) => /python/i.test(n)));
  const results = await runChecks(host, () => {}, settings);
  assert.deepEqual(spawned.slice(0, 3), [[settings.blenderPath, "--version"], ["ffmpeg", "-version"], ["curl", "--version"]]);
  const blender = results.find((r) => r.name === "Blender");
  assert.equal(blender.ok, true);
  assert.equal(blender.detail, `${settings.blenderPath} 1.0`);
});

test("a program that is missing fails its check with the reason", async () => {
  const host = new FakeHost();
  host.spawnScript((cmd, args, o, p) => { if (cmd === "curl") { p.err("spawn curl ENOENT"); p.exit(null); } else { p.out("ok"); p.exit(0); } });
  host.fs.list = async () => [];
  const results = await runChecks(host, () => {}, settings);
  const curl = results.find((r) => r.name === "curl");
  assert.equal(curl.ok, false);
  assert.match(curl.detail, /ENOENT/);
});

const comfySettings = (o = {}) => ({ ...settings, comfy: { url: "http://127.0.0.1:8188", workflow: "S:\\Youtube video ideas\\ComfyUI workflows\\broll_ltx.json", ...o } });
const comfyCheck = (results) => results.find((r) => r.name === "ComfyUI");

test("ComfyUI check follows curl, asks system_stats and shows the version", async () => {
  const host = new FakeHost();
  const s = comfySettings();
  await host.fs.mkdir("S:\\Youtube video ideas\\ComfyUI workflows");
  await host.fs.write(s.comfy.workflow, "{}");
  const spawned = [];
  host.spawnScript((cmd, args, o, p) => {
    spawned.push([cmd, ...args]);
    if (args.includes("http://127.0.0.1:8188/system_stats")) p.out(JSON.stringify({ system: { comfyui_version: "0.3.40" } }));
    else p.out("ok");
    p.exit(0);
  });
  host.fs.list = async () => [];
  const names = makeChecks(s).map((c) => c.name);
  assert.equal(names[names.indexOf("curl") + 1], "ComfyUI");
  const r = comfyCheck(await runChecks(host, () => {}, s));
  assert.ok(spawned.some((a) => JSON.stringify(a) === JSON.stringify(["curl", "-sS", "--fail", "http://127.0.0.1:8188/system_stats"])));
  assert.equal(r.ok, true);
  assert.equal(r.detail, "ComfyUI 0.3.40");
});

test("ComfyUI check says running when the JSON has no version", async () => {
  const host = new FakeHost();
  const s = comfySettings({ url: "http://127.0.0.1:9000/" });
  await host.fs.mkdir("S:\\Youtube video ideas\\ComfyUI workflows");
  await host.fs.write(s.comfy.workflow, "{}");
  const spawned = [];
  host.spawnScript((cmd, args, o, p) => { spawned.push(args); p.out("{}"); p.exit(0); });
  host.fs.list = async () => [];
  const r = comfyCheck(await runChecks(host, () => {}, s));
  assert.ok(spawned.some((a) => a.includes("http://127.0.0.1:9000/system_stats")));
  assert.equal(r.ok, true);
  assert.equal(r.detail, "running");
});

test("ComfyUI check fails when curl fails", async () => {
  const host = new FakeHost();
  const s = comfySettings();
  host.spawnScript((cmd, args, o, p) => {
    if (args.some((a) => /system_stats/.test(a))) { p.err("curl: (7) Failed to connect to 127.0.0.1 port 8188"); p.exit(7); }
    else { p.out("ok"); p.exit(0); }
  });
  host.fs.list = async () => [];
  const r = comfyCheck(await runChecks(host, () => {}, s));
  assert.equal(r.ok, false);
  assert.match(r.detail, /Failed to connect/);
});

test("ComfyUI check fails when the workflow file is missing or its path is not set", async () => {
  const host = new FakeHost();
  host.spawnScript((cmd, args, o, p) => { p.out("{}"); p.exit(0); });
  host.fs.list = async () => [];
  const s = comfySettings();
  const r = comfyCheck(await runChecks(host, () => {}, s));
  assert.equal(r.ok, false);
  assert.equal(r.detail, `Workflow not found: ${s.comfy.workflow}`);
  const unset = comfyCheck(await runChecks(host, () => {}, comfySettings({ workflow: null })));
  assert.equal(unset.ok, false);
  assert.equal(unset.detail, "Workflow path not set yet; open Films first");
});

// ---- Stable Audio and ElevenLabs ----
const saSettings = { ...settings, stableAudio: { url: "http://127.0.0.1:7860" } };
const saCheck = (results) => results.find((r) => r.name === "Stable Audio");

test("Stable Audio check passes on the Small SFX page with /generate", async () => {
  const host = new FakeHost();
  host.spawnScript((cmd, args, o, p) => {
    const url = args.at(-1);
    if (url === "http://127.0.0.1:7860/") { p.out("<html><title>Stable Audio 3 Small SFX</title></html>"); return p.exit(0); }
    if (url === "http://127.0.0.1:7860/gradio_api/info") { p.out('{"named_endpoints":{"/generate":{}}}'); return p.exit(0); }
    p.out("ok"); p.exit(0);
  });
  host.fs.list = async () => [];
  const r = saCheck(await runChecks(host, () => {}, saSettings));
  assert.equal(r.ok, true);
  assert.equal(r.detail, "Ready");
});

test("Stable Audio check: connection refused says how to start it; the Music model says so", async () => {
  const host = new FakeHost();
  host.spawnScript((cmd, args, o, p) => {
    if (String(args.at(-1)).startsWith("http://127.0.0.1:7860")) { p.err("curl: (7) Failed to connect"); return p.exit(7); }
    p.out("ok"); p.exit(0);
  });
  host.fs.list = async () => [];
  const r = saCheck(await runChecks(host, () => {}, saSettings));
  assert.equal(r.ok, false);
  assert.equal(r.detail, "Off: press Start now below, or Start Stable Audio on a film's Review");

  const h2 = new FakeHost();
  h2.spawnScript((cmd, args, o, p) => {
    if (args.at(-1) === "http://127.0.0.1:7860/") { p.out("<title>Stable Audio 3 Music</title>"); return p.exit(0); }
    if (args.at(-1) === "http://127.0.0.1:7860/gradio_api/info") { p.out('{"named_endpoints":{"/generate":{}}}'); return p.exit(0); }
    p.out("ok"); p.exit(0);
  });
  h2.fs.list = async () => [];
  const r2 = saCheck(await runChecks(h2, () => {}, saSettings));
  assert.equal(r2.ok, false);
  assert.match(r2.detail, /Stable Audio Music is running/);
});

test("ElevenLabs tools check lists the flow tools it needs", async () => {
  const host = new FakeHost();
  host.spawnScript((cmd, args, o, p) => { p.out("ok"); p.exit(0); });
  host.fs.list = async () => [];
  host.mcp.listTools = async (server) => (server === "ElevenLabs" ? ["creative_create_flow", "creative_add_flow_node", "creative_run_flow_nodes"] : []);
  const r = (await runChecks(host, () => {}, saSettings)).find((x) => x.name === "ElevenLabs tools");
  assert.equal(r.ok, false);
  assert.equal(r.detail, "missing: creative_get_flow_run_status");
  host.mcp.listTools = async () => ["creative_create_flow", "creative_add_flow_node", "creative_run_flow_nodes", "creative_get_flow_run_status"];
  const ok = (await runChecks(host, () => {}, saSettings)).find((x) => x.name === "ElevenLabs tools");
  assert.equal(ok.ok, true);
});

// ---- Stem Remixer and Autocue join ----
const SRD = "C:\\Apps\\Stem Remixer";
const ACD = "C:\\Users\\Jon\\desktop autocue";
async function srHost({ files = [".venv\\Scripts\\python.exe", "fit.py", "measure.py"], version = "1.9.0", join = true, lineScript = true } = {}) {
  const host = new FakeHost();
  host.spawnScript((cmd, args, o, p) => { p.out("ok"); p.exit(0); });
  host.fs.list = async () => [];
  await host.fs.mkdir(SRD + "\\.venv\\Scripts");
  await host.fs.mkdir(ACD);
  for (const f of files) await host.fs.write(`${SRD}\\${f}`, "x");
  if (version !== null) await host.fs.write(SRD + "\\VERSION", version + "\n");
  if (join) await host.fs.write(ACD + "\\voiceover_join.py", join === "old" ? "old" : AUTOCUE_FILES["voiceover_join.py"]);
  if (lineScript) await host.fs.write(ACD + "\\line_script.py", AUTOCUE_FILES["line_script.py"]);
  await host.fs.write(ACD + "\\take_checks.py", "def decode(path, rate=RATE):\n");
  return host;
}
const srSettings = (o = {}) => ({ ...settings, stemRemixerDir: SRD, autocueDir: ACD, ...o });
const named = (results, name) => results.find((r) => r.name === name);

test("Stem Remixer check passes with its Python, fit.py and measure.py, and shows the version", async () => {
  const r = named(await runChecks(await srHost(), () => {}, srSettings()), "Stem Remixer");
  assert.equal(r.ok, true);
  assert.equal(r.detail, "Stem Remixer 1.9.0");
  const nov = named(await runChecks(await srHost({ version: null }), () => {}, srSettings()), "Stem Remixer");
  assert.equal(nov.ok, true);
});

test("Stem Remixer check fails with the settings text when the folder or a file is missing", async () => {
  const want = "Set stemRemixerDir in .studio-settings.json to your Stem Remixer folder (1.9.0 or newer).";
  const unset = named(await runChecks(await srHost(), () => {}, srSettings({ stemRemixerDir: null })), "Stem Remixer");
  assert.equal(unset.ok, false);
  assert.equal(unset.detail, want);
  const noFit = named(await runChecks(await srHost({ files: [".venv\\Scripts\\python.exe", "measure.py"] }), () => {}, srSettings()), "Stem Remixer");
  assert.equal(noFit.ok, false);
  assert.equal(noFit.detail, `fit.py isn't in ${SRD}. Press Update in Stem Remixer (1.9.0 or newer).`);
  const noPy = named(await runChecks(await srHost({ files: ["fit.py", "measure.py"] }), () => {}, srSettings()), "Stem Remixer");
  assert.equal(noPy.detail, `Stem Remixer's Python isn't at ${SRD}\\.venv\\Scripts\\python.exe. Run Install.cmd in ${SRD}, then Probe again.`);
});

test("Probe re-reads settings before running, so a setting added while the app is open counts", async () => {
  const { mountProbe } = await import("../js/ui/probe.js");
  const host = new FakeHost();
  host.spawnScript((cmd, args, o, p) => { p.out("ok"); p.exit(0); });
  host.fs.list = async () => [];
  const settings = { ...srSettings({ stemRemixerDir: null }) };
  const rows = [];
  const list = { replaceChildren() {}, append(li) { rows.push(li); } };
  const button = {};
  globalThis.document ??= { createElement: () => ({ append() {}, set textContent(v) { this.t = v; }, className: "" }) };
  let reloaded = 0;
  mountProbe(host, button, list, () => settings, async () => { reloaded++; settings.stemRemixerDir = SRD; });
  await button.onclick();
  assert.equal(reloaded, 1);
});

test("a neutral result shows as a neutral row, not a red failure; Probe tells the app when it's done", async () => {
  const { probeRow, mountProbe } = await import("../js/ui/probe.js");
  const mk = () => { const el = { kids: [], className: "", textContent: "", append(...k) { this.kids.push(...k); } }; return el; };
  const saved = globalThis.document;
  globalThis.document = { createElement: mk };
  try {
    const n = probeRow({ name: "Animate workflow", ok: false, neutral: true, detail: "Not set up (only needed for Animate with ComfyUI): x" });
    assert.equal(n.className, "neutral");
    assert.equal(n.kids[0].textContent, "Optional");
    const f = probeRow({ name: "Blender", ok: false, detail: "exit 1" });
    assert.equal(f.className, "fail");
    assert.equal(f.kids[0].textContent, "Fail");
    assert.equal(probeRow({ name: "curl", ok: true, detail: "ok" }).className, "pass");
    const host = new FakeHost();
    host.spawnScript((cmd, args, o, p) => { p.out("ok"); p.exit(0); });
    host.fs.list = async () => [];
    const button = {};
    let done = null;
    mountProbe(host, button, { replaceChildren() {}, append() {} }, () => srSettings(), null, () => ({}), (results) => { done = results; });
    await button.onclick();
    assert.ok(Array.isArray(done) && done.some((r) => r.name === "Animate workflow"));
  } finally { globalThis.document = saved; }
});

test("Stem Remixer check fails on a version below 1.9.0", async () => {
  const r = named(await runChecks(await srHost({ version: "1.8.2" }), () => {}, srSettings()), "Stem Remixer");
  assert.equal(r.ok, false);
  assert.equal(r.detail, "Stem Remixer is 1.8.2; update it to 1.9.0 or newer (its Update button)");
  assert.equal(named(await runChecks(await srHost({ version: "1.10.0" }), () => {}, srSettings()), "Stem Remixer").ok, true);
});

test("Autocue join check passes when the join files match Studio's copy; missing or old offers Install", async () => {
  const ok = named(await runChecks(await srHost(), () => {}, srSettings()), "Autocue join");
  assert.equal(ok.ok, true);
  assert.equal(ok.detail, "Join script up to date");
  const no = named(await runChecks(await srHost({ join: false }), () => {}, srSettings()), "Autocue join");
  assert.deepEqual([no.ok, no.detail, no.install], [false, "The join script isn't installed. Press Install join script below.", true]);
  const old = named(await runChecks(await srHost({ join: "old" }), () => {}, srSettings()), "Autocue join");
  assert.deepEqual([old.ok, old.detail, old.install], [false, "The join script is out of date. Press Install join script below.", true]);
  const noLine = named(await runChecks(await srHost({ lineScript: false }), () => {}, srSettings()), "Autocue join");
  assert.equal(noLine.install, true);
});

test("Animate workflow row: ready, or says what is missing", async () => {
  const host = new FakeHost();
  host.spawnScript((cmd, args, o, p) => { p.out("{}"); p.exit(0); });
  host.fs.list = async () => [];
  const wf = "S:\\Youtube video ideas\\ComfyUI workflows\\animate_i2v.json";
  const nodes = { image: ["1", "image"], prompt: ["2", "text"], output: ["3", "filename_prefix"] };
  const get = async (s) => (await runChecks(host, () => {}, s)).find((r) => r.name === "Animate workflow");
  const names = makeChecks(comfySettings()).map((c) => c.name);
  assert.equal(names[names.indexOf("ComfyUI") + 1], "Animate workflow");
  const miss = await get(comfySettings({ i2v: { workflow: wf, nodes } }));
  assert.equal(miss.ok, false);
  // Not a failure: animation is optional, so the row is neutral and says why.
  assert.equal(miss.neutral, true);
  assert.equal(miss.detail, "Not set up (only needed for Animate with ComfyUI): animate_i2v.json isn't in ComfyUI workflows");
  host.files.set(wf, "{}");
  const nonodes = await get(comfySettings({ i2v: { workflow: wf, nodes: { prompt: ["2", "text"] } } }));
  assert.equal(nonodes.ok, false);
  assert.equal(nonodes.neutral, true);
  assert.match(nonodes.detail, /^Not set up \(only needed for Animate with ComfyUI\): comfy\.i2v\.nodes needs image, prompt and output/);
  const ok = await get(comfySettings({ i2v: { workflow: wf, nodes } }));
  assert.equal(ok.ok, true);
  assert.equal(ok.detail, "ready");
  assert.ok(!ok.neutral);
  // Other failures stay failures.
  const comfy = (await runChecks(host, () => {}, comfySettings({ i2v: { workflow: wf, nodes } }))).find((r) => r.name === "Stem Remixer");
  assert.ok(!comfy.neutral);
});

test("Higgsfield tools check wants upload and estimate tools", async () => {
  const host = new FakeHost();
  host.fs.list = async () => [];
  host.spawnScript((c, a, o, p) => { p.out("ok"); p.exit(0); });
  host.mcpTools = { Higgsfield: ["generate_video", "generate_image", "jobs_wait", "models_explore"] };
  const r = (await runChecks(host, () => {}, settings)).find((x) => x.name === "Higgsfield tools");
  assert.equal(r.ok, false);
  assert.match(r.detail, /media_upload, media_confirm, estimate_image_cost, estimate_video_cost/);
});

test("Presenter photos row", async () => {
  const run = async (photos, files = []) => {
    const host = new FakeHost();
    host.fs.list = async () => [];
    host.spawnScript((c, a, o, p) => { p.out("ok"); p.exit(0); });
    for (const f of files) { await host.fs.mkdir(f.replace(/[\\/][^\\/]*$/, "")); await host.fs.write(f, "x"); }
    const s = photos === undefined ? settings : { ...settings, presenter: { photos } };
    return (await runChecks(host, () => {}, s)).find((x) => x.name === "Presenter photos");
  };
  let r = await run(undefined);
  assert.deepEqual([r.ok, r.detail], [false, "Add presenter.photos in .studio-settings.json"]);
  r = await run([]);
  assert.equal(r.detail, "Add presenter.photos in .studio-settings.json");
  r = await run(["C:\\p\\a.jpg"], ["C:\\p\\a.jpg"]);
  assert.deepEqual([r.ok, r.detail], [true, "1 photos"]);
  r = await run(["C:\\p\\a.jpg", "C:\\p\\b.jpg"], ["C:\\p\\a.jpg", "C:\\p\\b.jpg"]);
  assert.equal(r.detail, "2 photos");
  r = await run(["C:\\p\\a.jpg", "C:\\p\\b.jpg"], ["C:\\p\\a.jpg"]);
  assert.deepEqual([r.ok, r.detail], [false, "Not found: C:\\p\\b.jpg"]);
  r = await run(["a", "b", "c"]);
  assert.equal(r.ok, false);
});

test("Reference script: passes with the first referenceScripts file that exists, fails naming the setting", async () => {
  const host = new FakeHost();
  host.spawnScript((cmd, args, o, p) => { p.out("ok"); p.exit(0); });
  await host.fs.mkdir("S:\\ref");
  await host.fs.write("S:\\ref\\b.md", "x");
  const s = { ...settings, referenceScripts: ["S:\\ref\\a.md", "S:\\ref\\b.md"], pronunciationsFile: "S:\\ref\\p.md" };
  const ok = named(await runChecks(host, () => {}, s), "Reference script");
  assert.equal(ok.ok, true);
  assert.equal(ok.detail, "S:\\ref\\b.md");
  const none = named(await runChecks(host, () => {}, { ...s, referenceScripts: ["S:\\ref\\a.md"] }), "Reference script");
  assert.equal(none.ok, false);
  assert.match(none.detail, /referenceScripts/);
  assert.equal(none.detail, "None of the referenceScripts in .studio-settings.json is there. Set referenceScripts to one or more finished scripts.");
});

test("Pronunciations: passes when the file exists, else a warning (not a failure)", async () => {
  const { probeRow } = await import("../js/ui/probe.js");
  const host = new FakeHost();
  host.spawnScript((cmd, args, o, p) => { p.out("ok"); p.exit(0); });
  await host.fs.mkdir("S:\\ref");
  const s = { ...settings, referenceScripts: [], pronunciationsFile: "S:\\ref\\pronunciations.md" };
  const miss = named(await runChecks(host, () => {}, s), "Pronunciations");
  assert.equal(miss.ok, false);
  assert.equal(miss.warn, true);
  assert.equal(miss.detail, "No pronunciations file yet: Studio starts one when you approve a Part 1.");
  const el = () => ({ append(...k) { this.kids = k; }, className: "", textContent: "" });
  const saved = globalThis.document;
  globalThis.document = { createElement: el };
  try {
    const li = probeRow(miss);
    assert.equal(li.className, "warn");
    assert.equal(li.kids[0].textContent, "Warning");
  } finally { globalThis.document = saved; }
  await host.fs.write("S:\\ref\\pronunciations.md", "## Storms\n");
  const ok = named(await runChecks(host, () => {}, s), "Pronunciations");
  assert.equal(ok.ok, true);
  assert.equal(ok.detail, "S:\\ref\\pronunciations.md");
});

// ---- Task 7: this computer, project folder, fix buttons ----
import { fixesFor, choicePatch, roleLine, saveRoot, choosePanel, mountProbe, probeRow, ROLE_QUESTION, ON_DESKTOP, GRAPHICS_ROWS } from "../js/ui/probe.js";
import { GET_IT } from "../js/findtools.js";

function withDom(fn) {
  const mk = (tag) => {
    const el = { tag, attrs: {}, children: [], listeners: {}, style: {}, className: "", textContent: "", value: "",
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
      addEventListener(k, f) { (this.listeners[k] ||= []).push(f); },
      append(...k) { this.children.push(...k); }, replaceChildren(...k) { this.children = [...k]; } };
    Object.setPrototypeOf(el, globalThis.Node.prototype);
    return el;
  };
  const saved = { d: globalThis.document, n: globalThis.Node };
  globalThis.Node = class {};
  globalThis.document = { createElement: mk, createTextNode: (t) => ({ t }) };
  return Promise.resolve().then(fn).finally(() => { globalThis.document = saved.d; globalThis.Node = saved.n; });
}
const all = (el, pred, out = []) => {
  if (!el || typeof el !== "object") return out;
  if (pred(el)) out.push(el);
  for (const c of el.children ?? []) all(c, pred, out);
  return out;
};
const textOf = (el) => (el.textContent ?? "") + (el.children ?? []).map((c) => (c.t ?? textOf(c))).join("");
const buttonsIn = (el) => all(el, (x) => x.tag === "button");
const byText = (el, t) => buttonsIn(el).find((b) => textOf(b) === t);
const press = async (el) => { for (const f of el.listeners.click ?? []) await f({}); if (el.onclick) await el.onclick({}); };
const fakeList = () => { const l = { children: [], replaceChildren(...k) { l.children = [...k]; }, append(...k) { l.children.push(...k); } }; return l; };
const allOk = (host) => { host.spawnScript((cmd, args, o, p) => { p.out("ok 1.0"); p.exit(0); }); host.fs.list = async () => []; };

test("the project folder row replaces the two root rows and passes with the path in use", async () => {
  const names = makeChecks({}, "N:\\Youtube video ideas").map((c) => c.name);
  assert.ok(!names.includes("S: root readable") && !names.includes("UNC root readable"));
  assert.equal(names[0], "Project folder");
  const host = new FakeHost();
  allOk(host);
  const rows = await runChecks(host, () => {}, {}, "N:\\Youtube video ideas");
  const pf = named(rows, "Project folder");
  assert.equal(pf.ok, true);
  assert.equal(pf.detail, "N:\\Youtube video ideas");
  const gone = named(await runChecks(host, () => {}, {}, "N:\\Youtube video ideas", { chosenMissing: "M:\\Films" }), "Project folder");
  assert.equal(gone.ok, false);
  assert.equal(gone.detail, "Can't reach the project folder you chose (M:\\Films)");
  assert.equal(gone.chooseRoot, true);
  host.fs.list = async () => { throw new Error("ENOENT"); };
  const none = named(await runChecks(host, () => {}, {}, "S:\\Youtube video ideas"), "Project folder");
  assert.equal(none.ok, false);
  assert.equal(none.chooseRoot, true);
});

test("on a laptop the graphics rows are neutral On the desktop and aren't run; Set up here anyway runs one", async () => {
  assert.deepEqual(GRAPHICS_ROWS, ["Blender", "ComfyUI", "Animate workflow", "Stable Audio"]);
  const host = new FakeHost();
  const spawned = [];
  host.spawnScript((cmd, args, o, p) => { spawned.push(cmd); p.out("ok"); p.exit(0); });
  host.fs.list = async () => [];
  const s = { ...settings, role: "laptop" };
  let rows = await runChecks(host, () => {}, s);
  for (const n of GRAPHICS_ROWS) {
    const r = named(rows, n);
    assert.equal(r.ok, false);
    assert.equal(r.neutral, true);
    assert.equal(r.onDesktop, true);
    assert.equal(r.detail, ON_DESKTOP);
    assert.deepEqual(fixesFor(r), []);
  }
  assert.ok(!spawned.includes(settings.blenderPath));
  rows = await runChecks(host, () => {}, s, undefined, { here: new Set(["Blender"]) });
  assert.equal(named(rows, "Blender").ok, true);
  assert.ok(spawned.includes(settings.blenderPath));
  assert.equal(named(rows, "ComfyUI").onDesktop, true);
  // On the desktop nothing changes.
  rows = await runChecks(host, () => {}, settings);
  assert.ok(!rows.some((r) => r.onDesktop));
  await withDom(() => {
    const li = probeRow({ name: "Blender", ok: false, neutral: true, onDesktop: true, detail: ON_DESKTOP });
    assert.equal(li.className, "neutral");
    assert.equal(textOf(li.children[2]), ON_DESKTOP);
  });
});

test("fix buttons by kind for failing rows; passing and neutral rows get none", () => {
  const f = (name, o = {}) => fixesFor({ name, ok: false, detail: "x", ...o }).map((x) => [x.type, x.kind, x.label]);
  const choose = (k) => ["choose", k, "Choose where it is…"];
  const get = (k) => ["get", k, "Get it"];
  const install = (k) => ["install", k, "Install here…"];
  assert.deepEqual(f("ffmpeg"), [choose("ffmpeg"), get("ffmpeg")]);
  assert.deepEqual(f("Blender"), [choose("blender"), get("blender")]);
  assert.deepEqual(f("ComfyUI"), [get("comfyui")]);
  assert.deepEqual(f("Stable Audio"), [["get", "pinokio", "Get it: Pinokio"]]);
  assert.deepEqual(f("Stem Remixer"), [choose("stemremixer"), install("stemremixer")]);
  assert.deepEqual(f("Autocue join"), [choose("autocue"), install("autocue")]);
  assert.deepEqual(f("Python for installs"), [choose("python"), get("python")]);
  assert.deepEqual(f("Project folder"), [["root", null, "Choose…"]]);
  assert.deepEqual(f("Project folder", { ok: true }), [["root", null, "Choose…"]]);
  assert.deepEqual(f("curl"), []);
  assert.deepEqual(fixesFor({ name: "ffmpeg", ok: true, detail: "ok" }), []);
  assert.deepEqual(fixesFor({ name: "Animate workflow", ok: false, neutral: true, detail: "x" }), []);
  for (const x of fixesFor({ name: "Blender", ok: false })) if (x.type === "get") assert.equal(x.url, GET_IT.blender);
  assert.equal(fixesFor({ name: "Stable Audio", ok: false })[0].url, "https://pinokio.computer/");
});

test("a choice saves the setting for its kind", () => {
  assert.deepEqual(choicePatch("ffmpeg", "D:\\ffmpeg\\bin\\ffmpeg.exe"), { ffmpegPath: "D:\\ffmpeg\\bin\\ffmpeg.exe" });
  assert.deepEqual(choicePatch("blender", "D:\\B\\blender.exe"), { blenderPath: "D:\\B\\blender.exe" });
  assert.deepEqual(choicePatch("python", "C:\\Py\\python.exe"), { autocuePython: "C:\\Py\\python.exe" });
  assert.deepEqual(choicePatch("autocue", "D:\\Apps\\Autocue Studio"), { autocueDir: "D:\\Apps\\Autocue Studio", autocueRecordings: "D:\\Apps\\Autocue Studio\\Recordings" });
  assert.deepEqual(choicePatch("stemremixer", "D:\\Apps\\Stem Remixer"), { stemRemixerDir: "D:\\Apps\\Stem Remixer" });
});

test("this computer's line names it and its role", () => {
  assert.equal(roleLine("LAPTOP-JON", "laptop"), "LAPTOP-JON · Laptop (scripts and audio)");
  assert.equal(roleLine("DESK", "desktop"), "DESK · Desktop (everything)");
  assert.equal(roleLine("DESK", undefined), "DESK · Desktop (everything)");
});

const setupFor = (o = {}) => {
  const calls = [];
  return { calls, setup: {
    computer: () => "LAPTOP-JON", roleNeeded: async () => false, chosenMissing: () => null,
    save: async (patch) => { calls.push(["save", patch]); }, chooseRoot: async (p) => { calls.push(["root", p]); },
    install: async (opts) => { calls.push(["install", opts]); }, ...o } };
};

test("Probe asks the role question first when needed, and only that, until answered", () => withDom(async () => {
  assert.equal(ROLE_QUESTION, "Is this computer the desktop (everything) or a laptop (scripts and audio)?");
  const host = new FakeHost();
  const spawned = [];
  host.spawnScript((cmd, args, o, p) => { spawned.push(cmd); p.out("ok"); p.exit(0); });
  host.fs.list = async () => [];
  let needed = true;
  const s = { ...settings };
  const { calls, setup } = setupFor({ roleNeeded: async () => needed, save: async (patch) => { calls.push(["save", patch]); needed = false; Object.assign(s, patch); } });
  const list = fakeList();
  const button = {};
  mountProbe(host, button, list, () => s, null, () => ({}), null, null, () => null, setup);
  await button.onclick();
  assert.equal(list.children.length, 1);
  assert.match(textOf(list.children[0]), /Is this computer the desktop \(everything\) or a laptop \(scripts and audio\)\?/);
  assert.equal(spawned.length, 0);
  assert.deepEqual(buttonsIn(list.children[0]).map(textOf), ["Desktop (everything)", "Laptop (scripts and audio)"]);
  await press(byText(list.children[0], "Laptop (scripts and audio)"));
  assert.deepEqual(calls[0], ["save", { role: "laptop" }]);
  // Probe ran again: This computer first, then the checks.
  const first = list.children[0];
  assert.match(textOf(first), /This computer/);
  assert.match(textOf(first), /LAPTOP-JON · Laptop \(scripts and audio\)/);
  assert.ok(list.children.length > 5);
}));

test("This computer's Change saves the other role, then Probe runs again", () => withDom(async () => {
  const host = new FakeHost();
  allOk(host);
  const { calls, setup } = setupFor();
  const list = fakeList();
  const button = {};
  let runs = 0;
  mountProbe(host, button, list, () => { runs++; return { ...settings, role: "desktop" }; }, null, () => ({}), null, null, () => null, setup);
  await button.onclick();
  const first = list.children[0];
  assert.match(textOf(first), /Desktop \(everything\)/);
  await press(byText(first, "Change"));
  await press(byText(first, "Laptop (scripts and audio)"));
  assert.deepEqual(calls.at(-1), ["save", { role: "laptop" }]);
  assert.equal(runs, 2);
}));

test("Choose… on the project folder lists the folders found, marks the one in use, and saves a pick", () => withDom(async () => {
  const host = new FakeHost();
  allOk(host);
  const raw = new FakeHost();
  await raw.fs.mkdir("N:\\Youtube video ideas");
  await raw.fs.mkdir("S:\\Youtube video ideas");
  const { calls, setup } = setupFor({ rawHost: () => raw });
  const list = fakeList();
  const button = {};
  mountProbe(host, button, list, () => settings, null, () => ({}), null, null, () => "S:\\Youtube video ideas", setup);
  await button.onclick();
  const i = list.children.findIndex((li) => /^PassProject folder/.test(textOf(li)));
  const row = list.children[i + 1];
  await press(byText(row, "Choose…"));
  const picks = buttonsIn(row).map(textOf);
  assert.ok(picks.includes("N:\\Youtube video ideas"));
  assert.ok(picks.includes("S:\\Youtube video ideas (in use)"));
  await press(byText(row, "N:\\Youtube video ideas"));
  assert.deepEqual(calls.at(-1), ["root", "N:\\Youtube video ideas"]);
}));

test("saveRoot keeps the choice on this computer and records it for the others", async () => {
  const host = new FakeHost();
  host.spawnScript((cmd, args, o, p) => {
    const a = args.join(" ");
    if (/APPDATA/.test(a)) { p.out("C:\\Users\\J\\AppData\\Roaming"); p.exit(0); } else p.exit(1);
  });
  const N = "N:\\Youtube video ideas";
  await host.fs.mkdir(N);
  await host.fs.write(N + "\\.studio-settings.json", JSON.stringify({ blenderPath: "blender" }));
  await saveRoot(host, "LAPTOP-JON", N, { now: new Date(2026, 10, 28, 9).getTime() });
  const local = JSON.parse(await host.fs.read("C:\\Users\\J\\AppData\\Roaming\\Six Minutes Studio\\computer.json", "utf8"));
  assert.equal(local.root, N);
  const saved = JSON.parse(await host.fs.read(N + "\\.studio-settings.json", "utf8"));
  assert.equal(saved.blenderPath, "blender");
  assert.deepEqual(saved.computers, { "LAPTOP-JON": { root: N } });
});

test("Choose where it is…: candidates as buttons plus a typed path; a failed check shows why and saves nothing", () => withDom(async () => {
  const host = new FakeHost();
  host.spawnScript((cmd, args, o, p) => {
    if (cmd === "where") { p.out("C:\\ff\\ffmpeg.exe\r\n"); p.exit(0); return; }
    if (cmd === "C:\\ff\\ffmpeg.exe") { p.out("ffmpeg version 7.1"); p.exit(0); return; }
    p.err("not found"); p.exit(1);
  });
  await host.fs.mkdir("C:\\ff");
  await host.fs.write("C:\\ff\\ffmpeg.exe", "");
  const saves = [];
  let reran = 0;
  const panel = await choosePanel(host, "ffmpeg", async (patch) => { saves.push(patch); }, async () => { reran++; });
  const typed = all(panel, (x) => x.tag === "input")[0];
  typed.value = "D:\\nope\\ffmpeg.exe";
  await press(byText(panel, "Use this"));
  assert.equal(saves.length, 0);
  assert.match(textOf(panel), /exit 1: not found/);
  await press(byText(panel, "C:\\ff\\ffmpeg.exe"));
  assert.deepEqual(saves, [{ ffmpegPath: "C:\\ff\\ffmpeg.exe" }]);
  assert.equal(reran, 1);
}));

test("a failing ffmpeg row in Probe gets Choose where it is… and Get it; Get it opens the page", () => withDom(async () => {
  const host = new FakeHost();
  const spawned = [];
  host.spawnScript((cmd, args, o, p) => { spawned.push([cmd, ...args]); if (cmd === "ffmpeg") { p.err("ENOENT"); p.exit(null); } else { p.out("ok"); p.exit(0); } });
  host.fs.list = async () => [];
  const { setup } = setupFor();
  const list = fakeList();
  const button = {};
  mountProbe(host, button, list, () => settings, null, () => ({}), null, null, () => null, setup);
  await button.onclick();
  const i = list.children.findIndex((li) => /^Failffmpeg/.test(textOf(li)));
  assert.ok(i > 0);
  const fix = list.children[i + 1];
  assert.deepEqual(buttonsIn(fix).map(textOf), ["Choose where it is…", "Get it"]);
  await press(byText(fix, "Get it"));
  assert.deepEqual(spawned.at(-1), ["cmd", "/c", "start", "", GET_IT.ffmpeg]);
}));

test("Autocue's Install here… without a working Python says Set up Python first and does nothing else", () => withDom(async () => {
  const host = new FakeHost();
  host.spawnScript((cmd, args, o, p) => { if (cmd === "python") { p.err("not found"); p.exit(1); } else { p.out("ok"); p.exit(0); } });
  host.fs.list = async () => [];
  const { calls, setup } = setupFor();
  const list = fakeList();
  const button = {};
  mountProbe(host, button, list, () => ({ ...settings, autocueDir: "D:\\nowhere" }), null, () => ({}), null, null, () => null, setup);
  await button.onclick();
  const py = list.children.find((li) => /^FailPython for installs/.test(textOf(li)));
  assert.ok(py, "a Python for installs row appears when Autocue join fails");
  const i = list.children.findIndex((li) => /^FailAutocue join/.test(textOf(li)));
  const fix = list.children[i + 1];
  await press(byText(fix, "Install here…"));
  assert.ok(/Set up Python first/.test(textOf(fix)));
  assert.equal(calls.filter((c) => c[0] === "install").length, 0);
}));

test("Stem Remixer's Install here… goes ahead with no Python (its installer sees to Python); no Python row for it alone", () => withDom(async () => {
  const host = await srHost();
  host.spawnScript((cmd, args, o, p) => { if (cmd === "python") { p.err("not found"); p.exit(1); } else { p.out("ok"); p.exit(0); } });
  const { calls, setup } = setupFor();
  const list = fakeList();
  const button = {};
  // Autocue join passes here, so only Stem Remixer fails: no Python row.
  const results = [];
  mountProbe(host, button, list, () => srSettings({ stemRemixerDir: null }), null, () => ({}), (r) => { results.push(...r); }, null, () => null, setup);
  await button.onclick();
  assert.equal(results.find((r) => r.name === "Autocue join").ok, true);
  assert.ok(!results.some((r) => r.name === "Python for installs"));
  const i = list.children.findIndex((li) => /^FailStem Remixer/.test(textOf(li)));
  const fix = list.children[i + 1];
  await press(byText(fix, "Install here…"));
  assert.ok(!/Set up Python first/.test(textOf(fix)));
  await press(byText(fix, "Install"));
  assert.equal(calls.filter((c) => c[0] === "install").length, 1);
  assert.equal(calls.find((c) => c[0] === "install")[1].app, "stemremixer");
}));

test("a role save that fails says so in the row", () => withDom(async () => {
  const host = new FakeHost();
  allOk(host);
  const { setup } = setupFor({ roleNeeded: async () => true, save: async () => { throw new Error("disk full"); } });
  const list = fakeList();
  const button = {};
  mountProbe(host, button, list, () => settings, null, () => ({}), null, null, () => null, setup);
  await button.onclick();
  await press(byText(list.children[0], "Laptop (scripts and audio)"));
  assert.match(textOf(list.children[0]), /Couldn't save: disk full/);
  const s2 = setupFor({ save: async () => { throw new Error("locked"); } }).setup;
  mountProbe(host, button, list, () => settings, null, () => ({}), null, null, () => null, s2);
  await button.onclick();
  const first = list.children[0];
  await press(byText(first, "Change"));
  await press(byText(first, "Laptop (scripts and audio)"));
  assert.match(textOf(first), /Couldn't save: locked/);
}));

test("saveRoot says which write failed", async () => {
  const host = new FakeHost();
  host.spawnScript((cmd, args, o, p) => { if (/APPDATA/.test(args.join(" "))) { p.out("C:\\A"); p.exit(0); } else p.exit(1); });
  const N = "N:\\Youtube video ideas";
  await host.fs.mkdir(N);
  await host.fs.write(N + "\\.studio-settings.json", "{ not json");
  await assert.rejects(saveRoot(host, "LAPTOP-JON", N), (e) => e.where === "shared");
});

test("Install here… asks for the parent folder (D:\\Apps when D: exists), shows each step, then Probe runs again", () => withDom(async () => {
  const host = new FakeHost();
  allOk(host);
  await host.fs.mkdir("D:\\");
  const steps = [];
  const { calls, setup } = setupFor({ install: async (opts) => { calls.push(["install", { app: opts.app, parent: opts.parent, python: opts.python }]); opts.onStep("Downloading…"); steps.push("x"); } });
  const list = fakeList();
  const button = {};
  let runs = 0;
  mountProbe(host, button, list, () => { runs++; return { ...settings, stemRemixerDir: null, autocuePython: "python" }; }, null, () => ({}), null, null, () => null, setup);
  await button.onclick();
  const i = list.children.findIndex((li) => /^FailStem Remixer/.test(textOf(li)));
  const fix = list.children[i + 1];
  await press(byText(fix, "Install here…"));
  const field = all(fix, (x) => x.tag === "input")[0];
  assert.equal(field.value, "D:\\Apps");
  await press(byText(fix, "Install"));
  assert.deepEqual(calls.at(-1), ["install", { app: "stemremixer", parent: "D:\\Apps", python: "python" }]);
  assert.equal(runs, 2);
}));
