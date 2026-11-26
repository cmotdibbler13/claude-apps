import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { makeHost } from "../js/host.js";

test("FakeHost fs round-trips text and bytes", async () => {
  const h = new FakeHost();
  await h.fs.mkdir("S:\\a");
  await h.fs.write("S:\\a\\note.txt", "hello");
  assert.equal(await h.fs.read("S:\\a\\note.txt", "utf8"), "hello");
  const bytes = new Uint8Array([1, 2, 3]);
  await h.fs.write("S:\\a\\b.bin", bytes);
  assert.deepEqual(await h.fs.read("S:\\a\\b.bin"), bytes);
  await assert.rejects(h.fs.read("S:\\a\\missing.txt", "utf8"), /^Error: ENOENT/);
});

test("exists/list reflect writes, case-insensitive with mixed slashes", async () => {
  const h = new FakeHost();
  await h.fs.mkdir("S:\\Films\\One");
  await h.fs.mkdir("S:/Films/Two");
  await h.fs.write("S:\\Films\\One\\script.md", "x");
  await h.fs.write("S:/Films/Two/script.md", "y");
  assert.equal(await h.fs.exists("s:/films/one/SCRIPT.md"), true);
  assert.equal(await h.fs.exists("S:\\Films\\One"), true);
  assert.equal(await h.fs.exists("S:\\Films\\Three"), false);
  const entries = await h.fs.list("s:\\FILMS");
  assert.deepEqual(entries.map((e) => e.name).sort(), ["One", "Two"]);
  assert.ok(entries.every((e) => e.isDirectory && !e.isFile));
  const files = await h.fs.list("S:/Films/One");
  assert.deepEqual(files.map((e) => [e.name, e.isFile]), [["script.md", true]]);
});

test("rename moves the entry", async () => {
  const h = new FakeHost();
  await h.fs.mkdir("S:\\a");
  await h.fs.write("S:\\a\\tmp.json", "{}");
  await h.fs.rename("S:\\a\\tmp.json", "s:/a/state.json");
  assert.equal(await h.fs.exists("S:\\a\\tmp.json"), false);
  assert.equal(await h.fs.read("S:\\a\\state.json", "utf8"), "{}");
});

test("exec returns scripted result", async () => {
  const h = new FakeHost();
  h.execScript((cmd) => (cmd === "ffmpeg -version" ? { stdout: "ffmpeg 7", stderr: "", code: 0 } : { stdout: "", stderr: "nope", code: 1 }));
  assert.equal((await h.exec("ffmpeg -version")).stdout, "ffmpeg 7");
  assert.equal((await h.exec("other")).code, 1);
});

test("write, append and rename into a missing parent reject ENOENT; mkdir is recursive", async () => {
  const h = new FakeHost();
  await assert.rejects(h.fs.write("S:\\nope\\a.txt", "x"), /^Error: ENOENT/);
  await assert.rejects(h.fs.append("S:\\nope\\a.txt", "x"), /^Error: ENOENT/);
  await h.fs.mkdir("S:\\ok");
  await h.fs.write("S:\\ok\\a.txt", "x");
  await assert.rejects(h.fs.rename("S:\\ok\\a.txt", "S:\\nope\\b.txt"), /^Error: ENOENT/);
  assert.equal(await h.fs.exists("S:\\ok\\a.txt"), true);
  await h.fs.mkdir("S:\\deep\\er\\still");
  await h.fs.write("S:\\deep\\er\\still\\f.txt", "y");
  assert.equal(await h.fs.read("S:\\deep\\er\\still\\f.txt", "utf8"), "y");
});

test("renaming a directory moves its empty subdirectories", async () => {
  const h = new FakeHost();
  await h.fs.mkdir("S:\\old\\empty\\inner");
  await h.fs.rename("S:\\old", "S:\\new");
  assert.equal(await h.fs.exists("S:\\old"), false);
  assert.equal(await h.fs.exists("S:\\new\\empty\\inner"), true);
});

test("trash removes the entry; spawn script drives output and exit", async () => {
  const h = new FakeHost();
  await h.fs.mkdir("S:\\a");
  await h.fs.write("S:\\a\\x.txt", "1");
  await h.fs.trash("S:\\a\\x.txt");
  assert.equal(await h.fs.exists("S:\\a\\x.txt"), false);
  h.spawnScript((cmd, args, opts, p) => { p.out("line1"); p.exit(0); });
  const p = h.spawn("blender", ["-b"]);
  const seen = [];
  p.onOut((s) => seen.push(s));
  p.onExit((c) => seen.push("exit" + c));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(seen, ["line1", "exit0"]);
});

test("notify, now, mcp and claude are scripted", async () => {
  const h = new FakeHost();
  h.t = 42;
  assert.equal(h.now(), 42);
  await h.notify("done");
  assert.deepEqual(h.notified, ["done"]);
  h.mcpScript((s, t, i) => ({ s, t, i }));
  assert.deepEqual(await h.mcp.call("Higgsfield", "balance", { a: 1 }), { s: "Higgsfield", t: "balance", i: { a: 1 } });
  h.claudeScript((kind, input, opts) => ({ kind, input, tier: opts.tier }));
  assert.deepEqual(await h.claude.json("p", { tier: "quick" }), { kind: "json", input: "p", tier: "quick" });
});

function fakeClaude({ fs = true } = {}) {
  const log = [];
  const desktop = {
    permissions: { state: async (n) => (log.push("state:" + n), "granted") },
    fs: fs ? {
      readFile: async (p, e) => (log.push(["readFile", p, e]), "data"),
      readdir: async () => [{ name: "a", isFile: true, isDirectory: false, isSymbolicLink: false }],
      stat: async () => ({ size: 1 }), exists: async () => true,
      writeFile: async () => {}, appendFile: async () => {}, mkdir: async () => {}, rename: async () => {},
    } : undefined,
    shell: { trashItem: async (p) => log.push(["trash", p]), openPath: async (p) => (log.push(["open", p]), "") },
    os: { platform: async () => "win32" },
    childProcess: {
      exec: async (c, o) => (log.push(["exec", c, o]), { stdout: "o", stderr: "", code: 0 }),
      spawn: (c, a, o) => {
        const h = {};
        const proc = { stdout: { on: (_, f) => (h.out = f) }, stderr: { on: (_, f) => (h.err = f) }, on: (e, f) => (h[e] = f), kill: async () => log.push("kill") };
        proc.h = h; log.push(["spawn", c, a, o]); desktopProc = proc; return proc;
      },
    },
    notification: { show: async (o) => log.push(["notify", o.body]) },
    tray: { set: async (o) => (log.push(["tray", o.toolTip]), true) },
    window: { show: async () => log.push(["show"]) },
  };
  let desktopProc;
  const mcp = {
    callTool: async (s, t, i) => (log.push(["call", s, t, i]), { content: [], payload: { ok: 1 } }),
    listTools: async (s) => ({ servers: [{ server: s, tools: [{ name: "a" }, { name: "b" }] }] }),
  };
  const sample = Object.assign(async (i, o) => (log.push(["sample", i, o]), { text: "txt" }), {
    json: async (i, o) => (log.push(["sampleJson", i, o]), { ok: true }),
  });
  return { log, getProc: () => desktopProc, claude: { use: async (n) => ({ desktop, mcp, sample }[n] ?? null) } };
}

test("makeHost returns null without desktop.fs", async () => {
  assert.equal(await makeHost(fakeClaude({ fs: false }).claude), null);
  assert.equal(await makeHost({ use: async () => null }), null);
});

test("makeHost adapts fs, mcp payload, claude tier, and defers permissions to first use", async () => {
  const f = fakeClaude();
  const h = await makeHost(f.claude);
  assert.equal(h.platform, "win32");
  assert.deepEqual(f.log, [], "nothing requested at load");
  assert.equal(await h.fs.read("S:\\x", "utf8"), "data");
  assert.equal((await h.fs.list("S:\\"))[0].name, "a");
  await h.fs.trash("S:\\x");
  assert.deepEqual(await h.mcp.call("Higgsfield", "balance", {}), { ok: 1 });
  assert.deepEqual(await h.mcp.listTools("Higgsfield"), ["a", "b"]);
  assert.deepEqual(await h.claude.json("p", { tier: "quick" }), { ok: true });
  assert.equal(await h.claude.text("p", { tier: "complex" }), "txt");
  const sampleCalls = f.log.filter((e) => Array.isArray(e) && e[0].startsWith("sample"));
  assert.equal(sampleCalls[0][2].modelTier, "quick");
  assert.equal(sampleCalls[1][2].modelTier, "complex");
  assert.ok(!f.log.some((e) => Array.isArray(e) && (e[0] === "notify" || e[0] === "tray" || e[0] === "show")));
  await h.notify("hi");
  await h.tray({ toolTip: "t" });
  await h.showWindow();
  assert.deepEqual(f.log.filter((e) => Array.isArray(e) && (e[0] === "notify" || e[0] === "tray" || e[0] === "show")), [["notify", "hi"], ["tray", "t"], ["show"]]);
});

test("makeHost spawn wraps handlers; exec passes cwd and timeout", async () => {
  const f = fakeClaude();
  const h = await makeHost(f.claude);
  await h.exec("x", { cwd: "S:\\", timeout: 5 });
  assert.deepEqual(f.log.find((e) => e[0] === "exec")[2], { cwd: "S:\\", timeout: 5 });
  const p = h.spawn("blender", ["-b"], { cwd: "S:\\" });
  const seen = [];
  p.onOut((s) => seen.push("o" + s)); p.onErr((s) => seen.push("e" + s)); p.onExit((c) => seen.push("x" + c));
  const hs = f.getProc().h;
  hs.out("1"); hs.err("2"); hs.exit(3, null);
  assert.deepEqual(seen, ["o1", "e2", "x3"]);
});

test("makeHost has null mcp/claude when those capabilities are absent", async () => {
  const f = fakeClaude();
  const h = await makeHost({ use: async (n) => (n === "mcp" || n === "sample" ? null : f.claude.use(n)) });
  assert.equal(h.mcp, null);
  assert.equal(h.claude, null);
});

test("makeHost spawn: an error with no exit settles onExit once with null and reaches onErr; kill swallows rejection", async () => {
  const f = fakeClaude();
  const h = await makeHost(f.claude);
  const p = h.spawn("blender", ["-b"]);
  const seen = [];
  p.onErr((s) => seen.push("e" + s)); p.onExit((c) => seen.push("x" + c));
  const hs = f.getProc().h;
  hs.error(new Error("spawn blender ENOENT"));
  hs.exit(1, null);
  assert.deepEqual(seen, ["espawn blender ENOENT", "xnull"]);
  f.getProc().kill = async () => { throw new Error("gone"); };
  assert.equal(await p.kill(), undefined);
});

test("makeHost spawn: handlers registered after an error still settle", async () => {
  const f = fakeClaude();
  const h = await makeHost(f.claude);
  const p = h.spawn("blender", []);
  f.getProc().h.error(new Error("boom"));
  const seen = [];
  p.onErr((s) => seen.push("e" + s)); p.onExit((c) => seen.push("x" + c));
  assert.deepEqual(seen, ["eboom", "xnull"]);
});

test("host.open calls shell.openPath; FakeHost records opened paths", async () => {
  const f = fakeClaude();
  const h = await makeHost(f.claude);
  await h.open("S:\\a\\v.mp4");
  assert.deepEqual(f.log.filter((e) => e[0] === "open"), [["open", "S:\\a\\v.mp4"]]);
  const fh = new FakeHost();
  await fh.open("S:\\b.mp4");
  assert.deepEqual(fh.opened, ["S:\\b.mp4"]);
});
