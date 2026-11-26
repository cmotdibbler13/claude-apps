import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { DEFAULT_SETTINGS } from "../js/settings.js";
import { stableAudioState, makeStableAudioStarter } from "../js/tools/stableaudio.js";

const SA = DEFAULT_SETTINGS.stableAudio;
const sfxPage = "<html><title>Stable Audio 3 Small SFX</title></html>";
const musicPage = "<html><title>Stable Audio 3 Music</title></html>";
const info = JSON.stringify({ named_endpoints: { "/generate": {} } });
const MUSIC_MSG = "Stable Audio Music is running. Stop it in Pinokio, then press Start Stable Audio.";
const PINOKIO_MSG = "Open Pinokio first, then press Start Stable Audio.";
const DIDNT_MSG = "Stable Audio didn't start. Look at its Terminal in Pinokio, or switch this cue to ElevenLabs.";

// pages: function(callIndex) -> { page, info, code } for curl; pterm: (p, args, opts) => void
function setup({ page = () => sfxPage, infoBody = info, curlCode = () => 0, pterm } = {}) {
  const host = new FakeHost();
  const spawns = [], ptermProcs = [];
  let n = 0;
  host.spawnScript((cmd, args, opts, p) => {
    spawns.push({ cmd, args, opts });
    if (cmd === "curl") {
      const code = curlCode(n);
      if (code) { p.err("fail"); return p.exit(code); }
      if (args.at(-1).endsWith("/gradio_api/info")) { p.out(infoBody); return p.exit(0); }
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
  assert.deepEqual(s.spawns[0].args, ["-sS", "--max-time", "5", "http://127.0.0.1:7860/"]);
  s = setup({ page: () => musicPage });
  assert.equal(await stableAudioState(s.host, SA), "music");
  s = setup({ curlCode: () => 7 });
  assert.equal(await stableAudioState(s.host, SA), "off");
  s = setup({ curlCode: () => 6 });
  assert.equal(await stableAudioState(s.host, SA), "off");
});

test("state: SFX title without /generate, or an unknown page, is other", async () => {
  assert.equal(await stableAudioState(setup({ infoBody: "{}" }).host, SA), "other");
  assert.equal(await stableAudioState(setup({ page: () => "<title>Something</title>" }).host, SA), "other");
  assert.equal(await stableAudioState(setup({ curlCode: () => 22 }).host, SA), "other");
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
      if (args.at(-1).endsWith("/gradio_api/info")) { p.out(info); return p.exit(0); }
      calls++;
      if (calls <= 3) { p.err("refused"); return p.exit(7); }
      p.out(sfxPage); return p.exit(0);
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
      if (args.at(-1).endsWith("/gradio_api/info")) { p.out(info); return p.exit(0); }
      calls++;
      if (calls <= 2) { p.err("refused"); return p.exit(7); }
      p.out(sfxPage); return p.exit(0);
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
      if (args.at(-1).endsWith("/gradio_api/info")) { p.out(info); return p.exit(0); }
      if (++calls <= 2) { p.err("refused"); return p.exit(7); }
      p.out(sfxPage); return p.exit(0);
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
