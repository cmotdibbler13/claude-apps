import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { findRoot, readRawSettings, rebasedHost, liveHost, rootToRecord } from "../js/boot.js";

const S = "S:\\Youtube video ideas";
const N = "N:\\Youtube video ideas";

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
const ENV = { COMPUTERNAME: "laptop-jon", APPDATA: "C:\\A" };
const STORE = "C:\\A\\Six Minutes Studio\\computer.json";

test("desktop: no local choice finds S: as today", async () => {
  const h = hostWith({ COMPUTERNAME: "desk" });
  await h.fs.mkdir(S);
  assert.deepEqual(await findRoot(h), { computer: "DESK", chosenRoot: null, root: S, chosenMissing: null });
});

test("no local choice and nothing reachable: root null, no chosen message", async () => {
  const r = await findRoot(hostWith({}));
  assert.deepEqual(r, { computer: "THIS-PC", chosenRoot: null, root: null, chosenMissing: null });
});

test("chosen folder present: it is the root, even when S: is there too", async () => {
  const h = hostWith(ENV);
  await h.fs.mkdir(S); await h.fs.mkdir(N);
  await h.fs.mkdir("C:\\A\\Six Minutes Studio");
  await h.fs.write(STORE, JSON.stringify({ root: N }));
  assert.deepEqual(await findRoot(h), { computer: "LAPTOP-JON", chosenRoot: N, root: N, chosenMissing: null });
});

test("chosen folder missing: root null and chosenMissing names it (no fallback)", async () => {
  const h = hostWith(ENV);
  await h.fs.mkdir(S);
  await h.fs.mkdir("C:\\A\\Six Minutes Studio");
  await h.fs.write(STORE, JSON.stringify({ root: N }));
  assert.deepEqual(await findRoot(h), { computer: "LAPTOP-JON", chosenRoot: N, root: null, chosenMissing: N });
});

test("a known computer name is reused, not asked again", async () => {
  const h = hostWith({});
  await h.fs.mkdir(S);
  assert.equal((await findRoot(h, { computer: "DESK" })).computer, "DESK");
});

test("readRawSettings: missing, unreadable, or not an object is {}", async () => {
  const h = new FakeHost();
  assert.deepEqual(await readRawSettings(h, S), {});
  await h.fs.mkdir(S);
  await h.fs.write(S + "\\.studio-settings.json", "{oops");
  assert.deepEqual(await readRawSettings(h, S), {});
  await h.fs.write(S + "\\.studio-settings.json", "[1]");
  assert.deepEqual(await readRawSettings(h, S), {});
  await h.fs.write(S + "\\.studio-settings.json", JSON.stringify({ computers: { L: { root: N } } }));
  assert.deepEqual(await readRawSettings(h, S), { computers: { L: { root: N } } });
});

test("rebasedHost on the laptop reads desktop-saved S: paths from N:", async () => {
  const h = new FakeHost();
  await h.fs.mkdir(N + "\\Film");
  await h.fs.write(N + "\\Film\\a.txt", "hi");
  const r = await rebasedHost(h, N);
  assert.equal(await r.fs.read(S + "\\Film\\a.txt", "utf8"), "hi");
  assert.equal(await r.fs.read("\\\\192.168.1.171\\jon\\Youtube video ideas\\Film\\a.txt", "utf8"), "hi");
});

test("rebasedHost uses computers.*.root spellings from the raw settings file", async () => {
  const h = new FakeHost();
  await h.fs.mkdir(S + "\\Film");
  await h.fs.write(S + "\\Film\\a.txt", "hi");
  await h.fs.write(S + "\\.studio-settings.json", JSON.stringify({ computers: { L: { root: "M:\\Films" } } }));
  const r = await rebasedHost(h, S);
  assert.equal(await r.fs.read("M:\\Films\\Film\\a.txt", "utf8"), "hi");
});

test("desktop: rebase is a no-op for paths under S:", async () => {
  const h = new FakeHost();
  await h.fs.mkdir(S + "\\Film");
  await h.fs.write(S + "\\Film\\a.txt", "hi");
  const r = await rebasedHost(h, S);
  assert.equal(await r.fs.read(S + "\\Film\\a.txt", "utf8"), "hi");
  assert.equal(await r.fs.exists("C:\\other"), false);
});

test("liveHost follows whatever host is current", async () => {
  const a = new FakeHost(), b = new FakeHost();
  await b.fs.mkdir("C:\\x");
  let cur = a;
  const live = liveHost(() => cur);
  assert.equal(await live.fs.exists("C:\\x"), false);
  cur = b;
  assert.equal(await live.fs.exists("C:\\x"), true);
  assert.equal(typeof live.now(), "number");
  assert.equal("fs" in live, true);
});

test("rootToRecord: the network path to the project folder is never recorded", () => {
  const U = "\\\\192.168.1.171\\jon\\Youtube video ideas";
  assert.equal(rootToRecord({}, "DESK", U), false);
  assert.equal(rootToRecord({}, "DESK", U.toUpperCase() + "\\"), false);
  assert.equal(rootToRecord({}, "L", N), true);
});

test("rootToRecord: a computer on another folder records it once; the desktop on S: never writes", () => {
  const U = "\\\\192.168.1.171\\jon\\Youtube video ideas";
  // Desktop on S:, with or without entries.
  assert.equal(rootToRecord({}, "DESK", S), false);
  assert.equal(rootToRecord({ computers: { L: { root: N } } }, "DESK", S), false);
  assert.equal(rootToRecord({}, "DESK", "s:\\youtube video ideas"), false);
  // The laptop on N: with nothing recorded, or a different folder recorded.
  assert.equal(rootToRecord({}, "L", N), true);
  assert.equal(rootToRecord({ computers: { L: { role: "laptop" } } }, "L", N), true);
  assert.equal(rootToRecord({ computers: { L: { root: U } } }, "L", N), true);
  assert.equal(rootToRecord({ computers: { L: { root: S } } }, "L", U), false); // the network path is the desktop's, never recorded
  // Already recorded (letter case and a trailing slash don't count).
  assert.equal(rootToRecord({ computers: { L: { root: N } } }, "L", N), false);
  assert.equal(rootToRecord({ computers: { L: { root: "n:\\youtube video ideas\\" } } }, "L", N), false);
  // No folder, or no name to save it under.
  assert.equal(rootToRecord({}, "L", null), false);
  assert.equal(rootToRecord({}, "THIS-PC", N), false);
});
