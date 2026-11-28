import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { loadSettings } from "../js/settings.js";

const ROOT = "S:\\Youtube video ideas";
const DEFAULTS = { videoModel: "kling3_0", imageModel: "gpt_image_2", blenderPath: "blender" };
const base = (s) => ({ videoModel: s.videoModel, imageModel: s.imageModel, blenderPath: s.blenderPath });

test("missing file gives defaults", async () => {
  const host = new FakeHost();
  assert.deepEqual(base(await loadSettings(host, ROOT)), DEFAULTS);
});
test("bad JSON gives defaults", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await host.fs.write(ROOT + "\\.studio-settings.json", "{nope");
  assert.deepEqual(base(await loadSettings(host, ROOT)), DEFAULTS);
});
test("non-object JSON gives defaults", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await host.fs.write(ROOT + "\\.studio-settings.json", "[1]");
  assert.deepEqual(base(await loadSettings(host, ROOT)), DEFAULTS);
});
test("file values merge over defaults", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await host.fs.write(ROOT + "\\.studio-settings.json", JSON.stringify({ videoModel: "veo", extra: 1 }));
  const s = await loadSettings(host, ROOT);
  assert.equal(s.videoModel, "veo");
  assert.equal(s.imageModel, "gpt_image_2");
  assert.equal(s.blenderPath, "blender");
});

test("comfy defaults are present, workflow resolves under root", async () => {
  const s = await loadSettings(new FakeHost(), ROOT);
  assert.equal(s.comfy.url, "http://127.0.0.1:8188");
  assert.equal(s.comfy.outputDir, "C:\\Users\\Jon\\AppData\\Local\\Comfy-Desktop\\ComfyUI-Shared\\output");
  assert.equal(s.comfy.workflow, ROOT + "\\ComfyUI workflows\\broll_ltx.json");
  assert.deepEqual(s.comfy.nodes, {
    prompt: ["364", "text"], width: ["372", "value"], height: ["360", "value"], length: ["362", "value"],
    fps: ["361", "value"], seed: ["339", "noise_seed"], output: ["9999", "filename_prefix"],
  });
  assert.equal(s.comfy.lengthUnit, "seconds");
  assert.deepEqual([s.comfy.width, s.comfy.height, s.comfy.seconds, s.comfy.fps, s.comfy.expectedSeconds], [1920, 1088, 5, 24, 240]);
});
test("partial comfy override keeps the other defaults", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await host.fs.write(ROOT + "\\.studio-settings.json", JSON.stringify({ comfy: { url: "http://10.0.0.2:8188", nodes: { seed: ["1", "s"] } } }));
  const s = await loadSettings(host, ROOT);
  assert.equal(s.comfy.url, "http://10.0.0.2:8188");
  assert.deepEqual(s.comfy.nodes.seed, ["1", "s"]);
  assert.deepEqual(s.comfy.nodes.prompt, ["364", "text"]);
  assert.equal(s.comfy.fps, 24);
  assert.equal(s.comfy.workflow, ROOT + "\\ComfyUI workflows\\broll_ltx.json");
});
test("an explicit comfy.workflow is kept", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await host.fs.write(ROOT + "\\.studio-settings.json", JSON.stringify({ comfy: { workflow: "D:\\w.json" } }));
  assert.equal((await loadSettings(host, ROOT)).comfy.workflow, "D:\\w.json");
});

test("stableAudio defaults are present and partial overrides keep the rest", async () => {
  const s = await loadSettings(new FakeHost(), ROOT);
  assert.equal(s.stableAudio.url, "http://127.0.0.1:7860");
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await host.fs.write(ROOT + "\\.studio-settings.json", JSON.stringify({ stableAudio: { steps: 12 } }));
  const t = await loadSettings(host, ROOT);
  assert.equal(t.stableAudio.url, "http://127.0.0.1:7860");
  assert.equal(t.stableAudio.steps, 12);
});

test("voiceover and mix settings default, and merge from the file", async () => {
  let s = await loadSettings(new FakeHost(), ROOT);
  assert.deepEqual([s.autocuePython, s.stemRemixerDir, s.endCardS, s.mixMusicDb, s.mixSfxDb], ["python", null, 12, -26, -18]);
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await host.fs.write(ROOT + "\\.studio-settings.json", JSON.stringify({ stemRemixerDir: "C:\\Apps\\Stem Remixer", endCardS: 14, mixMusicDb: -28 }));
  s = await loadSettings(host, ROOT);
  assert.deepEqual([s.autocuePython, s.stemRemixerDir, s.endCardS, s.mixMusicDb, s.mixSfxDb], ["python", "C:\\Apps\\Stem Remixer", 14, -28, -18]);
});

test("comfy.i2v defaults its workflow and merges user nodes", async () => {
  const host = new FakeHost();
  host.dirs.add(ROOT);
  const d = await loadSettings(host, ROOT);
  assert.equal(d.comfy.i2v.workflow, ROOT + "\\ComfyUI workflows\\animate_i2v.json");
  assert.deepEqual(d.comfy.i2v.nodes, {});
  await host.fs.write(ROOT + "\\.studio-settings.json", JSON.stringify({ comfy: { i2v: { nodes: { image: ["1", "image"] }, seconds: 3 } } }));
  const s = await loadSettings(host, ROOT);
  assert.deepEqual(s.comfy.i2v.nodes, { image: ["1", "image"] });
  assert.equal(s.comfy.i2v.seconds, 3);
  assert.equal(s.comfy.i2v.workflow, ROOT + "\\ComfyUI workflows\\animate_i2v.json");
});

test("presenter.photos defaults to [] and merges; non-array becomes []", async () => {
  assert.deepEqual((await loadSettings(new FakeHost(), ROOT)).presenter, { photos: [] });
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await host.fs.write(ROOT + "\\.studio-settings.json", JSON.stringify({ presenter: { photos: ["C:\\a.jpg"] } }));
  assert.deepEqual((await loadSettings(host, ROOT)).presenter.photos, ["C:\\a.jpg"]);
  await host.fs.write(ROOT + "\\.studio-settings.json", JSON.stringify({ presenter: { photos: "x" } }));
  assert.deepEqual((await loadSettings(host, ROOT)).presenter.photos, []);
});

test("part 1 defaults: reference scripts and pronunciations file", async () => {
  const s = await loadSettings(new FakeHost(), ROOT);
  assert.deepEqual(s.referenceScripts, [
    "S:\\Youtube video ideas\\Shipping Forecast\\shipping_forecast_script.md",
    "S:\\Youtube video ideas\\London Sewers\\london_sewers_script.md",
  ]);
  assert.equal(s.pronunciationsFile, ROOT + "\\pronunciations.md");
});

test("referenceScripts: one path becomes a list, anything else not a list gives the default", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  const file = ROOT + "\\.studio-settings.json";
  await host.fs.write(file, JSON.stringify({ referenceScripts: "S:\\a.md" }));
  assert.deepEqual((await loadSettings(host, ROOT)).referenceScripts, ["S:\\a.md"]);
  const defaults = (await loadSettings(new FakeHost(), ROOT)).referenceScripts;
  assert.ok(Array.isArray(defaults) && defaults.length > 0);
  for (const v of [5, { a: 1 }, null, true]) {
    await host.fs.write(file, JSON.stringify({ referenceScripts: v }));
    assert.deepEqual((await loadSettings(host, ROOT)).referenceScripts, defaults);
  }
  await host.fs.write(file, JSON.stringify({ referenceScripts: ["S:\\b.md"] }));
  assert.deepEqual((await loadSettings(host, ROOT)).referenceScripts, ["S:\\b.md"]);
});
