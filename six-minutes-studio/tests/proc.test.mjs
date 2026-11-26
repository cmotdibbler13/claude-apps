import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { runProcess } from "../js/proc.js";

test("runs a program with an argument list and collects its output", async () => {
  const host = new FakeHost();
  const seen = [];
  host.spawnScript((cmd, args, o, p) => { seen.push([cmd, args]); p.out("hello "); p.err("warn\n"); p.out("world"); p.exit(3); });
  const r = await runProcess(host, "tool", ["-o", "S:\\a & b%c!d^e$f`g.mp4"]);
  assert.deepEqual(seen, [["tool", ["-o", "S:\\a & b%c!d^e$f`g.mp4"]]]);
  assert.deepEqual(r, { code: 3, stdout: "hello world", stderr: "warn\n" });
});

test("a program that does not start rejects with the reason", async () => {
  const host = new FakeHost();
  host.spawnScript((cmd, args, o, p) => { p.err("spawn curl ENOENT"); p.exit(null); });
  await assert.rejects(runProcess(host, "curl", []), /curl didn't start or was stopped: spawn curl ENOENT/);
});

test("a program that runs too long is killed and rejects", async () => {
  const host = new FakeHost();
  let killed = false;
  const spawn = host.spawn.bind(host);
  host.spawn = (...a) => { const p = spawn(...a); const k = p.kill; p.kill = () => { killed = true; return k(); }; return p; };
  host.spawnScript(() => {});
  await assert.rejects(runProcess(host, "ffmpeg", [], { timeout: 20 }), /ffmpeg timed out/);
  assert.equal(killed, true);
});
