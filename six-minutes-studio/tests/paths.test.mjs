import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { resolveRoot, join, PRIMARY_ROOT, FALLBACK_ROOT } from "../js/paths.js";

test("prefers S: root", async () => {
  const h = new FakeHost();
  await h.fs.mkdir(PRIMARY_ROOT);
  await h.fs.mkdir(FALLBACK_ROOT);
  assert.equal(await resolveRoot(h), "S:\\Youtube video ideas");
});

test("falls back to UNC root when S: is missing", async () => {
  const h = new FakeHost();
  await h.fs.mkdir(FALLBACK_ROOT);
  assert.equal(await resolveRoot(h), "\\\\192.168.1.171\\jon\\Youtube video ideas");
});

test("reports no root when both are missing", async () => {
  assert.equal(await resolveRoot(new FakeHost()), null);
});

test("treats a throwing exists as missing", async () => {
  const h = new FakeHost();
  await h.fs.mkdir(FALLBACK_ROOT);
  const real = h.fs.exists;
  h.fs.exists = async (p) => { if (p === PRIMARY_ROOT) throw new Error("EIO"); return real(p); };
  assert.equal(await resolveRoot(h), FALLBACK_ROOT);
});

test("join uses backslashes and keeps a UNC prefix", () => {
  assert.equal(join("S:\\a\\", "b", "c.md"), "S:\\a\\b\\c.md");
  assert.equal(join("S:/a", "/b/"), "S:\\a\\b");
  assert.equal(join("\\\\srv\\share", "x"), "\\\\srv\\share\\x");
});

import { candidateRoots, rootSpellings } from "../js/paths.js";

test("resolveRoot finds N: when S: is missing, before the network path", async () => {
  const h = new FakeHost();
  await h.fs.mkdir("N:\\Youtube video ideas");
  await h.fs.mkdir(FALLBACK_ROOT);
  assert.equal(await resolveRoot(h), "N:\\Youtube video ideas");
});

test("resolveRoot prefers S: over N:", async () => {
  const h = new FakeHost();
  await h.fs.mkdir("N:\\Youtube video ideas");
  await h.fs.mkdir(PRIMARY_ROOT);
  assert.equal(await resolveRoot(h), PRIMARY_ROOT);
});

test("resolveRoot with a chosen folder returns it, or null when missing", async () => {
  const h = new FakeHost();
  await h.fs.mkdir(PRIMARY_ROOT);
  await h.fs.mkdir("E:\\Mine");
  assert.equal(await resolveRoot(h, { chosen: "E:\\Mine" }), "E:\\Mine");
  assert.equal(await resolveRoot(h, { chosen: "F:\\Gone" }), null);
});

test("candidateRoots lists every present drive and the network path", async () => {
  const h = new FakeHost();
  await h.fs.mkdir("N:\\Youtube video ideas");
  await h.fs.mkdir("C:\\Youtube video ideas");
  await h.fs.mkdir(FALLBACK_ROOT);
  assert.deepEqual(await candidateRoots(h), ["C:\\Youtube video ideas", "N:\\Youtube video ideas", FALLBACK_ROOT]);
  assert.deepEqual(await candidateRoots(new FakeHost()), []);
});

test("rootSpellings lists known spellings once, case-insensitively", () => {
  assert.deepEqual(rootSpellings({}), [PRIMARY_ROOT, FALLBACK_ROOT]);
  assert.deepEqual(
    rootSpellings({ computers: { a: { root: "N:\\Youtube video ideas" }, b: { root: "n:\\youtube video ideas" }, c: {}, d: { root: PRIMARY_ROOT.toLowerCase() } } }),
    [PRIMARY_ROOT, FALLBACK_ROOT, "N:\\Youtube video ideas"],
  );
});
