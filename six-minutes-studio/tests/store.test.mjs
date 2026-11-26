import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { openFilm } from "../js/store.js";

const DIR = "S:\\Youtube video ideas\\Film A";
const mk = async () => { const h = new FakeHost(); await h.fs.mkdir(DIR); return h; };

test("creates studio folders and empty state", async () => {
  const h = await mk();
  const s = await openFilm(h, DIR);
  assert.equal(await h.fs.exists(DIR + "\\studio"), true);
  assert.equal(await h.fs.exists(DIR + "\\studio\\blender"), true);
  assert.equal(await h.fs.exists(DIR + "\\studio\\media"), true);
  assert.equal(s.state.v, 1);
  assert.equal(s.state.part, 2);
  assert.equal(s.state.waiting, "Shot list not made yet");
  assert.deepEqual(s.state.assets, []);
});

test("update persists to state.json via temp file then rename", async () => {
  const h = await mk();
  const ops = [];
  const { write, rename } = h.fs;
  h.fs.write = async (p, d) => { ops.push(["write", p]); return write(p, d); };
  h.fs.rename = async (a, b) => { ops.push(["rename", a, b]); return rename(a, b); };
  const s = await openFilm(h, DIR);
  ops.length = 0;
  const r = await s.update((d) => { d.waiting = "x"; });
  assert.equal(r.waiting, "x");
  assert.equal(s.state.waiting, "x");
  assert.deepEqual(ops, [["write", DIR + "\\studio\\state.json.tmp"], ["rename", DIR + "\\studio\\state.json.tmp", DIR + "\\studio\\state.json"]]);
  assert.equal(JSON.parse(await h.fs.read(DIR + "\\studio\\state.json", "utf8")).waiting, "x");
  assert.equal(await h.fs.exists(DIR + "\\studio\\state.json.tmp"), false);
  const again = await openFilm(h, DIR);
  assert.equal(again.state.waiting, "x");
});

test("a throwing update changes nothing and rejects", async () => {
  const h = await mk();
  const s = await openFilm(h, DIR);
  await assert.rejects(s.update((d) => { d.waiting = "bad"; throw new Error("boom"); }), /boom/);
  assert.equal(s.state.waiting, "Shot list not made yet");
  await s.update((d) => { d.waiting = "ok"; });
  assert.equal(s.state.waiting, "ok");
});

test("concurrent updates are applied in order and none are lost", async () => {
  const h = await mk();
  const s = await openFilm(h, DIR);
  await s.update((d) => { d.nums = []; });
  const ps = [];
  for (let i = 0; i < 20; i++) ps.push(s.update((d) => { d.nums.push(i); }));
  await Promise.all(ps);
  assert.deepEqual(s.state.nums, [...Array(20).keys()]);
  const disk = JSON.parse(await h.fs.read(DIR + "\\studio\\state.json", "utf8"));
  assert.deepEqual(disk.nums, [...Array(20).keys()]);
});

test("log appends JSON lines and readLog returns newest first", async () => {
  const h = await mk();
  const s = await openFilm(h, DIR);
  h.t = 100; await s.log("one");
  h.t = 200; await s.log("two");
  h.t = 300; await s.log("three");
  const raw = await h.fs.read(DIR + "\\studio\\log.jsonl", "utf8");
  assert.deepEqual(raw.trim().split("\n").map((l) => JSON.parse(l)), [{ t: 100, text: "one" }, { t: 200, text: "two" }, { t: 300, text: "three" }]);
  assert.deepEqual(await s.readLog(2), [{ t: 300, text: "three" }, { t: 200, text: "two" }]);
  assert.equal((await s.readLog(10)).length, 3);
});

test("readLog is empty when there is no log", async () => {
  const s = await openFilm(await mk(), DIR);
  assert.deepEqual(await s.readLog(5), []);
});

test("corrupt state.json is renamed state.bad-<t>.json and a fresh state is started, with a log line saying so", async () => {
  const h = await mk();
  await h.fs.mkdir(DIR + "\\studio");
  await h.fs.write(DIR + "\\studio\\state.json", "{not json");
  h.t = 555;
  const s = await openFilm(h, DIR);
  assert.equal(s.state.v, 1);
  assert.deepEqual(s.state.assets, []);
  assert.equal(await h.fs.read(DIR + "\\studio\\state.bad-555.json", "utf8"), "{not json");
  const log = await s.readLog(5);
  assert.equal(log.length, 1);
  assert.match(log[0].text, /state\.bad-555\.json/);
});

test("a fresh film has prefs.preferComfy false, and an old state.json without prefs reads as false", async () => {
  const h = new FakeHost();
  await h.fs.mkdir("S:\\F");
  const s = await openFilm(h, "S:\\F");
  assert.equal(s.state.prefs.preferComfy, false);
  const old = { ...s.state }; delete old.prefs;
  await h.fs.write("S:\\F\\studio\\state.json", JSON.stringify(old));
  const s2 = await openFilm(h, "S:\\F");
  assert.equal(!!s2.state.prefs?.preferComfy, false);
});
