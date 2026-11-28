import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { PRIMARY_ROOT, FALLBACK_ROOT, rootSpellings } from "../js/paths.js";
import { rebasePath, withRebase } from "../js/rebase.js";

const N = "N:\\Youtube video ideas";
const sp = rootSpellings({});

test("rebasePath swaps a known spelling for the root", () => {
  assert.equal(rebasePath("S:\\Youtube video ideas\\Orkney\\a.mp4", sp, N), "N:\\Youtube video ideas\\Orkney\\a.mp4");
  assert.equal(rebasePath("S:/Youtube video ideas/Orkney/a.mp4", sp, N), "N:\\Youtube video ideas\\Orkney\\a.mp4");
  assert.equal(rebasePath("s:\\youtube video ideas", sp, N), N);
  assert.equal(rebasePath(FALLBACK_ROOT + "\\x\\y.wav", sp, N), N + "\\x\\y.wav");
});

test("rebasePath leaves other paths and non-strings alone", () => {
  assert.equal(rebasePath("S:\\Youtube video ideas extra\\x", sp, N), "S:\\Youtube video ideas extra\\x");
  assert.equal(rebasePath("C:\\Users\\Jon\\x", sp, N), "C:\\Users\\Jon\\x");
  assert.equal(rebasePath("-i", sp, N), "-i");
  assert.equal(rebasePath(5, sp, N), 5);
  assert.equal(rebasePath(undefined, sp, N), undefined);
  assert.equal(rebasePath(N + "\\x", sp, N), N + "\\x");
});

test("rebasePath handles a root that is itself a spelling", () => {
  const s2 = rootSpellings({ computers: { laptop: { root: N } } });
  assert.equal(rebasePath(N + "\\a", s2, N), N + "\\a");
  assert.equal(rebasePath(PRIMARY_ROOT + "\\a", s2, N), N + "\\a");
});

test("withRebase rebases fs paths, including both rename paths", async () => {
  const h = new FakeHost();
  await h.fs.mkdir(N);
  await h.fs.write(N + "\\x", "hi");
  const w = withRebase(h, sp, N);
  assert.equal(await w.fs.read("S:\\Youtube video ideas\\x", "utf8"), "hi");
  assert.equal(await w.fs.exists("S:\\Youtube video ideas\\x"), true);
  await w.fs.rename("S:\\Youtube video ideas\\x", "S:\\Youtube video ideas\\y");
  assert.equal(await h.fs.exists(N + "\\y"), true);
  assert.equal(await h.fs.exists(N + "\\x"), false);
  await w.fs.write("S:\\Youtube video ideas\\z", "z");
  assert.equal(await h.fs.read(N + "\\z", "utf8"), "z");
});

test("withRebase rebases exec, spawn args and open; passes others through", async () => {
  const h = new FakeHost();
  const seen = [];
  h.execScript((cmd) => { seen.push(cmd); return { stdout: "", stderr: "", code: 0 }; });
  h.spawnScript((cmd, args, opts, ctl) => { seen.push([cmd, args]); ctl.exit(0); });
  const w = withRebase(h, sp, N);
  await w.exec("S:\\Youtube video ideas\\tool.exe");
  const p = w.spawn("ffmpeg", ["-i", "S:\\Youtube video ideas\\x.wav", "-y", "out=S:\\a"]);
  await new Promise((r) => p.onExit(r));
  await w.open("S:\\Youtube video ideas\\f");
  assert.equal(seen[0], N + "\\tool.exe");
  assert.deepEqual(seen[1], ["ffmpeg", ["-i", N + "\\x.wav", "-y", "out=S:\\a"]]);
  assert.deepEqual(h.opened, [N + "\\f"]);
  assert.equal(w.platform, "win32");
  assert.equal(w.mcp, h.mcp);
  assert.equal(w.claude, h.claude);
  assert.equal(w.now(), h.now());
  await w.notify("x");
  assert.deepEqual(h.notified, ["x"]);
});
