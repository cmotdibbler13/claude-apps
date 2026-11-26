import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { parseMeasure, isQuiet, measure, finishSfx, projectOf } from "../js/audio.js";

const STDERR = `Input #0, wav, from 'x.wav':
  Duration: 00:00:04.00, bitrate: 768 kb/s
[Parsed_volumedetect_0 @ 000001] n_samples: 192000
[Parsed_volumedetect_0 @ 000001] mean_volume: -31.7 dB
[Parsed_volumedetect_0 @ 000001] max_volume: -5.0 dB
`;
const DIR = "S:\\Film A\\studio\\sfx";
const SRC = DIR + "\\raw.wav";
const OUT = DIR + "\\hit.wav";

function setup(code = 0) {
  const host = new FakeHost();
  host.dirs.add(DIR);
  host.files.set(SRC, "SOURCE");
  const calls = [];
  host.spawnScript(async (cmd, args, o, p) => {
    calls.push({ cmd, args });
    if (code === 0) await host.fs.write(args[args.length - 1], "FINISHED");
    else await host.fs.write(args[args.length - 1], "HALF");
    if (code !== 0) p.err("boom");
    p.exit(code);
  });
  return { host, calls };
}

test("parseMeasure reads volumedetect and duration", () => {
  assert.deepEqual(parseMeasure(STDERR), { lengthS: 4, peakDb: -5, meanDb: -31.7 });
  assert.deepEqual(parseMeasure(""), { lengthS: null, peakDb: null, meanDb: null });
});

test("isQuiet thresholds", () => {
  assert.equal(isQuiet({ peakDb: -31, meanDb: -40 }), true);
  assert.equal(isQuiet({ peakDb: -5, meanDb: -51 }), true);
  assert.equal(isQuiet({ peakDb: -5, meanDb: -31.7 }), false);
  assert.equal(isQuiet({ peakDb: null, meanDb: null }), false);
});

test("measure runs volumedetect and reports quiet", async () => {
  const host = new FakeHost();
  let seen;
  host.spawnScript((cmd, args, o, p) => { seen = { cmd, args }; p.err(STDERR); p.exit(0); });
  const m = await measure(host, SRC);
  assert.deepEqual(m, { lengthS: 4, peakDb: -5, meanDb: -31.7, quiet: false });
  assert.equal(seen.cmd, "ffmpeg");
  assert.deepEqual(seen.args, ["-hide_banner", "-i", SRC, "-af", "volumedetect", "-f", "null", "-"]);
});

test("measure throws on a non-zero exit", async () => {
  const host = new FakeHost();
  host.spawnScript((cmd, args, o, p) => { p.err("bad"); p.exit(1); });
  await assert.rejects(measure(host, SRC), /Couldn't measure raw\.wav/);
});

test("finishSfx writes via .part and renames", async () => {
  const { host, calls } = setup();
  const r = await finishSfx(host, SRC, OUT);
  assert.deepEqual(r, { file: OUT });
  assert.equal(await host.fs.exists(OUT), true);
  assert.equal(await host.fs.exists(DIR + "\\hit.part.wav"), false);
  const a = calls[0].args;
  assert.equal(a.at(-1), DIR + "\\hit.part.wav");
  assert.ok(a.includes("-ar") && a[a.indexOf("-ar") + 1] === "48000");
  assert.ok(a.some((x) => x.includes("afade=t=in:d=0.01") && x.includes("silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,areverse")));
  assert.ok(a.some((x) => x.endsWith("areverse,afade=t=in:d=0.01,areverse")));
  assert.equal(await host.fs.read(SRC, "utf8"), "SOURCE");
});

test("finishSfx failure leaves no output or part and keeps src", async () => {
  const { host } = setup(1);
  await assert.rejects(finishSfx(host, SRC, OUT));
  assert.equal(await host.fs.exists(OUT), false);
  assert.equal(await host.fs.exists(DIR + "\\hit.part.wav"), false);
  assert.equal(await host.fs.read(SRC, "utf8"), "SOURCE");
});

test("projectOf sanitises the folder name", () => {
  assert.equal(projectOf("S:\\Youtube video ideas\\Protect and Survive (027)"), "Protect_and_Survive__027_");
  assert.equal(projectOf("/a/b/Film-A_1/"), "Film-A_1");
});
