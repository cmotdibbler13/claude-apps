import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { makeVoiceJoinRunner, joinArgs } from "../js/tools/voicejoin.js";
import { runJsonLines } from "../js/proc.js";

const AUTOCUE = "C:\\Users\\Jon\\desktop autocue";
const settings = { autocueDir: AUTOCUE, autocuePython: "C:\\Python\\python.exe" };
const input = { script: "S:\\Film A\\line_script.txt", takes: "C:\\rec\\film_a", out: "S:\\Film A\\studio\\voiceover", allowFlagged: false };
const DONE = { done: true, wav: "S:\\Film A\\studio\\voiceover\\film_a_voiceover.wav", csv: "S:\\Film A\\studio\\voiceover\\film_a_voiceover_timings.csv",
  transcript: "S:\\Film A\\studio\\voiceover\\film_a_voiceover_transcript.json", length_s: 361.25,
  tightened: [{ id: "03.2", at_s: 1.2, from_s: 0.9, to_s: 0.3 }], extra: ["film_a_09.9.wav"], clips: 12, silent: [],
  duplicates: [{ id: "05.2", files: ["C:\\rec\\film_a\\film_a_05.2.wav", "C:\\rec\\film_a\\old\\film_a_05.2.wav"] }], moved_aside: [] };

function run(script, inp = input) {
  const host = new FakeHost();
  const spawns = [], progress = [];
  host.spawnScript((cmd, args, opts, p) => { spawns.push({ cmd, args, opts }); script(p); });
  const runner = makeVoiceJoinRunner({ settings });
  const ctx = { host, progress: (v) => progress.push(v) };
  return { host, spawns, progress, promise: runner.start({ input: inp }, ctx), runner };
}

test("join spawns Autocue's python with the script path first and cwd in the Autocue folder", async () => {
  const r = run((p) => { p.out(JSON.stringify(DONE) + "\n"); p.exit(0); });
  await r.promise;
  assert.equal(r.spawns.length, 1);
  assert.equal(r.spawns[0].cmd, "C:\\Python\\python.exe");
  assert.deepEqual(r.spawns[0].args, [AUTOCUE + "\\voiceover_join.py", "--script", input.script, "--takes", input.takes, "--out", input.out, "--title-hold", "6"]);
  assert.equal(r.spawns[0].opts.cwd, AUTOCUE);
  assert.equal(await r.host.fs.exists(input.out), true, "out folder made");
});

test("allowFlagged adds --allow-flagged", async () => {
  const r = run((p) => { p.out(JSON.stringify(DONE)); p.exit(0); }, { ...input, allowFlagged: true });
  await r.promise;
  assert.equal(r.spawns[0].args.at(-1), "--allow-flagged");
});

test("progress lines reach ctx.progress, split across chunks, and the done line gives file and meta", async () => {
  const r = run((p) => {
    p.out('{"progress":0.1,"text":"Trimmed 01.1"}\n{"progr');
    p.out('ess":0.5,"text":"Half"}\nUserWarning: something from a library\n');
    p.err("FutureWarning: torch\n");
    p.out(JSON.stringify(DONE) + "\n");
    p.exit(0);
  });
  const res = await r.promise;
  assert.deepEqual(r.progress, [0.1, 0.5]);
  assert.equal(res.file, DONE.wav);
  assert.deepEqual(res.meta, { wav: DONE.wav, csv: DONE.csv, transcript: DONE.transcript, lengthS: 361.25, tightened: DONE.tightened, tight: [], extra: DONE.extra, silent: [], duplicates: DONE.duplicates });
});

test("an error line becomes the error, whatever the exit code", async () => {
  const r = run((p) => { p.out('{"progress":0.2,"text":"x"}\n{"error":"Missing takes: 01.2, 03.4","missing":["01.2","03.4"]}\n'); p.exit(2); });
  await assert.rejects(r.promise, { message: "Missing takes: 01.2, 03.4" });
});

test("no error line: the last five other lines explain the exit", async () => {
  const r = run((p) => { for (let i = 1; i <= 7; i++) p.err(`line ${i}\n`); p.exit(1); });
  await assert.rejects(r.promise, (e) => {
    assert.match(e.message, /exit code 1/);
    assert.match(e.message, /line 3\nline 4\nline 5\nline 6\nline 7$/);
    assert.doesNotMatch(e.message, /line 2/);
    return true;
  });
});

test("a program that never starts says so", async () => {
  const r = run((p) => { p.err("spawn python ENOENT"); p.exit(null); });
  await assert.rejects(r.promise, /didn't start/);
});

test("resume asks for a fresh run", async () => {
  await assert.rejects(makeVoiceJoinRunner({ settings }).resume(), { message: "Interrupted; run it again." });
});

test("runJsonLines waits briefly for a done line that arrives after the exit", async () => {
  const host = new FakeHost();
  host.spawnScript((cmd, args, opts, p) => { p.exit(0); setTimeout(() => p.out('{"done":true,"x":1}\n'), 10); });
  const r = await runJsonLines(host, "py", []);
  assert.equal(r.x, 1);
});

test("runJsonLines: exit 0 with no done line is an error", async () => {
  const host = new FakeHost();
  host.spawnScript((cmd, args, opts, p) => { p.out("hello\n"); p.exit(0); });
  await assert.rejects(runJsonLines(host, "py", [], { name: "The thing" }), /The thing finished without a result:\nhello/);
});

test("joinArgs appends --pauses only when a path is given", () => {
  const base = { script: "s", takes: "t", out: "o" };
  const plain = joinArgs(settings, base);
  assert.ok(!plain.includes("--pauses"));
  const withP = joinArgs(settings, { ...base, pauses: "S:\\f\\p.json" });
  assert.deepEqual(withP.slice(-2), ["--pauses", "S:\\f\\p.json"]);
  assert.ok(!joinArgs(settings, { ...base, pauses: "" }).includes("--pauses"));
});

test("the runner's meta carries tight from the done JSON", async () => {
  const r = run((p) => { p.out(JSON.stringify({ ...DONE, tight: [{ id: "03.2", at_s: 4.1 }] }) + "\n"); p.exit(0); });
  assert.deepEqual((await r.promise).meta.tight, [{ id: "03.2", at_s: 4.1 }]);
  const r2 = run((p) => { p.out(JSON.stringify(DONE) + "\n"); p.exit(0); });
  assert.deepEqual((await r2.promise).meta.tight, []);
});
