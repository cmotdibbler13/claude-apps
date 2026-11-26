import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { DEFAULT_SETTINGS } from "../js/settings.js";
import { stableAudioState, makeStableAudioStarter, saPayload, parseSse, makeStableAudioRunner } from "../js/tools/stableaudio.js";

const SA = DEFAULT_SETTINGS.stableAudio;
const sfxPage = "<html><title>Stable Audio 3 Small SFX</title></html>";
const musicPage = "<html><title>Stable Audio 3 Music</title></html>";
const info = JSON.stringify({ named_endpoints: { "/generate": {} } });
const MUSIC_MSG = "Stable Audio Music is running. Stop it in Pinokio, then press Start Stable Audio.";
const PINOKIO_MSG = "Open Pinokio first, then press Start Stable Audio.";
const DIDNT_MSG = "Stable Audio didn't start. Look at its Terminal in Pinokio, or switch this cue to ElevenLabs.";

// pages: function(callIndex) -> { page, info, code } for curl; pterm: (p, args, opts) => void
function setup({ page = () => sfxPage, infoBody = info, curlCode = () => 0, pterm, config = null } = {}) {
  const host = new FakeHost();
  const spawns = [], ptermProcs = [];
  let n = 0;
  host.spawnScript((cmd, args, opts, p) => {
    spawns.push({ cmd, args, opts });
    if (cmd === "curl") {
      const code = curlCode(n);
      if (code) { p.err("fail"); return p.exit(code); }
      if (args.at(-1).endsWith("/gradio_api/info")) { p.out(infoBody); return p.exit(0); }
      if (args.at(-1).endsWith("/config")) { if (config === null) { p.err("404"); return p.exit(22); } p.out(config); return p.exit(0); }
      p.out(page(n++)); return p.exit(0);
    }
    ptermProcs.push(p);
    if (pterm) pterm(p, args, opts);
  });
  const sleeps = [];
  const starter = makeStableAudioStarter({ sleep: async (ms) => { sleeps.push(ms); }, settings: { stableAudio: SA } });
  return { host, starter, spawns, sleeps, ptermProcs, pterms: () => spawns.filter((s) => s.cmd !== "curl") };
}

test("state: SFX title plus /generate is ready, Music title is music, curl exit 7 is off", async () => {
  let s = setup();
  assert.equal(await stableAudioState(s.host, SA), "ready");
  assert.deepEqual(s.spawns[0].args, ["-sS", "--max-time", "5", "http://127.0.0.1:7860/gradio_api/info"]);
  s = setup({ page: () => musicPage });
  assert.equal(await stableAudioState(s.host, SA), "music");
  s = setup({ curlCode: () => 7 });
  assert.equal(await stableAudioState(s.host, SA), "off");
  s = setup({ curlCode: () => 6 });
  assert.equal(await stableAudioState(s.host, SA), "off");
});

test("state: no /generate is other; an error from the server is other", async () => {
  assert.equal(await stableAudioState(setup({ infoBody: "{}" }).host, SA), "other");
  assert.equal(await stableAudioState(setup({ curlCode: () => 22 }).host, SA), "other");
});

// Seen on Jon's PC (27 Nov): Pinokio showed Small SFX running, but the served page's <title> was only
// filled in by Gradio's scripts, so the old title check never saw "Small SFX" and gave up.
test("state: Gradio's generic page title with /generate is ready; the config title names the model", async () => {
  assert.equal(await stableAudioState(setup({ page: () => "<html><title>Gradio</title></html>" }).host, SA), "ready");
  assert.equal(await stableAudioState(setup({ page: () => "<html></html>" }).host, SA), "ready");
  assert.equal(await stableAudioState(setup({ page: () => "<title>Gradio</title>", config: JSON.stringify({ title: "Stable Audio 3 Small SFX" }) }).host, SA), "ready");
  assert.equal(await stableAudioState(setup({ page: () => "<title>Gradio</title>", config: JSON.stringify({ title: "Stable Audio 3 Small Music" }) }).host, SA), "music");
});

test("ensure while already ready spawns no pterm", async () => {
  const s = setup();
  await s.starter.ensure(s.host);
  assert.equal(s.pterms().length, 0);
  assert.equal(s.starter.state(), "ready");
});

test("ensure from off spawns pterm once with shell and the four args, polls until ready", async () => {
  const s = setup();
  // curl calls: the live check and two polls refuse, the third poll is ready
  let calls = 0;
  s.host.spawnScript((cmd, args, opts, p) => {
    s.spawns.push({ cmd, args, opts });
    if (cmd === "curl") {
      if (!args.at(-1).endsWith("/gradio_api/info")) { p.out(sfxPage); return p.exit(0); }
      calls++;
      if (calls <= 3) { p.err("refused"); return p.exit(7); }
      p.out(info); return p.exit(0);
    }
    s.ptermProcs.push(p);
  });
  const seen = [];
  s.starter.onChange(() => seen.push(s.starter.state()));
  await s.starter.ensure(s.host);
  const pt = s.pterms();
  assert.equal(pt.length, 1);
  assert.equal(pt[0].cmd, SA.pterm);
  assert.equal(pt[0].opts.shell, true);
  assert.deepEqual(pt[0].args, ["run", SA.app, "--default", "start.js?model=small-sfx"]);
  assert.equal(s.starter.state(), "ready");
  assert.deepEqual(s.sleeps, [2000, 2000, 2000]);
  assert.deepEqual(seen, ["starting", "ready"]);
});

test("two parallel ensure calls make one spawn", async () => {
  const s = setup();
  let calls = 0;
  s.host.spawnScript((cmd, args, opts, p) => {
    s.spawns.push({ cmd, args, opts });
    if (cmd === "curl") {
      if (!args.at(-1).endsWith("/gradio_api/info")) { p.out(sfxPage); return p.exit(0); }
      calls++;
      if (calls <= 2) { p.err("refused"); return p.exit(7); }
      p.out(info); return p.exit(0);
    }
  });
  await Promise.all([s.starter.ensure(s.host), s.starter.ensure(s.host)]);
  assert.equal(s.pterms().length, 1);
});

test("pterm exiting with ECONNREFUSED before ready gives the Pinokio message", async () => {
  const s = setup({ curlCode: () => 7, pterm: (p) => { p.err("connect ECONNREFUSED 127.0.0.1:42000"); p.exit(1); } });
  await assert.rejects(s.starter.ensure(s.host), { message: PINOKIO_MSG });
  assert.equal(s.starter.state(), "failed");
  assert.equal(s.starter.message(), PINOKIO_MSG);
});

test("pterm exiting later without a known message gives the didn't-start message", async () => {
  let polls = 0;
  const s = setup({ curlCode: () => 7, pterm: () => {} });
  s.starter = makeStableAudioStarter({
    settings: { stableAudio: SA },
    sleep: async () => { if (++polls === 3) s.ptermProcs[0].exit(1); },
  });
  await assert.rejects(s.starter.ensure(s.host), { message: DIDNT_MSG });
});

test("60 polls without ready give the didn't-start message", async () => {
  const s = setup({ curlCode: () => 7 });
  await assert.rejects(s.starter.ensure(s.host), { message: DIDNT_MSG });
  assert.equal(s.sleeps.length, 60);
  assert.equal(s.starter.state(), "failed");
});

test("music running rejects with the Music message and spawns no pterm", async () => {
  const s = setup({ page: () => musicPage });
  await assert.rejects(s.starter.ensure(s.host), { message: MUSIC_MSG });
  assert.equal(s.pterms().length, 0);
  assert.equal(s.starter.state(), "music");
});

test("stop kills the kept pterm process; a later exit does not break state", async () => {
  let calls = 0;
  const s = setup();
  s.host.spawnScript((cmd, args, opts, p) => {
    s.spawns.push({ cmd, args, opts });
    if (cmd === "curl") {
      if (!args.at(-1).endsWith("/gradio_api/info")) { p.out(sfxPage); return p.exit(0); }
      if (++calls <= 2) { p.err("refused"); return p.exit(7); }
      p.out(info); return p.exit(0);
    }
    s.ptermProcs.push(p);
  });
  await s.starter.ensure(s.host);
  let exited = false;
  s.ptermProcs[0].exit = ((orig) => (c) => { exited = true; orig(c); })(s.ptermProcs[0].exit);
  await s.starter.stop();
  assert.equal(exited, true, "kill reached the kept process");
  assert.equal(s.starter.state(), "off");
  await s.starter.stop(); // no process: harmless
});

test("stop during starting ends the poll without ready or failed, and ensure rejects", async () => {
  const s = setup({ curlCode: () => 7 });
  let polls = 0;
  const starter = makeStableAudioStarter({
    settings: { stableAudio: SA },
    sleep: async () => { if (++polls === 2) await starter.stop(); },
  });
  const states = [];
  starter.onChange(() => states.push(starter.state()));
  await assert.rejects(starter.ensure(s.host), { message: "Stable Audio was stopped." });
  assert.equal(polls, 2);
  assert.equal(starter.state(), "off");
  assert.deepEqual(states, ["starting", "off"]);
});

test("music appearing mid-poll sets music, kills pterm and rejects", async () => {
  let calls = 0, killed = false;
  const s = setup();
  s.host.spawnScript((cmd, args, opts, p) => {
    s.spawns.push({ cmd, args, opts });
    if (cmd === "curl") {
      if (!args.at(-1).endsWith("/gradio_api/info")) { p.out(musicPage); return p.exit(0); }
      calls++;
      if (calls === 1) { p.err("refused"); return p.exit(7); }
      p.out(info); return p.exit(0);
    }
    const orig = p.exit; p.exit = (c) => { killed = true; orig(c); };
    s.ptermProcs.push(p);
  });
  await assert.rejects(s.starter.ensure(s.host), { message: MUSIC_MSG });
  assert.equal(s.starter.state(), "music");
  assert.equal(killed, true);
});

test("a path with a space or ampersand reaches the shell quoted", async () => {
  const s = setup({ curlCode: () => 7 });
  const settings = { stableAudio: { ...SA, pterm: "C:\\Program Files\\pterm.cmd", app: "C:\\my apps\\a&b.git" } };
  const starter = makeStableAudioStarter({ settings, sleep: async () => {} });
  await assert.rejects(starter.ensure(s.host));
  const pt = s.pterms()[0];
  assert.equal(pt.cmd, '"C:\\Program Files\\pterm.cmd"');
  assert.deepEqual(pt.args, ["run", '"C:\\my apps\\a&b.git"', "--default", "start.js?model=small-sfx"]);
});

test("pterm exiting after ready sets state off", async () => {
  let calls = 0;
  const s = setup();
  s.host.spawnScript((cmd, args, opts, p) => {
    if (cmd === "curl") {
      if (!args.at(-1).endsWith("/gradio_api/info")) { p.out(sfxPage); return p.exit(0); }
      if (++calls <= 2) { p.err("refused"); return p.exit(7); }
      p.out(info); return p.exit(0);
    }
    s.ptermProcs.push(p);
  });
  await s.starter.ensure(s.host);
  assert.equal(s.starter.state(), "ready");
  s.ptermProcs[0].exit(1);
  assert.equal(s.starter.state(), "off");
});

test("stop during the initial probe spawns nothing and ends off", async () => {
  const s = setup({ curlCode: () => 7 });
  const starter = makeStableAudioStarter({ settings: { stableAudio: SA }, sleep: async () => {} });
  const p = starter.ensure(s.host);
  await starter.stop();
  await assert.rejects(p, { message: "Stable Audio was stopped." });
  assert.equal(s.pterms().length, 0);
  assert.equal(starter.state(), "off");
});

test("stop during a poll's state check kills pterm and ends off", async () => {
  const s = setup();
  let killed = false, curls = 0;
  const starter = makeStableAudioStarter({ settings: { stableAudio: SA }, sleep: async () => {} });
  s.host.spawnScript((cmd, args, opts, p) => {
    s.spawns.push({ cmd, args, opts });
    if (cmd === "curl") {
      if (++curls === 2) starter.stop(); // the first poll's probe
      p.err("refused"); return p.exit(7);
    }
    const orig = p.exit; p.exit = (c) => { killed = true; orig(c); };
  });
  await assert.rejects(starter.ensure(s.host), { message: "Stable Audio was stopped." });
  assert.equal(starter.state(), "off");
  assert.equal(killed, true);
});

test("quoting covers shell metacharacters and doubles embedded quotes", async () => {
  const s = setup({ curlCode: () => 7 });
  const settings = { stableAudio: { ...SA, pterm: "p|q.cmd", app: 'C:\\a"b%c!.git' } };
  const starter = makeStableAudioStarter({ settings, sleep: async () => {} });
  await assert.rejects(starter.ensure(s.host));
  const pt = s.pterms()[0];
  assert.equal(pt.cmd, '"p|q.cmd"');
  assert.equal(pt.args[1], '"C:\\a""b%c!.git"');
});

// ---- Runner ----
const SAMPLE = 'event: generating\ndata: null\n\nevent: complete\ndata: [{"path": "C:\\\\x.wav", "url": "http://127.0.0.1:7860/gradio_api/file=C:\\\\pinokio\\\\cache\\\\a b/my door.cfg1.0.1.wav"}, []]\n\n';
const OUT = "S:\\Films\\Demo\\studio\\media\\door.wav";

test("saPayload: 29 values in the notes' order, whole-number seconds clamped 1 to 120", () => {
  const d = saPayload("x", 4.4, SA).data;
  assert.equal(d.length, 29);
  assert.equal(d[0], "x"); assert.equal(d[1], ""); assert.equal(d[2], 4); assert.equal(d[3], 1.0); assert.equal(d[4], 8);
  assert.equal(d[6], -1); assert.equal(d[14], "wav"); assert.equal(d[15], "verbose"); assert.equal(d[16], true);
  assert.equal(d.at(-1), null);
  assert.equal(saPayload("x", 0.2, SA).data[2], 1);
  assert.equal(saPayload("x", 500, SA).data[2], 120);
});

test("parseSse: complete gives the url, error gives error, partial gives neither", () => {
  const r = parseSse(SAMPLE);
  assert.equal(r.done, true); assert.equal(r.error, false);
  assert.match(r.url, /gradio_api\/file=/);
  assert.deepEqual(parseSse("event: error\ndata: null"), { done: false, error: true, url: null });
  assert.deepEqual(parseSse("event: generating\ndata: null\n"), { done: false, error: false, url: null });
});

function runnerSetup({ title = sfxPage, stream = SAMPLE, post = '{"event_id":"E1"}', postCode = 0 } = {}) {
  const host = new FakeHost();
  const calls = [];
  host.spawnScript((cmd, args, opts, p) => {
    calls.push({ cmd, args });
    if (cmd === "curl") {
      const u = args.at(-1);
      if (args.includes("POST")) { if (postCode) { p.err("refused"); return p.exit(postCode); } p.out(post); return p.exit(0); }
      if (u.endsWith("/gradio_api/info")) { p.out(info); return p.exit(0); }
      if (u.endsWith("/")) { p.out(title); return p.exit(0); }
      if (u.includes("/gradio_api/call/generate/")) { p.out(stream); return p.exit(0); }
      const o = args[args.indexOf("-o") + 1];
      host.files.set(host._key(o), "wavdata"); return p.exit(0);
    }
    if (cmd === "ffmpeg") {
      if (args.includes("volumedetect")) {
        p.err("Duration: 00:00:04.00, start\n[Parsed_volumedetect_0] mean_volume: -20.0 dB\n[Parsed_volumedetect_0] max_volume: -3.0 dB\n");
        return p.exit(0);
      }
      host.files.set(host._key(args.at(-1)), "finished"); return p.exit(0);
    }
  });
  const starter = makeStableAudioStarter({ sleep: async () => {}, settings: { stableAudio: SA } });
  const runner = makeStableAudioRunner({ settings: { stableAudio: SA }, starter, sleep: async () => {} });
  const ctx = { host, progress() {}, setRef() {} };
  return { host, calls, runner, ctx };
}

test("runner start: posts, reads the stream, downloads an encoded url, finishes and measures", async () => {
  const s = runnerSetup();
  s.host.dirs.add("S:/Films/Demo/studio/media");
  const r = await s.runner.start({ input: { prompt: "door", seconds: 4, out: OUT } }, s.ctx);
  assert.equal(r.file, OUT);
  assert.equal(r.meta.source, "stableaudio"); assert.equal(r.meta.quiet, false); assert.equal(r.meta.lengthS, 4);
  assert.ok(await s.host.fs.exists(OUT));
  assert.ok(await s.host.fs.exists("S:\\Films\\Demo\\studio\\media\\door.orig.wav"));
  const post = s.calls.find((c) => c.args.includes("POST"));
  assert.ok(post.args.includes("@S:\\Films\\Demo\\studio\\tmp\\sa_body.json"));
  const dl = s.calls.find((c) => c.args.includes("-o"));
  assert.match(dl.args.at(-1), /my%20door\.cfg1\.0\.1\.wav$/);
  assert.ok(dl.args.at(-1).includes("cache%5Ca%20b/"));
});

test("runner start: a url outside /gradio_api/file= rejects without downloading", async () => {
  const bad = 'event: complete\ndata: [{"url": "http://evil.example/x.wav"}]\n';
  const s = runnerSetup({ stream: bad });
  await assert.rejects(s.runner.start({ input: { prompt: "d", seconds: 4, out: OUT } }, s.ctx), /unexpected file address/);
  assert.equal(s.calls.some((c) => c.args.includes("-o")), false);
});

test("runner start: the Music model rejects with the Music message and never POSTs", async () => {
  const s = runnerSetup({ title: musicPage });
  await assert.rejects(s.runner.start({ input: { prompt: "d", seconds: 4, out: OUT } }, s.ctx), (e) => e.message === MUSIC_MSG);
  assert.equal(s.calls.some((c) => c.args.includes("POST")), false);
});

test("runner start: SSE error and refused POST give the plain messages", async () => {
  let s = runnerSetup({ stream: "event: error\ndata: null\n" });
  await assert.rejects(s.runner.start({ input: { prompt: "d", seconds: 4, out: OUT } }, s.ctx), (e) => e.message === "Stable Audio failed on this prompt. Look at its Terminal in Pinokio.");
  s = runnerSetup({ postCode: 7 });
  await assert.rejects(s.runner.start({ input: { prompt: "d", seconds: 4, out: OUT } }, s.ctx), (e) => e.message === "Stable Audio isn't running at 127.0.0.1:7860. Press Start Stable Audio, or switch this cue to ElevenLabs.");
});

test("runner resume always throws the interrupted message", async () => {
  const s = runnerSetup();
  await assert.rejects(s.runner.resume({}, s.ctx), (e) => e.message === "Interrupted; Stable Audio takes are quick, so run it again.");
  assert.equal(s.runner.lane, "gpu");
});

test("refresh sets ready, off or music from a live check without spawning, and leaves starting alone", async () => {
  let page = sfxPage;
  const s = setup({ page: () => page });
  await s.starter.refresh(s.host);
  assert.equal(s.starter.state(), "ready");
  page = musicPage;
  await s.starter.refresh(s.host);
  assert.equal(s.starter.state(), "music");
  assert.equal(s.starter.message(), MUSIC_MSG);
  const off = setup({ curlCode: () => 7 });
  await off.starter.refresh(off.host);
  assert.equal(off.starter.state(), "off");
  assert.equal(s.pterms().length + off.pterms().length, 0);
  // never while starting
  const h = setup({ infoBody: "{}" });
  const starter = makeStableAudioStarter({ sleep: () => new Promise(() => {}), settings: { stableAudio: SA } });
  starter.ensure(h.host).catch(() => {});
  await new Promise((r) => setImmediate(r));
  assert.equal(starter.state(), "starting");
  await starter.refresh(h.host);
  assert.equal(starter.state(), "starting");
});
