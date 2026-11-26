import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { makeHiggsfieldRunner, higgsfieldRunner } from "../js/tools/higgsfield.js";

const ROOT = "S:\\Youtube video ideas\\Film A";
const MEDIA = ROOT + "\\studio\\media";
const OUT = MEDIA + "\\HF-07_t3";
const UUID = "123e4567-e89b-12d3-a456-426614174000";
const settings = { videoModel: "kling3_0", imageModel: "gpt_image_2", blenderPath: "blender" };
const job = (kind = "broll", extra = {}) => ({ id: "j1", tool: "higgsfield", input: { kind, prompt: "a dark harbour", out: OUT }, ...extra });

function setup({ mcp, sleeps = [], exec } = {}) {
  const host = new FakeHost();
  const calls = [];
  const refs = [];
  const progress = [];
  host.mcpScript((s, t, i) => { calls.push({ s, t, i }); return mcp(t, i, calls); });
  host.execScript(exec ?? (async (cmd) => {
    const m = cmd.match(/-o "([^"]+)"/);
    if (m) { await host.fs.write(m[1], "data"); }
    return { stdout: "", stderr: "", code: 0 };
  }));
  const runner = makeHiggsfieldRunner({ settings, sleep: async (ms) => { sleeps.push(ms); host.t += ms; } });
  const ctx = { host, progress: (p, e) => progress.push([p, e]), setRef: (r) => refs.push(r) };
  return { host, calls, refs, progress, runner, ctx, sleeps };
}
const done = (url = "https://cdn.example.com/x/out.mp4?sig=1") => ({ jobs: [{ job_id: UUID, status: "completed", url }], all_terminal: true });
const running = () => ({ jobs: [{ job_id: UUID, status: "in_progress" }], all_terminal: false, poll_after_seconds: 5 });

test("runner lane is connector; default runner exported", () => {
  assert.equal(higgsfieldRunner.lane, "connector");
  assert.equal(makeHiggsfieldRunner({ settings }).lane, "connector");
});

test("stores jobRef before waiting", async () => {
  const order = [];
  const t = setup({ mcp: (tool) => { order.push(tool); return tool === "generate_video" ? { job_id: UUID } : done(); } });
  t.ctx.setRef = (r) => order.push("setRef:" + r);
  await t.runner.start(job(), t.ctx);
  assert.deepEqual(order, ["generate_video", "setRef:" + UUID, "jobs_wait"]);
});

test("broll calls generate_video with params; lineart calls generate_image", async () => {
  const a = setup({ mcp: (tool) => (tool === "generate_video" ? { id: UUID } : done()) });
  await a.runner.start(job("broll"), a.ctx);
  assert.equal(a.calls[0].s, "Higgsfield");
  assert.deepEqual(a.calls[0].i, { params: { model: "kling3_0", prompt: "a dark harbour", aspect_ratio: "16:9", count: 1, use_unlim: false, mode: "pro", sound: false } });
  const b = setup({ mcp: (tool) => (tool === "generate_image" ? { jobs: [{ id: UUID }] } : done("https://cdn.example.com/a.png")) });
  const r = await b.runner.start(job("lineart"), b.ctx);
  assert.equal(b.calls[0].t, "generate_image");
  assert.deepEqual(b.calls[0].i, { params: { model: "gpt_image_2", prompt: "a dark harbour", aspect_ratio: "16:9", count: 1, use_unlim: false } });
  assert.equal(r.file, OUT + ".png");
});

test("job id parsed from alternate shapes", async () => {
  for (const payload of [{ results: [{ job_id: UUID }] }, { text: `queued ${UUID} ok` }, { jobs: [{ job_id: UUID }] }]) {
    const t = setup({ mcp: (tool) => (tool === "generate_video" ? payload : done()) });
    await t.runner.start(job(), t.ctx);
    assert.deepEqual(t.refs, [UUID]);
    assert.deepEqual(t.calls[1].i, { jobs: [{ index: 0, job_id: UUID }], timeout_seconds: 15 });
  }
});

test("no job id rejects without a second generate call", async () => {
  const t = setup({ mcp: () => ({ weird: "shape" }) });
  await assert.rejects(t.runner.start(job(), t.ctx), /job id.*weird/s);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.refs, []);
});

test("unlim_choice rejects with balance message", async () => {
  const t = setup({ mcp: () => ({ unlim_choice: { options: [] } }) });
  await assert.rejects(t.runner.start(job(), t.ctx), /asking which balance to use; open Higgsfield and choose, then Run again\./);
  assert.equal(t.calls.length, 1);
});

test("connector error rejects with the connector's message and makes no second generate call", async () => {
  const t = setup({ mcp: () => { throw new Error("Insufficient credits"); } });
  await assert.rejects(t.runner.start(job(), t.ctx), /Insufficient credits/);
  assert.equal(t.calls.filter((c) => c.t.startsWith("generate_")).length, 1);
});

test("polls no faster than every 20 s", async () => {
  let n = 0;
  const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : ++n < 3 ? running() : done()) });
  await t.runner.start(job(), t.ctx);
  assert.equal(n, 3);
  assert.deepEqual(t.sleeps, [20000, 20000]);
});

test("honours poll_after_seconds above 20", async () => {
  let n = 0;
  const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : ++n < 2 ? { ...running(), poll_after_seconds: 45 } : done()) });
  await t.runner.start(job(), t.ctx);
  assert.deepEqual(t.sleeps, [45000]);
});

test("progress is indeterminate while waiting", async () => {
  let n = 0;
  const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : ++n < 2 ? running() : done()) });
  await t.runner.start(job(), t.ctx);
  assert.ok(t.progress.length >= 1);
  assert.ok(t.progress.every(([p]) => p === null));
});

test("downloads result into studio media with take-numbered name", async () => {
  const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : done()) });
  const r = await t.runner.start(job(), t.ctx);
  assert.equal(r.file, OUT + ".mp4");
  assert.ok(await t.host.fs.exists(OUT + ".mp4"));
  assert.ok(await t.host.fs.exists(MEDIA));
});

test("extension taken from result url", async () => {
  const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : done("https://cdn.example.com/clip.webm")) });
  const r = await t.runner.start(job(), t.ctx);
  assert.equal(r.file, OUT + ".webm");
});

test("failure status rejects with error text", async () => {
  const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : { jobs: [{ status: "nsfw", error: "Blocked by moderation" }], all_terminal: true }) });
  await assert.rejects(t.runner.start(job(), t.ctx), /nsfw.*Blocked by moderation|Blocked by moderation/);
});

test("non-https url refused", async () => {
  const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : done("http://evil.example.com/x.mp4")) });
  await assert.rejects(t.runner.start(job(), t.ctx));
  assert.ok(!t.calls.some((c) => c.t === "x"));
});

test("download failure rejects", async () => {
  const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : done()), exec: async () => ({ stdout: "", stderr: "404", code: 22 }) });
  await assert.rejects(t.runner.start(job(), t.ctx), /download/i);
  const u = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : done()), exec: async () => ({ stdout: "", stderr: "", code: 0 }) });
  await assert.rejects(u.runner.start(job(), u.ctx), /download/i);
});

test("30 minute cap rejects keeping the ref", async () => {
  const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : running()) });
  await assert.rejects(t.runner.start(job(), t.ctx), /Still running on Higgsfield after 30 min/);
  assert.deepEqual(t.refs, [UUID]);
  assert.ok(t.sleeps.every((s) => s >= 20000));
  assert.ok(t.sleeps.length <= 91);
});

test("resume waits from jobRef without generating", async () => {
  const t = setup({ mcp: () => done() });
  const r = await t.runner.resume(job("broll", { jobRef: UUID }), t.ctx);
  assert.equal(r.file, OUT + ".mp4");
  assert.ok(t.calls.every((c) => c.t === "jobs_wait"));
  assert.deepEqual(t.calls[0].i.jobs, [{ index: 0, job_id: UUID }]);
});

test("resume retries transient jobs_wait errors up to 5 times, 20 s apart", async () => {
  let n = 0;
  const t = setup({ mcp: () => { if (++n <= 2) throw new Error("socket hang up"); return done(); } });
  await t.runner.resume(job("broll", { jobRef: UUID }), t.ctx);
  assert.equal(n, 3);
  assert.deepEqual(t.sleeps, [20000, 20000]);
});

test("resume gives up after 5 consecutive errors with a no-rerun message", async () => {
  const t = setup({ mcp: () => { throw new Error("offline"); } });
  await assert.rejects(t.runner.resume(job("broll", { jobRef: UUID }), t.ctx), /Couldn't reach Higgsfield to check this job; it may still be running\. Run again only if you're sure it failed\./);
  assert.equal(t.calls.length, 5);
});

test("resume rejects on definite failure", async () => {
  const t = setup({ mcp: () => ({ jobs: [{ status: "failed", error: "boom" }] }) });
  await assert.rejects(t.runner.resume(job("broll", { jobRef: UUID }), t.ctx), /boom/);
});

test("resume without jobRef rejects", async () => {
  const t = setup({ mcp: () => done() });
  await assert.rejects(t.runner.resume(job(), t.ctx), /jobRef/);
});

test("start survives 4 thrown jobs_wait calls and succeeds; generate called once", async () => {
  let n = 0;
  const t = setup({ mcp: (tool) => { if (tool === "generate_video") return { job_id: UUID }; if (++n <= 4) throw new Error("blip"); return done(); } });
  const r = await t.runner.start(job(), t.ctx);
  assert.equal(r.file, OUT + ".mp4");
  assert.equal(t.calls.filter((c) => c.t === "generate_video").length, 1);
  assert.deepEqual(t.sleeps, [20000, 20000, 20000, 20000]);
});

test("start rejects with the unreachable message after 5 consecutive jobs_wait errors, keeping jobRef", async () => {
  const t = setup({ mcp: (tool) => { if (tool === "generate_video") return { job_id: UUID }; throw new Error("offline"); } });
  await assert.rejects(t.runner.start(job(), t.ctx), /Couldn't reach Higgsfield to check this job; it may still be running\. Run again only if you're sure it failed\./);
  assert.deepEqual(t.refs, [UUID]);
  assert.equal(t.calls.filter((c) => c.t === "generate_video").length, 1);
});

test("unsafe result URL characters are rejected without running curl", async () => {
  for (const bad of ["https://cdn.example.com/a.mp4?x=%41", "https://cdn.example.com/a'b.mp4", "https://cdn.example.com/a`b.mp4", "https://cdn.example.com/a$b.mp4", "https://cdn.example.com/a!b.mp4", "https://cdn.example.com/a^b.mp4"]) {
    let execs = 0;
    const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : done(bad)), exec: async () => { execs++; return { code: 0 }; } });
    await assert.rejects(t.runner.start(job(), t.ctx), /unsafe/, bad);
    assert.equal(execs, 0);
  }
});

test("a URL with an apostrophe is not silently truncated", async () => {
  let cmd = "";
  const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : done("https://cdn.example.com/a'b.mp4")), exec: async (c) => { cmd = c; return { code: 0 }; } });
  await assert.rejects(t.runner.start(job(), t.ctx), /unsafe/);
  assert.equal(cmd, "");
});

test("unsafe output path characters are rejected without running curl", async () => {
  for (const ch of ['"', "%", "&", "|", "<", ">", "^", "`", "$", "!"]) {
    let execs = 0;
    const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : done()), exec: async () => { execs++; return { code: 0 }; } });
    const j = job(); j.input.out = OUT + ch + "x";
    await assert.rejects(t.runner.start(j, t.ctx), /unsafe/, ch);
    assert.equal(execs, 0);
  }
});

test("all_terminal with no result rejects at once with the entry's status", async () => {
  let waits = 0;
  const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : (waits++, { jobs: [{ job_id: UUID, status: "expired", error: "Took too long" }], all_terminal: true })) });
  await assert.rejects(t.runner.start(job(), t.ctx), /expired.*Took too long/);
  assert.equal(waits, 1);
  const u = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : { jobs: [{ job_id: UUID }], all_terminal: true }) });
  await assert.rejects(u.runner.start(job(), u.ctx), /ended without a result/);
});

test("ambiguous failures are flagged: unreachable, 30 min cap, server_unavailable or upstream_error on generate", async () => {
  const a = setup({ mcp: (tool) => { if (tool === "generate_video") return { job_id: UUID }; throw new Error("offline"); } });
  await assert.rejects(a.runner.start(job(), a.ctx), (e) => e.ambiguous === true);
  const b = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : running()) });
  await assert.rejects(b.runner.start(job(), b.ctx), (e) => e.ambiguous === true);
  for (const code of ["server_unavailable", "upstream_error"]) {
    const c = setup({ mcp: () => { throw Object.assign(new Error("timed out"), { code }); } });
    await assert.rejects(c.runner.start(job(), c.ctx), (e) => e.ambiguous === true && /timed out/.test(e.message));
  }
  const d = setup({ mcp: () => { throw Object.assign(new Error("Insufficient credits"), { code: "tool_error" }); } });
  await assert.rejects(d.runner.start(job(), d.ctx), (e) => !e.ambiguous);
});
