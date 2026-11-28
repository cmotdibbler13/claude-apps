import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { computerName, localStore, saveComputerSettings, roleNeeded, PER_COMPUTER } from "../js/computer.js";
import { loadSettings } from "../js/settings.js";

const ROOT = "S:\\Youtube video ideas";
const FILE = ROOT + "\\.studio-settings.json";
const NOW = new Date(2026, 10, 28, 9, 5).getTime();

function hostWith(env = {}) {
  const host = new FakeHost();
  host.spawnScript((cmd, args, o, p) => {
    const m = /%(\w+)%/.exec(args.join(" "));
    const v = m && env[m[1]];
    if (v === undefined) { p.exit(1); return; }
    p.out(v); p.exit(0);
  });
  return host;
}

test("computerName trims and upper-cases", async () => {
  assert.equal(await computerName(hostWith({ COMPUTERNAME: " laptop-jon\r\n" })), "LAPTOP-JON");
});
test("computerName falls back to THIS-PC", async () => {
  assert.equal(await computerName(hostWith({})), "THIS-PC");
});

test("localStore round-trips through the file", async () => {
  const host = hostWith({ APPDATA: "C:\\Users\\L\\AppData\\Roaming" });
  const s = localStore(host);
  assert.deepEqual(await s.read(), {});
  await s.write({ root: "N:\\Youtube video ideas" });
  assert.ok(host.files.has("C:\\Users\\L\\AppData\\Roaming\\Six Minutes Studio\\computer.json"));
  assert.deepEqual(await localStore(host).read(), { root: "N:\\Youtube video ideas" });
});

test("localStore falls back to localStorage when the file can't be written", async () => {
  const host = hostWith({ APPDATA: "C:\\A" });
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  try {
    host.fs.write = async () => { throw new Error("EACCES"); };
    const s = localStore(host);
    await s.write({ root: "N:\\x" });
    assert.ok(mem.has("sms.computer"));
    assert.deepEqual(await s.read(), { root: "N:\\x" });
  } finally { delete globalThis.localStorage; }
});
test("localStore with no storage at all reads {}, and a write says it failed", async () => {
  const host = hostWith({});
  assert.deepEqual(await localStore(host).read(), {});
  await assert.rejects(localStore(host).write({ root: "x" }));
});
test("localStore write throws when both the file and localStorage fail", async () => {
  const host = hostWith({ APPDATA: "C:\\A" });
  host.fs.write = async () => { throw new Error("EACCES"); };
  globalThis.localStorage = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  try { await assert.rejects(localStore(host).write({ root: "N:\\x" })); }
  finally { delete globalThis.localStorage; }
});

test("no computers entry: today's result plus role, ffmpegPath, computer", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await host.fs.write(FILE, JSON.stringify({ mixMusicDb: -30, autostart: false }));
  const s = await loadSettings(host, ROOT, { computer: "PC" });
  assert.equal(s.role, "desktop");
  assert.equal(s.ffmpegPath, "ffmpeg");
  assert.equal(s.computer, "PC");
  assert.equal(s.mixMusicDb, -30);
  assert.deepEqual(s.autostart, { comfy: false, stableAudio: false });
  const plain = await loadSettings(host, ROOT);
  const { computer: _a, ...rest } = s; const { computer: _b, ...rest2 } = plain;
  assert.deepEqual(rest, rest2);
});

test("a laptop entry overrides only per-computer keys and turns autostart off", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await host.fs.write(FILE, JSON.stringify({ mixMusicDb: -30, videoModel: "v", computers: { LAPTOP: {
    role: "laptop", autocueDir: "D:\\Apps\\Autocue Studio", comfy: { url: "http://x:1", workflow: "ignored" }, stableAudio: { steps: 3 }, videoModel: "ignored",
  } } }));
  const s = await loadSettings(host, ROOT, { computer: "LAPTOP" });
  assert.equal(s.role, "laptop");
  assert.equal(s.autocueDir, "D:\\Apps\\Autocue Studio");
  assert.equal(s.autocueRecordings, "C:\\Users\\Jon\\desktop autocue\\Recordings");
  assert.equal(s.mixMusicDb, -30);
  assert.equal(s.videoModel, "v");
  assert.equal(s.comfy.url, "http://x:1");
  assert.equal(s.comfy.outputDir.startsWith("C:\\Users\\Jon"), true);
  assert.notEqual(s.comfy.workflow, "ignored");
  assert.equal(s.stableAudio.steps, 3);
  assert.equal(s.stableAudio.url, "http://127.0.0.1:7860");
  assert.deepEqual(s.autostart, { comfy: false, stableAudio: false });
  const other = await loadSettings(host, ROOT, { computer: "DESK" });
  assert.equal(other.autocueDir, "C:\\Users\\Jon\\desktop autocue");
});

test("a laptop entry with its own autostart keeps it", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await host.fs.write(FILE, JSON.stringify({ computers: { L: { role: "laptop", autostart: { comfy: true } } } }));
  const s = await loadSettings(host, ROOT, { computer: "L" });
  assert.deepEqual(s.autostart, { comfy: true, stableAudio: true });
});

test("saveComputerSettings changes only computers, copies aside once a day", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  const before = { mixMusicDb: -30, comfy: { url: "http://shared" }, computers: { OTHER: { role: "desktop" } } };
  await host.fs.write(FILE, JSON.stringify(before));
  await saveComputerSettings(host, ROOT, "LAPTOP", { role: "laptop", comfy: { exe: "D:\\c.exe" }, root: "N:\\Youtube video ideas" }, { now: NOW });
  const after = JSON.parse(await host.fs.read(FILE, "utf8"));
  const { computers, ...rest } = after; const { computers: bc, ...brest } = before;
  assert.deepEqual(rest, brest);
  assert.deepEqual(computers.OTHER, bc.OTHER);
  assert.deepEqual(computers.LAPTOP, { role: "laptop", comfy: { exe: "D:\\c.exe" }, root: "N:\\Youtube video ideas" });
  const copies = () => [...host.files.keys()].filter((k) => /\.studio-settings_2026-11-28-\d{4}\.json$/.test(k));
  assert.equal(copies().length, 1);
  assert.deepEqual(JSON.parse(await host.fs.read(copies()[0], "utf8")), before);
  await saveComputerSettings(host, ROOT, "LAPTOP", { comfy: { url: "http://l" } }, { now: NOW + 60000 });
  assert.equal(copies().length, 1);
  const again = JSON.parse(await host.fs.read(FILE, "utf8"));
  assert.deepEqual(again.computers.LAPTOP.comfy, { exe: "D:\\c.exe", url: "http://l" });
  assert.equal((await loadSettings(host, ROOT, { computer: "LAPTOP" })).root, undefined);
});

test("saveComputerSettings works with no file yet", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await saveComputerSettings(host, ROOT, "L", { role: "laptop" }, { now: NOW });
  assert.deepEqual(JSON.parse(await host.fs.read(FILE, "utf8")), { computers: { L: { role: "laptop" } } });
});

test("saveComputerSettings refuses shared keys", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await assert.rejects(saveComputerSettings(host, ROOT, "L", { mixMusicDb: -3 }, { now: NOW }), { message: "mixMusicDb is shared by every computer." });
  assert.ok(PER_COMPUTER.includes("ffmpegPath"));
});

test("saveComputerSettings never overwrites an unreadable file", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await host.fs.write(FILE, "{nope");
  await assert.rejects(saveComputerSettings(host, ROOT, "L", { role: "laptop" }, { now: NOW }));
  assert.equal(await host.fs.read(FILE, "utf8"), "{nope");
});

test("roleNeeded: the network path to the project folder is the desktop too, so it is never asked", () => {
  const U = "\\\\192.168.1.171\\jon\\Youtube video ideas";
  assert.equal(roleNeeded({}, "DESK", U), false);
  assert.equal(roleNeeded({}, "DESK", U.toLowerCase() + "\\"), false);
  assert.equal(roleNeeded({}, "L", "N:\\Youtube video ideas"), true);
});

test("roleNeeded: a computer with no role, not on S:, is asked; the desktop on S: never is", () => {
  const N = "N:\\Youtube video ideas";
  // The first second computer: nothing recorded yet.
  assert.equal(roleNeeded({}, "L", N), true);
  assert.equal(roleNeeded(null, "L", N), true);
  assert.equal(roleNeeded({ computers: { L: { root: N } } }, "L", N), true);
  assert.equal(roleNeeded({ computers: { L: { role: "laptop" } } }, "L", N), false);
  assert.equal(roleNeeded({ computers: { L: { role: "desktop" } } }, "L", N), false);
  // On S: (any spelling of the letter case), whatever other entries exist.
  assert.equal(roleNeeded({}, "D", ROOT), false);
  assert.equal(roleNeeded({ computers: { L: { role: "laptop" } } }, "D", ROOT), false);
  assert.equal(roleNeeded({}, "D", "s:\\youtube video ideas\\"), false);
  // No folder yet, or a computer whose name can't be read (its role can't be saved).
  assert.equal(roleNeeded({}, "L", null), false);
  assert.equal(roleNeeded({}, "THIS-PC", N), false);
});

test("saveComputerSettings refuses when the computer's name couldn't be read", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await assert.rejects(saveComputerSettings(host, ROOT, "THIS-PC", { role: "laptop" }, { now: NOW }),
    { message: "Studio couldn't read this computer's name, so it can't save settings for it." });
  assert.equal(host.files.has(FILE), false);
});

test("saveComputerSettings ends the file with a newline", async () => {
  const host = new FakeHost();
  await host.fs.mkdir(ROOT);
  await host.fs.write(FILE, JSON.stringify({ mixMusicDb: -30 }, null, 2) + "\n");
  await saveComputerSettings(host, ROOT, "L", { role: "laptop" }, { now: NOW });
  const text = await host.fs.read(FILE, "utf8");
  assert.ok(text.endsWith("}\n"));
  assert.ok(!text.endsWith("\n\n"));
});
