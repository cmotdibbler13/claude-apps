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
  h.spawnScript(async (cmd, args, opts, p) => {
    calls.push({ cmd, args });
    await h.fs.write(PART, new Uint8Array([9]));
    p.exit(0);
  });
  return { h, calls };
}

test("builds ffmpeg proxy once and reuses it", async () => {
  const { h, calls } = setup();
  assert.equal(await ensureProxy(h, SRC), PROXY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "ffmpeg");
  assert.deepEqual(calls[0].args, ["-y", "-i", SRC, "-vf", "scale=640:-2", "-c:v", "libx264", "-crf", "28", "-an", PART]);
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

test("paths with & % ! ^ $ are passed to ffmpeg as single arguments", async () => {
  const h = new FakeHost();
  const src = "S:\\Tom & Jerry 100%!\\x^y$z.mp4";
  h.files.set(src, new Uint8Array([1]));
  const seen = [];
  h.spawnScript(async (cmd, args, o, p) => { seen.push(args); await h.fs.write(args.at(-1), new Uint8Array([9])); p.exit(0); });
  assert.equal(await ensureProxy(h, src), "S:\\Tom & Jerry 100%!\\proxy\\x^y$z_640.mp4");
  assert.equal(seen[0][2], src);
});

test("ffmpeg failure rejects with the last stderr lines", async () => {
  const { h } = setup();
  h.spawnScript((c, a, o, p) => { p.err("a\nb\nc\nd\ne\nf\ng"); p.exit(1); });
  await assert.rejects(ensureProxy(h, SRC), (e) => /c\nd\ne\nf\ng/.test(e.message) && !/\nb\n/.test(e.message));
});

test("rejects when the proxy is missing after a successful exec", async () => {
  const { h } = setup();
  h.spawnScript((c, a, o, p) => p.exit(0));
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
  h.spawnScript(async (cmd, args, opts, p) => {
    calls.push({ cmd, args });
    await h.fs.write(PART, new Uint8Array([9]));
    p.err("boom");
    p.exit(1);
  });
  await assert.rejects(ensureProxy(h, SRC), /boom/);
  assert.equal(await h.fs.exists(PROXY), false);
  assert.equal(await h.fs.exists(PART), false);
  await assert.rejects(ensureProxy(h, SRC), /boom/);
  assert.equal(calls.length, 2);
});

test("an encode that stops without an exit code (killed, or never started) leaves no proxy at the final name", async () => {
  const { h } = setup();
  h.spawnScript(async (c, a, o, p) => { await h.fs.write(PART, new Uint8Array([9])); p.err("killed"); p.exit(null); });
  await assert.rejects(ensureProxy(h, SRC), /killed/);
  assert.equal(await h.fs.exists(PART), false);
  assert.equal(await h.fs.exists(PROXY), false);
});
