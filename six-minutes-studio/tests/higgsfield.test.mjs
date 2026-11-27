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

function setup({ mcp, sleeps = [], spawn } = {}) {
  const host = new FakeHost();
  const calls = [];
  const refs = [];
  const progress = [];
  host.mcpScript((s, t, i) => { calls.push({ s, t, i }); return mcp(t, i, calls); });
  const spawns = [];
  host.spawnScript(async (cmd, args, o, p) => {
    spawns.push({ cmd, args });
    if (spawn) return spawn(cmd, args, p, host);
    const i = args.indexOf("-o");
    if (i >= 0) await host.fs.write(args[i + 1], "data");
    p.exit(0);
  });
  const runner = makeHiggsfieldRunner({ settings, sleep: async (ms) => { sleeps.push(ms); host.t += ms; } });
  const ctx = { host, progress: (p, e) => progress.push([p, e]), setRef: (r) => refs.push(r) };
  return { host, calls, refs, progress, runner, ctx, sleeps, spawns };
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
  const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : done()), spawn: (c, a, p) => { p.err("404"); p.exit(22); } });
  await assert.rejects(t.runner.start(job(), t.ctx), /Download failed \(curl exit 22\): 404/);
  const u = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : done()), spawn: (c, a, p) => p.exit(0) });
  await assert.rejects(u.runner.start(job(), u.ctx), /download/i);
});

test("curl runs with an argument list, no shell", async () => {
  const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : done()) });
  await t.runner.start(job(), t.ctx);
  assert.equal(t.spawns.length, 1);
  assert.equal(t.spawns[0].cmd, "curl");
  assert.deepEqual(t.spawns[0].args.slice(-3), ["-o", OUT + ".mp4", "https://cdn.example.com/x/out.mp4?sig=1"]);
});

test("an output folder that can't be made fails before generating", async () => {
  const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : done()) });
  t.host.fs.mkdir = async () => { throw new Error("EACCES: permission denied"); };
  await assert.rejects(t.runner.start(job(), t.ctx), /EACCES.*not generating/);
  assert.equal(t.calls.length, 0);
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
    const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : done(bad)) });
    await assert.rejects(t.runner.start(job(), t.ctx), /unsafe/, bad);
    assert.equal(t.spawns.length, 0);
  }
});

test("output folders with & % ! ^ $ ` download fine: the path goes in as one argument", async () => {
  for (const ch of ["%", "&", "^", "`", "$", "!"]) {
    const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : done()) });
    const j = job(); j.input.out = MEDIA + `\Tom ${ch} Jerry\HF-07_t3`;
    const r = await t.runner.start(j, t.ctx);
    assert.equal(r.file, j.input.out + ".mp4", ch);
    assert.equal(t.spawns[0].args.at(-2), j.input.out + ".mp4");
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

const finished = (entry) => ({ jobs: [{ job_id: UUID, status: "completed", ...entry }], all_terminal: true });
const curlUrl = (t) => t.spawns[0]?.args.at(-1);

test("known result keys win over other URLs in the reply", async () => {
  const cases = [
    [{ thumbnail: "https://cdn.example.com/x/thumb.jpg", result_url: "https://cdn.example.com/x/out.mp4" }, "https://cdn.example.com/x/out.mp4"],
    [{ preview: "https://cdn.example.com/p.webp", results: [{ url: "https://cdn.example.com/r.mov" }] }, "https://cdn.example.com/r.mov"],
    [{ poster: "https://cdn.example.com/p.png", outputs: [{ url: "https://cdn.example.com/o.webm" }] }, "https://cdn.example.com/o.webm"],
    [{ cover: "https://cdn.example.com/c.jpg", video_url: "https://cdn.example.com/v.mp4" }, "https://cdn.example.com/v.mp4"],
  ];
  for (const [entry, want] of cases) {
    const t = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : finished(entry)) });
    await t.runner.start(job("broll"), t.ctx);
    assert.equal(curlUrl(t), want);
  }
  const t = setup({ mcp: (tool) => (tool === "generate_image" ? { job_id: UUID } : finished({ logo: "https://cdn.example.com/l.svg", image_url: "https://cdn.example.com/i.jpeg" })) });
  const r = await t.runner.start(job("lineart"), t.ctx);
  assert.equal(curlUrl(t), "https://cdn.example.com/i.jpeg");
  assert.equal(r.file, OUT + ".jpeg");
});

test("b-roll takes only video files and line art only image files", async () => {
  const a = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : finished({ note: "see https://cdn.example.com/still.png" })) });
  await assert.rejects(a.runner.start(job("broll"), a.ctx), /no video result URL/);
  assert.equal(a.spawns.length, 0);
  const b = setup({ mcp: (tool) => (tool === "generate_image" ? { job_id: UUID } : finished({ url: "https://cdn.example.com/x.mp4" })) });
  await assert.rejects(b.runner.start(job("lineart"), b.ctx), /no image result URL/);
  const c = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : finished({ url: "https://cdn.example.com/page.html" })) });
  await assert.rejects(c.runner.start(job("broll"), c.ctx), /no video result URL/);
  const d = setup({ mcp: (tool) => (tool === "generate_video" ? { job_id: UUID } : finished({ page: "https://higgsfield.example.com/job/1", other: "https://cdn.example.com/y.mov" })) });
  await d.runner.start(job("broll"), d.ctx);
  assert.equal(curlUrl(d), "https://cdn.example.com/y.mov", "scraped URLs need a whitelisted extension");
});

test("a known result key without an extension is saved with the kind's default", async () => {
  const t = setup({ mcp: (tool) => (tool === "generate_image" ? { job_id: UUID } : finished({ url: "https://cdn.example.com/download?id=7" })) });
  const r = await t.runner.start(job("lineart"), t.ctx);
  assert.equal(r.file, OUT + ".png");
});

test("portrait: uploads photos, generate_image with seedream params and image_references, hfId in meta, image file", async () => {
  const PH = ["C:\\jon\\a.jpg", "C:\\jon\\b.png"];
  let up = 0;
  const t = setup({ mcp: (tool, i) => {
    if (tool === "media_upload") return { uploads: [{ upload_url: `https://up.example.com/${up++}/aaaaaaaa-1111-2222-3333-44444444444${up}?X=1`, media_id: `m${up}` }] };
    if (tool === "media_confirm") return {};
    if (tool === "generate_image") return { job_id: UUID };
    return done("https://cdn.example.com/p.webp");
  } });
  const r = await t.runner.start(job("portrait", { input: { kind: "portrait", prompt: "P", photos: PH, out: ROOT + "\\studio\\presenter\\PORTRAIT_t1" } }), t.ctx);
  const gen = t.calls.find((c) => c.t === "generate_image");
  assert.deepEqual(gen.i, { params: { model: "seedream_5_5", prompt: "P", aspect_ratio: "16:9", count: 1, use_unlim: false, resolution: "2k", medias: [{ value: "m1", role: "image_references" }, { value: "m2", role: "image_references" }] } });
  assert.ok(t.calls.findIndex((c) => c.t === "generate_image") > t.calls.findLastIndex((c) => c.t === "media_confirm"));
  assert.equal(r.file, ROOT + "\\studio\\presenter\\PORTRAIT_t1.webp");
  assert.deepEqual(r.meta, { hfId: UUID });
  assert.deepEqual(t.refs, [UUID]);
});

test("portrait: an upload failure fails before generate_image", async () => {
  const t = setup({ mcp: (tool) => { if (tool === "media_upload") throw new Error("nope"); return {}; } });
  await assert.rejects(t.runner.start({ id: "j", input: { kind: "portrait", prompt: "P", photos: ["C:\\a.jpg"], out: OUT } }, t.ctx), /nope/);
  assert.ok(!t.calls.some((c) => c.t === "generate_image"));
});

// ---- Task 5: presenter clips ----
const PRES = ROOT + "\\studio\\presenter\\TC-01_t1";
const pjob = (extra = {}) => ({ id: "j", input: { kind: "presenter", lineId: "01", voiceover: "C:\\v\\vo.wav", start: 1.5, end: 8.7, seconds: 8, hfId: "hf-p", prompt: "PROMPT", out: PRES, ...extra } });
function pmcp(over = {}) {
  return (tool) => {
    if (over[tool]) return over[tool]();
    if (tool === "media_upload") return { uploads: [{ upload_url: "https://up.example.com/a/aaaaaaaa-1111-2222-3333-444444444444?X=1", media_id: "aud1" }] };
    if (tool === "media_confirm") return {};
    if (tool === "generate_video") return { job_id: UUID };
    return done("https://cdn.example.com/c.mp4");
  };
}
const ffmpegSpawn = (code = 0) => async (cmd, args, p, host) => {
  if (cmd === "ffmpeg") { if (code === 0) await host.fs.write(args[args.length - 1], "WAVBYTES"); p.exit(code); return; }
  const i = args.indexOf("-o");
  if (i >= 0) await host.fs.write(args[i + 1], "data");
  p.exit(0);
};

test("presenter: cuts audio with ffmpeg, uploads, generate_video with exact params, meta has hfId and audioSig", async () => {
  const t = setup({ mcp: pmcp(), spawn: ffmpegSpawn() });
  const r = await t.runner.start(pjob(), t.ctx);
  const ff = t.spawns.find((s) => s.cmd === "ffmpeg");
  assert.deepEqual(ff.args, ["-y", "-i", "C:\\v\\vo.wav", "-ss", "1.5", "-to", "8.7", "-af", "apad=whole_dur=8", "-ar", "48000", PRES + "_audio.wav"]);
  const up = t.calls.find((c) => c.t === "media_upload");
  assert.deepEqual(up.i, { files: [{ filename: "TC-01_t1_audio.wav", content_type: "audio/wav" }] });
  const gen = t.calls.find((c) => c.t === "generate_video");
  assert.deepEqual(gen.i, { params: { model: "wan2_7", resolution: "1080p", aspect_ratio: "16:9", duration: 8, prompt: "PROMPT", medias: [{ value: "hf-p", role: "start_image" }, { value: "aud1", role: "audio_references" }], use_unlim: false } });
  assert.ok(t.calls.findIndex((c) => c.t === "generate_video") > t.calls.findIndex((c) => c.t === "media_confirm"));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("WAVBYTES")))).map((b) => b.toString(16).padStart(2, "0")).join("");
  assert.deepEqual(r.meta, { hfId: UUID, audioSig: { lengthS: 7.2, hash } });
  assert.equal(r.file, PRES + ".mp4");
});

test("presenter: an upload failure fails before generate_video; so does an ffmpeg failure", async () => {
  const a = setup({ mcp: pmcp({ media_upload: () => { throw new Error("expired"); } }), spawn: ffmpegSpawn() });
  await assert.rejects(a.runner.start(pjob(), a.ctx), /expired/);
  assert.ok(!a.calls.some((c) => c.t === "generate_video"));
  const b = setup({ mcp: pmcp(), spawn: ffmpegSpawn(1) });
  await assert.rejects(b.runner.start(pjob(), b.ctx), /ffmpeg/);
  assert.ok(!b.calls.some((c) => c.t === "generate_video" || c.t === "media_upload"));
});

test("clipAudioArgs and audioSigOf", async () => {
  const { clipAudioArgs, audioSigOf } = await import("../js/tools/clipaudio.js");
  assert.deepEqual(clipAudioArgs({ wav: "a.wav", start: 1, end: 2, seconds: 2, out: "o" }), ["-y", "-i", "a.wav", "-ss", "1", "-to", "2", "-af", "apad=whole_dur=2", "-ar", "48000", "o_audio.wav"]);
  const host = new FakeHost();
  await host.fs.mkdir("C:\\x");
  await host.fs.write("C:\\x\\a.wav", "abc");
  const s = await audioSigOf(host, "C:\\x\\a.wav", 3.14159);
  assert.equal(s.lengthS, 3.14);
  assert.equal(s.hash, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
