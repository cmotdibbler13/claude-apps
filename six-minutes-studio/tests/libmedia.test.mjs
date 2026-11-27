import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { probeClip, makeThumb, contactSheet } from "../js/tools/libmedia.js";

const F = "S:\\x\\clip one.mp4";
function probeHost(json, { code = 0, size = 5 * 1048576 } = {}) {
  const h = new FakeHost();
  h.files.set(F, new Uint8Array(size));
  h.dirs.add("S:/x");
  h.calls = [];
  h.spawnScript((cmd, args, o, p) => { h.calls.push([cmd, ...args]); if (code) { p.err("bad\nboom"); p.exit(code); } else { p.out(json); p.exit(0); } });
  return h;
}

test("probeClip parses ffprobe JSON into numbers", async () => {
  const h = probeHost(JSON.stringify({ streams: [{ width: 1920, height: 1080, r_frame_rate: "30000/1001" }], format: { duration: "5.04567" } }));
  const r = await probeClip(h, F);
  assert.deepEqual(r, { duration_s: 5.05, width: 1920, height: 1080, fps: 30, size_mb: 5 });
  assert.deepEqual(h.calls[0], ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", F]);
  const h2 = probeHost(JSON.stringify({ streams: [{ width: 1280, height: 720, r_frame_rate: "24/1" }], format: { duration: "2" } }), { size: 1572864 });
  assert.deepEqual(await probeClip(h2, F), { duration_s: 2, width: 1280, height: 720, fps: 24, size_mb: 1.5 });
});

test("probeClip throws naming the file on failure or bad output", async () => {
  await assert.rejects(probeClip(probeHost("", { code: 1 }), F), /Couldn't read clip one\.mp4: boom/);
  await assert.rejects(probeClip(probeHost("nope"), F), /Couldn't read clip one\.mp4/);
  await assert.rejects(probeClip(probeHost(JSON.stringify({ streams: [], format: {} })), F), /Couldn't read clip one\.mp4/);
});

test("makeThumb argv and failure", async () => {
  const h = new FakeHost();
  const seen = [];
  h.spawnScript((c, a, o, p) => { seen.push([c, ...a]); p.exit(0); });
  await makeThumb(h, "a.mp4", "t.jpg");
  assert.deepEqual(seen[0], ["ffmpeg", "-y", "-ss", "1", "-i", "a.mp4", "-frames:v", "1", "-vf", "scale=320:-2", "t.jpg"]);
  h.spawnScript((c, a, o, p) => { p.err("x\nNo such file"); p.exit(1); });
  await assert.rejects(makeThumb(h, "a.mp4", "t.jpg"), /No such file/);
});

test("contactSheet builds one filter_complex with a 4-wide grid padded with black", async () => {
  const h = new FakeHost();
  const seen = [];
  h.spawnScript((c, a, o, p) => { seen.push([c, ...a]); p.exit(0); });
  const items = [1, 2, 3, 4, 5, 6].map((n) => ({ thumb: `t${n}.jpg`, id: `BR-00${n}` }));
  await contactSheet(h, items, "s.jpg");
  const a = seen[0];
  assert.equal(a[0], "ffmpeg");
  assert.equal(a.filter((x) => x === "-i").length, 6);
  const fc = a[a.indexOf("-filter_complex") + 1];
  assert.match(fc, /\[0:v\]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:\(ow-iw\)\/2:\(oh-ih\)\/2,drawtext=text='BR-001':x=8:y=h-th-8:fontcolor=white:fontsize=20:box=1:boxcolor=black@0\.5\[v0\]/);
  assert.match(fc, /xstack=inputs=8:layout=0_0\|320_0\|640_0\|960_0\|0_180\|320_180\|640_180\|960_180/);
  assert.match(fc, /color=c=black:s=320x180/);
  assert.equal(a.at(-1), "s.jpg");
  assert.ok(a.includes("-frames:v"));
});

test("contactSheet rejects ids that aren't BR-n, and empty input", async () => {
  const h = new FakeHost();
  h.spawnScript((c, a, o, p) => p.exit(0));
  await assert.rejects(contactSheet(h, [{ thumb: "t.jpg", id: "x':y" }], "s.jpg"), /BR-/);
  await assert.rejects(contactSheet(h, [], "s.jpg"));
});
