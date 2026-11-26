import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
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
  assert.equal(r.detail, "Off: press Start Stable Audio on a film's Review");

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
  if (join) await host.fs.write(ACD + "\\voiceover_join.py", "x");
  if (lineScript) await host.fs.write(ACD + "\\line_script.py", "x");
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
  assert.equal(noFit.detail, want);
});

test("Stem Remixer check fails on a version below 1.9.0", async () => {
  const r = named(await runChecks(await srHost({ version: "1.8.2" }), () => {}, srSettings()), "Stem Remixer");
  assert.equal(r.ok, false);
  assert.equal(r.detail, "Stem Remixer is 1.8.2; update it to 1.9.0 or newer (its Update button)");
  assert.equal(named(await runChecks(await srHost({ version: "1.10.0" }), () => {}, srSettings()), "Stem Remixer").ok, true);
});

test("Autocue join check passes when voiceover_join.py is in autocueDir", async () => {
  const ok = named(await runChecks(await srHost(), () => {}, srSettings()), "Autocue join");
  assert.equal(ok.ok, true);
  const no = named(await runChecks(await srHost({ join: false }), () => {}, srSettings()), "Autocue join");
  assert.equal(no.ok, false);
  assert.match(no.detail, /voiceover_join\.py/);
});

test("Autocue join check also needs line_script.py, which voiceover_join.py imports", async () => {
  const no = named(await runChecks(await srHost({ lineScript: false }), () => {}, srSettings()), "Autocue join");
  assert.equal(no.ok, false);
  assert.match(no.detail, /line_script\.py/);
});
