import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FakeHost } from "./fake-host.mjs";
import { AUTOCUE_FILES } from "../js/autocue-bundle.js";
import { autocueJoinState, installAutocueJoin, joinFailureHint } from "../js/autocueinstall.js";

const ACD = "C:\\Users\\Jon\\desktop autocue";
const repo = (f) => readFileSync(new URL(`../../autocue-studio/${f}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const NEW_TC = "def decode(path, rate=RATE):\n    pass\n";

test("the bundled join files match autocue-studio/ (run node scripts/embed-autocue.mjs after changing them)", () => {
  for (const f of ["voiceover_join.py", "line_script.py"]) assert.equal(AUTOCUE_FILES[f], repo(f), f);
});

async function pc({ join = null, line = null, tc = NEW_TC } = {}) {
  const host = new FakeHost();
  await host.fs.mkdir(ACD);
  if (join !== null) await host.fs.write(ACD + "\\voiceover_join.py", join);
  if (line !== null) await host.fs.write(ACD + "\\line_script.py", line);
  if (tc !== null) await host.fs.write(ACD + "\\take_checks.py", tc);
  return host;
}

test("state: missing, out of date (CRLF is the same file), up to date, and an old take_checks.py", async () => {
  assert.equal((await autocueJoinState(await pc(), ACD)).state, "missing");
  const old = await autocueJoinState(await pc({ join: "old", line: AUTOCUE_FILES["line_script.py"] }), ACD);
  assert.deepEqual([old.state, old.files], ["outdated", ["voiceover_join.py"]]);
  const crlf = await pc({ join: AUTOCUE_FILES["voiceover_join.py"].replace(/\n/g, "\r\n"), line: AUTOCUE_FILES["line_script.py"] });
  assert.equal((await autocueJoinState(crlf, ACD)).state, "ok");
  const tc = await pc({ join: AUTOCUE_FILES["voiceover_join.py"], line: AUTOCUE_FILES["line_script.py"], tc: "def decode(path):\n" });
  assert.equal((await autocueJoinState(tc, ACD)).takeChecksOld, true);
});

test("install renames the old copy with the date, writes Studio's, and leaves an up-to-date file alone", async () => {
  const host = await pc({ join: "old join", line: AUTOCUE_FILES["line_script.py"] });
  const done = await installAutocueJoin(host, ACD);
  assert.deepEqual(done, ["voiceover_join.py"]);
  assert.equal(await host.fs.read(ACD + "\\voiceover_join.py", "utf8"), AUTOCUE_FILES["voiceover_join.py"]);
  const kept = [...host.files.keys()].filter((k) => /voiceover_join\.before-\d{8}-\d{6}\.py$/.test(k));
  assert.equal(kept.length, 1);
  assert.equal(await host.fs.read(kept[0], "utf8"), "old join", "the old copy is kept, not deleted");
  assert.deepEqual(await installAutocueJoin(host, ACD), [], "nothing to do the second time");
  assert.equal((await autocueJoinState(host, ACD)).state, "ok");
});

test("install into a folder that isn't there says so", async () => {
  await assert.rejects(installAutocueJoin(new FakeHost(), "C:\\nowhere"), /isn't there/);
});

test("a join that failed on an old or missing script says how to fix it; other errors are unchanged", () => {
  assert.match(joinFailureHint("unrecognized arguments: --title-hold 6"), /Install join script/);
  assert.match(joinFailureHint("python: can't open file 'C:\\\\x\\\\voiceover_join.py'"), /Install join script/);
  assert.equal(joinFailureHint("Missing takes: 01.2"), "Missing takes: 01.2");
});
