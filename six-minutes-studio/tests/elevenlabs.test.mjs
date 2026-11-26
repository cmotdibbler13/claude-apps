import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { nodeSpec, nodeSig, ensureFlow, addNode, estimate, parseStatus, makeElevenRunner } from "../js/tools/elevenlabs.js";

const OUT = "S:\\Film A\\studio\\media\\SC-01_t1";
const URL = "https://elevenlabsusercontent.com/database/workspace/abc/content_generation/S1/G1/content.mp3?Expires=1795734000&KeyName=assets-cdn-key-1&Signature=Y5Dht5T-7GhizIOj4La2yn0jOOI=";
const OBSERVED = {
  flow_id: "LuQhqzVFRiQ7pcHGwBhi", session_id: "ZqTHWYSsyOElngEmp0i0",
  generations: [{ id: "1zdNOoH1JZdmYMuO5o4q", status: "completed", model_id: "eleven_music_v2_5", modality: "audio", duration_secs: 410, price: { credits: 6148.633333333332 }, content_url: URL }],
  all_completed: true, has_failures: false, session_ids: ["ZqTHWYSsyOElngEmp0i0"],
  media: [{ generation_id: "1zdNOoH1JZdmYMuO5o4q", kind: "audio", url: URL, master_url: URL }],
};
const running = { all_completed: false, has_failures: false, poll_after_seconds: 7, generations: [] };
const job = (sfx = false, extra = {}) => ({ id: "j1", tool: "elevenlabs", input: { kind: sfx ? "sfx" : "score", flowId: "F1", nodeId: "N1", out: OUT, sfx }, ...extra });

function setup({ mcp, spawn } = {}) {
  const host = new FakeHost();
  const calls = [], order = [], sleeps = [];
  host.mcpScript((s, t, i) => { calls.push({ s, t, i }); order.push(t); return mcp(t, i, calls); });
  const spawns = [];
  host.spawnScript(async (cmd, args, o, p) => {
    spawns.push({ cmd, args });
    if (spawn) return spawn(cmd, args, p, host);
    if (cmd === "curl") { await host.fs.write(args[args.indexOf("-o") + 1], "data"); return p.exit(0); }
    if (cmd === "ffmpeg") {
      if (args.includes("volumedetect")) { p.err("Duration: 00:00:02.00\nmean_volume: -20.0 dB\nmax_volume: -3.0 dB\n"); return p.exit(0); }
      await host.fs.write(args[args.length - 1], "wav"); return p.exit(0);
    }
    p.exit(0);
  });
  const runner = makeElevenRunner({ sleep: async (ms) => { sleeps.push(ms); host.t += ms; } });
  const ctx = { host, progress: () => {}, setRef: (r) => order.push("setRef:" + r) };
  return { host, calls, order, runner, ctx, sleeps, spawns };
}
const ok = (t) => (t === "creative_run_flow_nodes" ? { session_ids: ["S1"] } : OBSERVED);

test("nodeSpec score and sfx", () => {
  assert.deepEqual(nodeSpec("score", { prompt: "p", durationS: 410 }), {
    node_type: "music", model_id: "eleven_music_v2_5", prompt: "p",
    model_parameters: { duration_seconds: 410, lyrics_type: "instrumental", instrumental: true },
  });
  assert.equal(nodeSpec("score", { prompt: "p", durationS: 900 }).model_parameters.duration_seconds, 600);
  assert.equal(nodeSpec("score", { prompt: "p", durationS: 1 }).model_parameters.duration_seconds, 3);
  const s = nodeSpec("sfx", { prompt: "p", durationS: 45, loop: true });
  assert.equal(s.node_type, "sfx");
  assert.equal(s.model_id, "eleven_text_to_sound_v3");
  assert.deepEqual(s.model_parameters, { duration_seconds: 30, prompt_influence: 0.3, loop: true });
  assert.equal(nodeSpec("sfx", { prompt: "p", durationS: 0.1 }).model_parameters.duration_seconds, 0.5);
  assert.equal(nodeSpec("sfx", { prompt: "p", durationS: 2 }).model_parameters.loop, false);
  assert.equal(nodeSig("sfx", { prompt: "p", durationS: 2 }), JSON.stringify(nodeSpec("sfx", { prompt: "p", durationS: 2 })));
});

test("ensureFlow and addNode", async () => {
  const t = setup({ mcp: (tool) => (tool === "creative_create_flow" ? { flow_id: "F9" } : { node: { id: "N9" } }) });
  assert.equal(await ensureFlow(t.host, "Film"), "F9");
  assert.deepEqual(t.calls[0].i, { name: "Film" });
  assert.equal(await addNode(t.host, "F9", "score", { prompt: "p", durationS: 30 }, "SC-01"), "N9");
  assert.equal(t.calls[1].t, "creative_add_flow_node");
  const bad = setup({ mcp: () => ({}) });
  await assert.rejects(addNode(bad.host, "F", "sfx", { prompt: "p", durationS: 2 }, "x"));
});

test("parseStatus on the observed payload", () => {
  const s = parseStatus(OBSERVED);
  assert.equal(s.done, true);
  assert.equal(s.failed, false);
  assert.match(s.url, /content\.mp3\?Expires=/);
  assert.equal(parseStatus(running).poll, 7);
  assert.equal(parseStatus({}).poll, 10);
  assert.equal(parseStatus({ poll_after_seconds: 1 }).poll, 5);
  const f = parseStatus({ has_failures: true, generations: [{ error: "boom" }] });
  assert.equal(f.failed, true);
  assert.equal(f.error, "boom");
  assert.equal(parseStatus({ has_failures: true }).error, "ElevenLabs reported a failure");
  assert.equal(parseStatus({ all_completed: true, media: [{ master_url: "https://x/y.wav" }] }).url, "https://x/y.wav");
});

test("estimate sends estimate_only and rounds up", async () => {
  const t = setup({ mcp: () => ({ credits: 6148.6 }) });
  assert.equal(await estimate(t.host, "F1", "N1"), 6149);
  assert.deepEqual(t.calls[0].i, { flow_id: "F1", node_ids: ["N1"], estimate_only: true, generations_count: 1 });
  assert.equal(await estimate(setup({ mcp: () => ({ plan: { total_credit_cost: 12 } }) }).host, "F", "N"), 12);
  assert.equal(await estimate(setup({ mcp: () => ({ nothing: 1 }) }).host, "F", "N"), null);
});

test("start runs once, sets ref before polling, writes score", async () => {
  const t = setup({ mcp: ok });
  const r = await t.runner.start(job(), t.ctx);
  assert.deepEqual(t.order.slice(0, 3), ["creative_run_flow_nodes", "setRef:" + JSON.stringify({ flowId: "F1", sessionId: "S1" }), "creative_get_flow_run_status"]);
  assert.equal(t.calls.filter((c) => c.t === "creative_run_flow_nodes").length, 1);
  assert.deepEqual(t.calls[0].i, { flow_id: "F1", node_ids: ["N1"], generations_count: 1 });
  assert.equal("estimate_only" in t.calls[0].i, false);
  assert.deepEqual(t.calls[1].i, { flow_id: "F1", session_ids: ["S1"] });
  assert.equal(r.file, OUT + ".mp3");
  assert.equal(await t.host.fs.exists(OUT + ".mp3"), true);
  assert.equal(r.meta.source, "elevenlabs");
  assert.equal(r.meta.quiet, false);
  const curl = t.spawns.find((s) => s.cmd === "curl");
  assert.equal(curl.args.at(-1), URL);
});

test("sfx keeps the original and finishes to wav", async () => {
  const t = setup({ mcp: ok });
  const r = await t.runner.start(job(true), t.ctx);
  assert.equal(await t.host.fs.exists(OUT + ".orig.mp3"), true);
  assert.equal(await t.host.fs.exists(OUT + ".wav"), true);
  assert.equal(r.file, OUT + ".wav");
});

test("polls using poll_after_seconds until done", async () => {
  let n = 0;
  const t = setup({ mcp: (tool) => (tool === "creative_run_flow_nodes" ? { session_id: "S1" } : ++n < 3 ? running : OBSERVED) });
  await t.runner.start(job(), t.ctx);
  assert.deepEqual(t.sleeps, [7000, 7000]);
});

test("resume polls and downloads, never runs a node", async () => {
  const t = setup({ mcp: ok });
  const r = await t.runner.resume(job(false, { jobRef: JSON.stringify({ flowId: "F1", sessionId: "S1" }) }), t.ctx);
  assert.equal(t.calls.some((c) => c.t === "creative_run_flow_nodes"), false);
  assert.equal(r.file, OUT + ".mp3");
  await assert.rejects(t.runner.resume(job(), t.ctx), /no jobRef/);
});

test("403 download gives the expired link message", async () => {
  const t = setup({ mcp: ok, spawn: (cmd, args, p) => { p.err("curl: (22) The requested URL returned error: 403"); p.exit(22); } });
  await assert.rejects(t.runner.start(job(), t.ctx), /link has expired; open the flow in ElevenLabs/);
});

test("rejects unsafe urls", async () => {
  for (const bad of ["http://x/a.mp3", "https://x/a b.mp3", 'https://x/a".mp3']) {
    const t = setup({ mcp: (tool) => (tool === "creative_run_flow_nodes" ? { session_ids: ["S1"] } : { all_completed: true, media: [{ url: bad }] }) });
    await assert.rejects(t.runner.start(job(), t.ctx), /refusing to download/);
    assert.equal(t.spawns.some((s) => s.cmd === "curl"), false);
  }
});

test("server_unavailable on run is ambiguous; definite codes are not", async () => {
  const t = setup({ mcp: () => { throw Object.assign(new Error("down"), { code: "server_unavailable" }); } });
  await assert.rejects(t.runner.start(job(), t.ctx), (e) => e.ambiguous === true && /ElevenLabs may have started this take\. Use Check again before running it again\./.test(e.message));
  const d = setup({ mcp: () => { throw Object.assign(new Error("bad"), { code: "bad_request" }); } });
  await assert.rejects(d.runner.start(job(), d.ctx), (e) => !e.ambiguous);
});

test("failure, repeated status errors and the cap", async () => {
  const f = setup({ mcp: (tool) => (tool === "creative_run_flow_nodes" ? { session_ids: ["S1"] } : { has_failures: true, generations: [{ error: "nope" }] }) });
  await assert.rejects(f.runner.start(job(), f.ctx), (e) => !e.ambiguous && /nope/.test(e.message));
  const e5 = setup({ mcp: (tool) => { if (tool === "creative_run_flow_nodes") return { session_ids: ["S1"] }; throw new Error("net"); } });
  await assert.rejects(e5.runner.start(job(), e5.ctx), (e) => e.ambiguous === true);
  assert.equal(e5.calls.filter((c) => c.t === "creative_get_flow_run_status").length, 5);
  const cap = setup({ mcp: (tool) => (tool === "creative_run_flow_nodes" ? { session_ids: ["S1"] } : running) });
  await assert.rejects(cap.runner.start(job(), cap.ctx), (e) => e.ambiguous === true && /30 min/.test(e.message));
});

test("run errors: only a DEFINITE string code is definite", async () => {
  for (const mk of [() => new Error("x"), () => Object.assign(new Error("x"), { code: 500 })]) {
    const t = setup({ mcp: () => { throw mk(); } });
    await assert.rejects(t.runner.start(job(), t.ctx), (e) => e.ambiguous === true);
  }
});

test("run without a session id is ambiguous", async () => {
  const t = setup({ mcp: () => ({}) });
  await assert.rejects(t.runner.start(job(), t.ctx), (e) => e.ambiguous === true);
  assert.equal(t.order.some((o) => o.startsWith("setRef")), false);
});

test("non-403 download failure after a run is ambiguous", async () => {
  const t = setup({ mcp: ok, spawn: (cmd, args, p) => { p.err("curl: (6) could not resolve"); p.exit(6); } });
  await assert.rejects(t.runner.start(job(), t.ctx), (e) => e.ambiguous === true && /^The take was made but couldn't be saved: .*Use Check again to download it\.$/.test(e.message));
  const e403 = setup({ mcp: ok, spawn: (cmd, args, p) => { p.err("403"); p.exit(22); } });
  await assert.rejects(e403.runner.start(job(), e403.ctx), (e) => !e.ambiguous);
});

test("estimate ignores balance-like keys", async () => {
  assert.equal(await estimate(setup({ mcp: () => ({ balance: { credits_remaining: 900 }, cost: { credits: 12 } }) }).host, "F", "N"), 12);
  assert.equal(await estimate(setup({ mcp: () => ({ credits_remaining: 900 }) }).host, "F", "N"), null);
});

test("nodeSpec needs a length", () => {
  for (const d of [undefined, NaN, "x"]) assert.throws(() => nodeSpec("score", { prompt: "p", durationS: d }), /Set a length first\./);
});
