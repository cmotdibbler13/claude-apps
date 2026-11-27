import { test } from "node:test";
import assert from "node:assert/strict";
import { autostart, toolsLine } from "../js/autostart.js";
import { filmsModel } from "../js/ui/films.js";
import { runChecks } from "../js/ui/probe.js";
import { FakeHost } from "./fake-host.mjs";

const starter = (st = "off", fail = false) => { const s = { calls: 0, st, ensure() { this.calls++; return fail ? Promise.reject(new Error("no")) : Promise.resolve(); }, state() { return this.st; } }; return s; };

test("both enabled: both start; one failing doesn't stop the other", async () => {
  const c = starter("off", true), a = starter();
  await autostart({}, { autostart: { comfy: true, stableAudio: true } }, { comfy: c, stableAudio: a });
  assert.equal(c.calls, 1); assert.equal(a.calls, 1);
});

test("a tool turned off isn't started", async () => {
  const c = starter(), a = starter();
  await autostart({}, { autostart: { comfy: false, stableAudio: true } }, { comfy: c, stableAudio: a });
  assert.equal(c.calls, 0); assert.equal(a.calls, 1);
});

test("toolsLine and the Films page show both", () => {
  const line = toolsLine({ comfy: starter("starting"), stableAudio: starter("ready") });
  assert.equal(line, "ComfyUI: Starting… · Stable Audio: Ready");
  assert.equal(toolsLine({ comfy: starter("missing"), stableAudio: starter("music") }), "ComfyUI: Not found · Stable Audio: Music model loaded");
  assert.equal(toolsLine({ comfy: starter("failed"), stableAudio: starter("off") }), "ComfyUI: Didn't start · Stable Audio: Off");
  assert.equal(filmsModel({ root: "S:\\r", films: [], tools: line }).tools, line);
});

test("Probe: ComfyUI and Stable Audio rows that aren't running offer Start now", async () => {
  const h = new FakeHost();
  h.spawnScript((cmd, args, opts, ctl) => { ctl.err("refused"); ctl.exit(7); });
  const rows = await runChecks(h, () => {}, { comfy: { url: "http://127.0.0.1:8188", workflow: "x" }, stableAudio: { url: "http://127.0.0.1:7860" } });
  assert.equal(rows.find((r) => r.name === "ComfyUI").start, "comfy");
  assert.equal(rows.find((r) => r.name === "Stable Audio").start, "stableAudio");
  assert.equal(rows.find((r) => r.name === "Blender").start, undefined);
});
