import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { makeHost } from "../js/host.js";
import { askJson } from "../js/claude.js";
import { readImages, canSendImages } from "../js/images.js";

test("readImages returns typed Blobs in order", async () => {
  const h = new FakeHost();
  await h.fs.mkdir("S:\\d");
  await h.fs.write("S:\\d\\a.PNG", new Uint8Array([1]));
  await h.fs.write("S:\\d\\b.jpg", new Uint8Array([2, 2]));
  await h.fs.write("S:\\d\\c.jpeg", new Uint8Array([3]));
  await h.fs.write("S:\\d\\d.webp", new Uint8Array([4]));
  const blobs = await readImages(h, ["S:\\d\\a.PNG", "S:\\d\\b.jpg", "S:\\d\\c.jpeg", "S:\\d\\d.webp"]);
  assert.deepEqual(blobs.map((b) => b.type), ["image/png", "image/jpeg", "image/jpeg", "image/webp"]);
  assert.deepEqual(blobs.map((b) => b.size), [1, 2, 1, 1]);
});

test("readImages rejects an unknown extension with the copy", async () => {
  const h = new FakeHost();
  await h.fs.mkdir("S:\\d");
  await h.fs.write("S:\\d\\notes.gif", new Uint8Array([1]));
  await assert.rejects(readImages(h, ["S:\\d\\notes.gif"]), { message: "Can't send notes.gif to Claude: not a PNG, JPEG or WebP picture." });
});

test("canSendImages: true, false, and false when limits throws", async () => {
  const h = new FakeHost();
  h.limitsScript(() => ({ images: { maxCount: 4 } }));
  assert.equal(await canSendImages(h), true);
  h.limitsScript(() => ({}));
  assert.equal(await canSendImages(h), false);
  h.limitsScript(() => { throw new Error("boom"); });
  assert.equal(await canSendImages(h), false);
  assert.equal(await canSendImages(new FakeHost({ claude: false })), false);
  assert.equal(await canSendImages({ claude: { json() {} } }), false);
});

test("askJson passes images only when given", async () => {
  const h = new FakeHost();
  const seen = [];
  h.claudeScript((k, i, opts) => { seen.push(opts); return {}; });
  const b = new Blob([new Uint8Array([1])], { type: "image/png" });
  await askJson(h, { instructions: "x", data: {}, images: [b] });
  await askJson(h, { instructions: "x", data: {} });
  assert.deepEqual(seen[0].images, [b]);
  assert.equal("images" in seen[1], false);
});

function stubClaude(calls, limits) {
  const sample = async (input, o) => { calls.push(["text", o]); return { text: "t" }; };
  sample.json = async (input, o) => { calls.push(["json", o]); return {}; };
  if (limits) sample.limits = limits;
  const desktop = { fs: {}, childProcess: {}, shell: {}, os: { platform: async () => "win32" } };
  return { use: async (n) => (n === "desktop" ? desktop : n === "sample" ? sample : n === "mcp" ? null : null) };
}

test("host passes images through to sample and omits the key when none", async () => {
  const calls = [];
  const host = await makeHost(stubClaude(calls));
  const b = new Blob([new Uint8Array([1])], { type: "image/png" });
  await host.claude.json("q", { tier: "quick", images: [b] });
  await host.claude.json("q", { tier: "quick" });
  await host.claude.text("q", { images: [b] });
  assert.deepEqual(calls[0][1], { modelTier: "quick", images: [b] });
  assert.deepEqual(calls[1][1], { modelTier: "quick" });
  assert.deepEqual(calls[2][1], { images: [b] });
});

test("host claude.limits maps to sample.limits when available", async () => {
  const host = await makeHost(stubClaude([], async () => ({ images: { maxCount: 2 } })));
  assert.deepEqual(await host.claude.limits(), { images: { maxCount: 2 } });
  const bare = await makeHost(stubClaude([]));
  assert.equal(bare.claude.limits, undefined);
});
