import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { UNNAMED } from "../js/computer.js";
import { PRESENCE_DIR, BEAT_MS, SEEN_MS, makePresence, linkLine, desktopState } from "../js/presence.js";

const ROOT = "S:\\Youtube video ideas";
const dir = `${ROOT}\\${PRESENCE_DIR}`;
const st = { paused: false, running: 1, waiting: 2, tools: { comfy: true } };

test("constants", () => {
  assert.equal(PRESENCE_DIR, ".studio-presence");
  assert.equal(BEAT_MS, 30000);
  assert.equal(SEEN_MS, 90000);
});

test("beat writes this computer's file, tmp then rename, and makes the folder", async () => {
  const host = new FakeHost();
  const p = makePresence(host, { root: ROOT, computer: "LAPTOP", role: "laptop", state: () => st });
  await p.beat();
  const file = JSON.parse(await host.fs.read(`${dir}\\LAPTOP.json`, "utf8"));
  assert.deepEqual(file, { computer: "LAPTOP", role: "laptop", at: host.now(), paused: false, running: 1, waiting: 2, tools: { comfy: true } });
  assert.equal(await host.fs.exists(`${dir}\\LAPTOP.json.tmp`), false);
  assert.equal(p.serverError, null);
});

test("an unnamed computer writes nothing", async () => {
  const host = new FakeHost();
  const p = makePresence(host, { root: ROOT, computer: UNNAMED, role: "laptop", state: () => st });
  await p.beat();
  assert.equal(await host.fs.exists(dir), false);
});

test("a failed write sets serverError and the next success clears it", async () => {
  const host = new FakeHost();
  const real = host.fs.write;
  host.fs.write = async () => { throw new Error("share offline"); };
  const p = makePresence(host, { root: ROOT, computer: "LAPTOP", role: "laptop", state: () => st });
  await p.beat();
  assert.match(p.serverError, /share offline/);
  host.fs.write = real;
  await p.beat();
  assert.equal(p.serverError, null);
});

const put = async (host, name, obj) => {
  await host.fs.mkdir(dir);
  await host.fs.write(`${dir}\\${name}.json`, JSON.stringify(obj));
};

test("read skips its own file and returns peers", async () => {
  const host = new FakeHost();
  const p = makePresence(host, { root: ROOT, computer: "LAPTOP", role: "laptop", state: () => st });
  await p.beat();
  await put(host, "DESK", { computer: "DESK", role: "desktop", at: host.now(), paused: true, running: 0, waiting: 0, tools: {} });
  const peers = await p.read();
  assert.equal(peers.length, 1);
  assert.deepEqual(peers[0], { computer: "DESK", role: "desktop", seen: true, lastSeen: host.now(), paused: true, running: 0, waiting: 0, tools: {} });
});

test("seen follows changes by the reader's clock, not the peer's own at", async () => {
  const host = new FakeHost();
  const p = makePresence(host, { root: ROOT, computer: "LAPTOP", role: "laptop", state: () => st });
  const t0 = host.now();
  const beat = (at) => put(host, "DESK", { computer: "DESK", role: "desktop", at, paused: false, running: 0, waiting: 0, tools: {} });
  await beat(t0 + 3_600_000);
  assert.equal((await p.read())[0].seen, true);
  host.t = t0 + 30_000;
  await beat(t0 + 3_600_000 + 30_000);
  let [d] = await p.read();
  assert.equal(d.seen, true);
  assert.equal(d.lastSeen, t0 + 30_000);
  host.t = t0 + 30_000 + 91_000;
  [d] = await p.read();
  assert.equal(d.seen, false);
  assert.equal(d.lastSeen, t0 + 30_000);
});

test("read of a missing or unreadable folder sets serverError and returns no peers", async () => {
  const host = new FakeHost();
  const p = makePresence(host, { root: ROOT, computer: "LAPTOP", role: "laptop", state: () => st });
  assert.deepEqual(await p.read(), []);
  assert.ok(p.serverError);
});

const peer = (o) => ({ computer: "DESK", role: "desktop", seen: true, lastSeen: new Date(2026, 10, 28, 9, 5).getTime(), paused: false, running: 0, waiting: 0, tools: {}, ...o });
const line = (o) => linkLine({ role: "laptop", peers: [], serverError: null, root: ROOT, now: 0, ...o });

test("linkLine on the laptop", () => {
  assert.equal(line({ peers: [peer({})] }), "Desktop: ready");
  assert.equal(line({ peers: [peer({ running: 1 })] }), "Desktop: busy (1 job)");
  assert.equal(line({ peers: [peer({ running: 2 })] }), "Desktop: busy (2 jobs)");
  assert.equal(line({ peers: [peer({ paused: true, running: 2 })] }), "Desktop: laptop jobs paused");
  assert.equal(line({ peers: [peer({ seen: false })] }), "Desktop: not seen since 09:05");
  assert.equal(line({ peers: [] }), "Desktop: not seen yet");
  assert.equal(line({ peers: [peer({ role: "laptop", computer: "L2" })] }), "Desktop: not seen yet");
});

test("linkLine follows the most recently seen desktop", () => {
  const old = peer({ computer: "OLD", seen: false, lastSeen: 1000 });
  assert.equal(line({ peers: [old, peer({})] }), "Desktop: ready");
});

test("linkLine reports a server that can't be reached first", () => {
  const got = line({ serverError: "offline", peers: [peer({})] });
  assert.ok(got.startsWith(`Can't reach the server (${ROOT})`));
  assert.equal(linkLine({ role: "desktop", peers: [], serverError: "x", root: ROOT, now: 0 }), `Can't reach the server (${ROOT})`);
});

test("linkLine on the desktop", () => {
  const l = (o) => peer({ role: "laptop", computer: "LAPTOP", ...o });
  const d = (peers) => linkLine({ role: "desktop", peers, serverError: null, root: ROOT, now: 0 });
  assert.equal(d([]), null);
  assert.equal(d([l({ waiting: 1 })]), "Laptop: seen just now · 1 waiting");
  assert.equal(d([l({ waiting: 1, running: 2 })]), "Laptop: seen just now · 1 waiting, 2 running");
  assert.equal(d([l({ running: 2 })]), "Laptop: seen just now · 2 running");
  assert.equal(d([l({})]), "Laptop: seen just now");
  assert.equal(d([l({ seen: false })]), "Laptop: last seen 09:05");
  assert.equal(d([l({}), l({ computer: "OTHER", seen: false })]), "LAPTOP: seen just now; OTHER: last seen 09:05");
});

test("desktopState", () => {
  const ds = (peers) => desktopState(peers);
  assert.deepEqual(ds([peer({})]), { text: "", ready: true });
  assert.deepEqual(ds([peer({ running: 1 })]), { text: " (busy)", ready: true });
  assert.deepEqual(ds([peer({ paused: true })]), { text: " (laptop jobs paused)", ready: false });
  assert.deepEqual(ds([peer({ seen: false })]), { text: " (not seen since 09:05)", ready: false });
  assert.deepEqual(ds([]), { text: " (not seen yet)", ready: false });
});

test("a good read does not clear a failed beat in the same cycle", async () => {
  const host = new FakeHost();
  await put(host, "DESK", { computer: "DESK", role: "desktop", at: host.now(), paused: false, running: 0, waiting: 0, tools: {} });
  const real = host.fs.write;
  host.fs.write = async () => { throw new Error("share read-only"); };
  const p = makePresence(host, { root: ROOT, computer: "LAPTOP", role: "laptop", state: () => st });
  await p.beat();
  await p.read();
  assert.match(p.serverError, /read-only/);
  host.fs.write = real;
  await p.beat();
  await p.read();
  assert.equal(p.serverError, null);
  // and a failed read is reported even after a good beat
  const list = host.fs.list;
  host.fs.list = async () => { throw new Error("gone"); };
  await p.beat();
  await p.read();
  assert.match(p.serverError, /gone/);
  host.fs.list = list;
});
