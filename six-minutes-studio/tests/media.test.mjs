import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { ensureProxy, toBlobUrl, openFull, revokeAll } from "../js/media.js";

const SRC = "S:\\Films\\One\\clip.mp4";
const PROXY = "S:\\Films\\One\\proxy\\clip_640.mp4";
const PART = "S:\\Films\\One\\proxy\\clip_640.part.mp4";

function setup() {
  const h = new FakeHost();
  h.files.set(SRC, new Uint8Array([1, 2, 3]));
  h.dirs.add("S:/Films/One");
  const calls = [];
  h.execScript(async (cmd, opts) => {
    calls.push({ cmd, opts });
    await h.fs.write(PART, new Uint8Array([9]));
    return { stdout: "", stderr: "", code: 0 };
  });
  return { h, calls };
}

test("builds ffmpeg proxy once and reuses it", async () => {
  const { h, calls } = setup();
  assert.equal(await ensureProxy(h, SRC), PROXY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, `ffmpeg -y -i "${SRC}" -vf scale=640:-2 -c:v libx264 -crf 28 -an "${PART}"`);
  assert.equal(calls[0].opts.timeout, 600000);
  assert.equal(await ensureProxy(h, SRC), PROXY);
  assert.equal(calls.length, 1);
});

test("images are not proxied", async () => {
  const { h, calls } = setup();
  assert.equal(await ensureProxy(h, "S:\\a\\pic.PNG"), "S:\\a\\pic.PNG");
  assert.equal(await ensureProxy(h, "S:\\a\\pic.webp"), "S:\\a\\pic.webp");
  assert.equal(calls.length, 0);
});

test("unknown file types are rejected", async () => {
  const { h } = setup();
  await assert.rejects(ensureProxy(h, "S:\\a\\doc.pdf"), /Can't preview this file type/);
});

test("reuses a proxy newer than the source, rebuilds when the source is newer", async () => {
  const { h, calls } = setup();
  h.dirs.add("S:/Films/One/proxy");
  h.files.set(PROXY, new Uint8Array([9]));
  const mt = { [SRC]: 100, [PROXY]: 200 };
  h.fs.stat = async (p) => {
    if (!(p in mt)) throw new Error("ENOENT");
    return { size: 1, isFile: true, isDirectory: false, mtimeMs: mt[p] };
  };
  await ensureProxy(h, SRC);
  assert.equal(calls.length, 0);
  mt[SRC] = 300;
  await ensureProxy(h, SRC);
  assert.equal(calls.length, 1);
});

test("unsafe paths are rejected without exec", async () => {
  const { h, calls } = setup();
  for (const bad of ['S:\\a\\x&y.mp4', 'S:\\a\\x%y.mp4', 'S:\\a\\x"y.mp4', "S:\\a\\x$y.mp4"]) {
    await assert.rejects(ensureProxy(h, bad), /unsafe/i);
  }
  assert.equal(calls.length, 0);
});

test("ffmpeg failure rejects with the last stderr lines", async () => {
  const { h } = setup();
  h.execScript(async () => ({ stdout: "", stderr: "a\nb\nc\nd\ne\nf\ng", code: 1 }));
  await assert.rejects(ensureProxy(h, SRC), (e) => /c\nd\ne\nf\ng/.test(e.message) && !/\nb\n/.test(e.message));
});

test("rejects when the proxy is missing after a successful exec", async () => {
  const { h } = setup();
  h.execScript(async () => ({ stdout: "", stderr: "", code: 0 }));
  await assert.rejects(ensureProxy(h, SRC), /proxy/i);
});

test("concurrent calls share one in-flight exec", async () => {
  const { h, calls } = setup();
  const [a, b] = await Promise.all([ensureProxy(h, SRC), ensureProxy(h, SRC)]);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
});

test("toBlobUrl returns a blob: URL with the right type, cached by path+mtime", async () => {
  const h = new FakeHost();
  h.files.set("S:\\a\\p.png", new Uint8Array([1, 2]));
  let reads = 0;
  const read = h.fs.read;
  h.fs.read = async (...a) => (reads++, read(...a));
  const u = await toBlobUrl(h, "S:\\a\\p.png");
  assert.match(u, /^blob:/);
  assert.equal(await toBlobUrl(h, "S:\\a\\p.png"), u);
  assert.equal(reads, 1);
  const r = await fetch(u);
  assert.equal((await r.blob()).type, "image/png");
  h.t += 1000;
  assert.notEqual(await toBlobUrl(h, "S:\\a\\p.png"), u);
  revokeAll();
});

test("openFull opens the file via host.open", async () => {
  const h = new FakeHost();
  await openFull(h, SRC);
  assert.deepEqual(h.opened, [SRC]);
});

test("a failed encode leaves no proxy at the final name and the next call re-encodes", async () => {
  const { h, calls } = setup();
  h.execScript(async (cmd, opts) => {
    calls.push({ cmd, opts });
    await h.fs.write(PART, new Uint8Array([9]));
    return { stdout: "", stderr: "boom", code: 1 };
  });
  await assert.rejects(ensureProxy(h, SRC), /boom/);
  assert.equal(await h.fs.exists(PROXY), false);
  assert.equal(await h.fs.exists(PART), false);
  await assert.rejects(ensureProxy(h, SRC), /boom/);
  assert.equal(calls.length, 2);
});

test("a timed-out encode (exec rejects) leaves no proxy at the final name", async () => {
  const { h } = setup();
  h.execScript(async () => { await h.fs.write(PART, new Uint8Array([9])); throw new Error("timeout"); });
  await assert.rejects(ensureProxy(h, SRC), /timeout/);
  assert.equal(await h.fs.exists(PROXY), false);
});
