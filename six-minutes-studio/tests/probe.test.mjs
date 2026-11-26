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
