import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { makeComfyStarter, comfyExe, MSG_COMFY_MISSING, MSG_COMFY_DIDNT_START, EXE_CANDIDATES } from "../js/tools/comfystart.js";
import { loadSettings, DEFAULT_SETTINGS } from "../js/settings.js";

const URL = "http://127.0.0.1:8188";
const settings = (comfy = {}) => ({ comfy: { url: URL, ...comfy } });
const noSleep = async () => {};

// curl answers per `up()`; the ComfyUI exe stays running until killed (or exits when told).
function host({ up = () => false, exeExits = false } = {}) {
  const h = new FakeHost();
  h.spawned = []; h.killed = [];
  h.spawnScript((cmd, args, opts, ctl) => {
    if (cmd === "curl") { if (up()) { ctl.out("{}"); ctl.exit(0); } else { ctl.err("refused"); ctl.exit(7); } return; }
    h.spawned.push(cmd);
    if (exeExits) ctl.exit(1);
  });
  const spawn = h.spawn.bind(h);
  h.spawn = (cmd, args, opts) => { const p = spawn(cmd, args, opts); const k = p.kill; p.kill = () => { h.killed.push(cmd); return k(); }; return p; };
  return h;
}

test("ComfyUI already running: ready, nothing spawned", async () => {
  const h = host({ up: () => true });
  const s = makeComfyStarter({ settings: settings(), sleep: noSleep });
  await s.ensure(h);
  assert.equal(s.state(), "ready");
  assert.deepEqual(h.spawned, []);
});

test("ComfyUI Desktop not found anywhere: missing, with the copy, nothing spawned", async () => {
  const h = host();
  const s = makeComfyStarter({ settings: settings(), sleep: noSleep });
  await assert.rejects(s.ensure(h), { message: MSG_COMFY_MISSING });
  assert.equal(s.state(), "missing");
  assert.equal(s.message(), "ComfyUI Desktop wasn't found. Set comfy.exe in .studio-settings.json.");
  assert.deepEqual(h.spawned, []);
});

test("starts the first exe that exists and becomes ready when ComfyUI answers", async () => {
  let polls = 0;
  const h = host({ up: () => ++polls > 3 });
  await h.fs.mkdir("C:\\Users\\Jon\\AppData\\Local\\Programs\\ComfyUI");
  await h.fs.write(EXE_CANDIDATES[1], "exe");
  const s = makeComfyStarter({ settings: settings(), sleep: noSleep });
  await s.ensure(h);
  assert.equal(s.state(), "ready");
  assert.deepEqual(h.spawned, [EXE_CANDIDATES[1]]);
});

test("comfy.exe in settings wins", async () => {
  const h = host();
  await h.fs.mkdir("D:\\Apps"); await h.fs.write("D:\\Apps\\ComfyUI.exe", "exe");
  await h.fs.mkdir("C:\\Users\\Jon\\AppData\\Local\\Programs\\ComfyUI"); await h.fs.write(EXE_CANDIDATES[1], "exe");
  assert.equal(await comfyExe(h, { exe: "D:\\Apps\\ComfyUI.exe" }), "D:\\Apps\\ComfyUI.exe");
  assert.equal(await comfyExe(h, {}), EXE_CANDIDATES[1]);
});

test("the app exits before ComfyUI answers: failed with the copy, no long wait", async () => {
  const h = host({ exeExits: true });
  await h.fs.mkdir("C:\\Users\\Jon\\AppData\\Local\\Programs\\ComfyUI"); await h.fs.write(EXE_CANDIDATES[1], "exe");
  let sleeps = 0;
  const s = makeComfyStarter({ settings: settings(), sleep: async () => { sleeps++; } });
  await assert.rejects(s.ensure(h), { message: MSG_COMFY_DIDNT_START });
  assert.equal(s.state(), "failed");
  assert.ok(sleeps < 5);
});

test("ensure twice shares one start; stop kills only what it spawned", async () => {
  let ready = false;
  const h = host({ up: () => ready });
  await h.fs.mkdir("C:\\Users\\Jon\\AppData\\Local\\Programs\\ComfyUI"); await h.fs.write(EXE_CANDIDATES[1], "exe");
  let n = 0;
  const s = makeComfyStarter({ settings: settings(), sleep: async () => { if (++n > 2) ready = true; } });
  await Promise.all([s.ensure(h), s.ensure(h)]);
  assert.equal(h.spawned.length, 1);
  await s.stop();
  assert.deepEqual(h.killed, [EXE_CANDIDATES[1]]);
  const s2 = makeComfyStarter({ settings: settings(), sleep: noSleep });
  const h2 = host({ up: () => true });
  await s2.ensure(h2); await s2.stop();
  assert.deepEqual(h2.killed, []);
});

test("settings: autostart defaults on, comfy.exe kept", async () => {
  assert.deepEqual(DEFAULT_SETTINGS.autostart, { comfy: true, stableAudio: true });
  const h = new FakeHost();
  await h.fs.mkdir("S:\\root");
  await h.fs.write("S:\\root\\.studio-settings.json", JSON.stringify({ autostart: { comfy: false }, comfy: { exe: "D:\\C.exe" } }));
  const st = await loadSettings(h, "S:\\root");
  assert.deepEqual(st.autostart, { comfy: false, stableAudio: true });
  assert.equal(st.comfy.exe, "D:\\C.exe");
});
