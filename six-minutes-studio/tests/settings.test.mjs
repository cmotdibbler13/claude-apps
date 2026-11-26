import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { loadSettings } from "../js/settings.js";

const ROOT = "S:\\Youtube video ideas";
const DEFAULTS = { videoModel: "kling3_0", imageModel: "gpt_image_2", blenderPath: "blender" };

test("missing file gives defaults", async () => {
  const host = new FakeHost();
  assert.deepEqual(await loadSettings(host, ROOT), DEFAULTS);
});
test("bad JSON gives defaults", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await host.fs.write(ROOT + "\\.studio-settings.json", "{nope");
  assert.deepEqual(await loadSettings(host, ROOT), DEFAULTS);
});
test("non-object JSON gives defaults", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await host.fs.write(ROOT + "\\.studio-settings.json", "[1]");
  assert.deepEqual(await loadSettings(host, ROOT), DEFAULTS);
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
