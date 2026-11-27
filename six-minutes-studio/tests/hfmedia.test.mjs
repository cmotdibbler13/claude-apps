import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { uploadMedia, estimateCredits } from "../js/tools/hfmedia.js";

const UUID = "25a2eb4f-234e-4c8a-8d2b-fe6b15994860";
const URL_ = `https://upload.higgsfield.ai/user_x/${UUID}.jpg?X-Amz-SignedHeaders=content-type%3Bhost%3Bif-none-match&X-Amz-Signature=abc`;
const FILE = "S:\\photos\\me & you.jpg";

function setup({ reply, exit = 0 } = {}) {
  const host = new FakeHost();
  const calls = [], spawns = [];
  host.mcpScript((s, t, i) => { calls.push({ s, t, i }); return t === "media_upload" ? reply ?? { uploads: [{ upload_url: URL_ }] } : {}; });
  host.spawnScript((cmd, args, o, p) => { spawns.push([cmd, ...args]); if (exit) p.err("403"); p.exit(exit); });
  return { host, calls, spawns };
}

test("upload call shapes, id from URL UUID (object reply)", async () => {
  const { host, calls, spawns } = setup();
  const id = await uploadMedia(host, FILE, "image");
  assert.equal(id, UUID);
  assert.deepEqual(calls[0], { s: "Higgsfield", t: "media_upload", i: { files: [{ filename: "me & you.jpg", content_type: "image/jpeg" }] } });
  assert.deepEqual(spawns[0], ["curl", "-sS", "--fail", "-X", "PUT", "-T", FILE, "-H", "Content-Type: image/jpeg", "-H", "If-None-Match: *", URL_]);
  assert.deepEqual(calls[1], { s: "Higgsfield", t: "media_confirm", i: { media_id: UUID, type: "image" } });
});

test("media id from media_id, then id; JSON text replies are parsed", async () => {
  let s = setup({ reply: { uploads: [{ upload_url: URL_, media_id: "m1", id: "i1" }] } });
  assert.equal(await uploadMedia(s.host, "a.png", "image"), "m1");
  s = setup({ reply: JSON.stringify({ uploads: [{ upload_url: URL_, id: "i1" }] }) });
  assert.equal(await uploadMedia(s.host, "a.wav", "audio"), "i1");
  assert.equal(s.calls[0].i.files[0].content_type, "audio/wav");
  assert.deepEqual(s.calls[1].i, { media_id: "i1", type: "audio" });
});

test("content types by extension", async () => {
  for (const [f, t] of [["a.png", "image/png"], ["a.JPEG", "image/jpeg"], ["a.webp", "image/webp"], ["a.mp3", "audio/mpeg"]]) {
    const s = setup();
    await uploadMedia(s.host, f, "image");
    assert.equal(s.calls[0].i.files[0].content_type, t);
  }
});

test("PUT failure throws and media_confirm is not called", async () => {
  const { host, calls } = setup({ exit: 22 });
  await assert.rejects(uploadMedia(host, FILE, "image"), /^Error: Upload to Higgsfield failed/);
  assert.deepEqual(calls.map((c) => c.t), ["media_upload"]);
});

test("refuses non-https and unsafe upload URLs without running curl", async () => {
  for (const u of ["http://x.example/a.jpg", 'https://x.example/a"b', "https://x.example/a b", "https://x.example/a$b", "https://x.example/a`b"]) {
    const { host, spawns } = setup({ reply: { uploads: [{ upload_url: u }] } });
    await assert.rejects(uploadMedia(host, FILE, "image"), /Higgsfield/);
    assert.equal(spawns.length, 0);
  }
});

test("estimateCredits returns cost.credits, null on error or odd reply", async () => {
  const host = new FakeHost();
  let seen;
  host.mcpScript((s, t, i) => { seen = { s, t, i }; return { cost: { credits: 20, credits_exact: 20 }, quote_ref: "q" }; });
  assert.equal(await estimateCredits(host, "estimate_image_cost", { params: { a: 1 } }), 20);
  assert.deepEqual(seen, { s: "Higgsfield", t: "estimate_image_cost", i: { params: { a: 1 } } });
  host.mcpScript(() => JSON.stringify({ cost: { credits: 5 } }));
  assert.equal(await estimateCredits(host, "estimate_video_cost", {}), 5);
  host.mcpScript(() => { throw new Error("x"); });
  assert.equal(await estimateCredits(host, "estimate_video_cost", {}), null);
  host.mcpScript(() => ({}));
  assert.equal(await estimateCredits(host, "estimate_video_cost", {}), null);
});

test("estimateCredits is null for null, empty or non-numeric credits; numeric strings count", async () => {
  const host = new FakeHost();
  for (const c of [null, "", "  ", "abc", undefined, {}]) {
    host.mcpScript(() => ({ cost: { credits: c } }));
    assert.equal(await estimateCredits(host, "estimate_image_cost", {}), null, JSON.stringify(c));
  }
  host.mcpScript(() => ({ cost: { credits: "12.5" } }));
  assert.equal(await estimateCredits(host, "estimate_image_cost", {}), 12.5);
  host.mcpScript(() => ({ cost: { credits: 0 } }));
  assert.equal(await estimateCredits(host, "estimate_image_cost", {}), 0);
});
