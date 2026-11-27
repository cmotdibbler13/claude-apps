import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { suggestPrefix, prefixProblem, suggestEpisode, takenPrefixes, filmFolders, briefsIn, addBrief } from "../js/part1setup.js";

const ROOT = "S:\\Youtube video ideas";

test("suggestPrefix", () => {
  assert.equal(suggestPrefix("The Post Office"), "the_post_office");
  assert.equal(suggestPrefix("St. Kilda's Mail-boat"), "st_kilda_s_mail_boat");
});
test("prefixProblem", () => {
  assert.equal(prefixProblem("Post", []), "Use lower-case letters, digits and _ only.");
  assert.equal(prefixProblem("post_office", ["Post_Office"]), "Another film already uses post_office.");
  assert.equal(prefixProblem("post_office", []), null);
});
test("suggestEpisode", () => {
  assert.equal(suggestEpisode([{ number: "007" }, { number: null }, { number: "12" }]), "013");
  assert.equal(suggestEpisode([]), "001");
});
test("filmFolders skips handed-over and library folders", async () => {
  const h = new FakeHost();
  for (const d of ["Zeta", "Alpha", "Done", "B-roll library", ".hidden"]) await h.fs.mkdir(`${ROOT}\\${d}`);
  await h.fs.mkdir(`${ROOT}\\Done\\handover`);
  await h.fs.write(`${ROOT}\\Done\\handover\\part1_handover.md`, "x");
  await h.fs.write(`${ROOT}\\loose.txt`, "x");
  assert.deepEqual((await filmFolders(h, ROOT)).map((f) => f.name), ["Alpha", "Zeta"]);
});
test("briefsIn orders newest first and skips scripts", async () => {
  const h = new FakeHost();
  const d = `${ROOT}\\Film`;
  await h.fs.mkdir(d);
  await h.fs.write(`${d}\\old.md`, "a");
  h.t += 1000;
  await h.fs.write(`${d}\\new.TXT`, "b");
  await h.fs.write(`${d}\\x_script.md`, "c");
  await h.fs.write(`${d}\\x_line_script.txt`, "c");
  await h.fs.write(`${d}\\pic.png`, "c");
  const got = await briefsIn(h, d);
  assert.deepEqual(got.map((b) => b.name).sort(), ["new.TXT", "old.md"]);
});
test("briefsIn skips moved-aside scripts and Part 1 handover copies", async () => {
  const h = new FakeHost();
  const d = `${ROOT}\\Film`;
  await h.fs.mkdir(d);
  for (const n of ["brief.md", "x_script_2026-11-27-1405.md", "x_script_2026-11-27-1405_2.md", "x_line_script_2026-11-27-1405.txt",
    "x_line_script_2026-11-27-1405_3.txt", "part1_handover.md", "part1_handover_2026-11-27-1405.md", "x_script_notes.md"]) {
    await h.fs.write(`${d}\\${n}`, "a");
  }
  const got = await briefsIn(h, d);
  assert.deepEqual(got.map((b) => b.name).sort(), ["brief.md", "x_script_notes.md"]);
});
test("briefsIn sorts by mtime", async () => {
  const h = new FakeHost();
  const d = `${ROOT}\\Film`;
  await h.fs.mkdir(d);
  await h.fs.write(`${d}\\a.md`, "a");
  await h.fs.write(`${d}\\b.md`, "b");
  const real = h.fs.stat;
  h.fs.stat = async (p) => ({ ...(await real(p)), mtimeMs: p.endsWith("a.md") ? 5 : 9 });
  assert.deepEqual((await briefsIn(h, d)).map((b) => b.name), ["b.md", "a.md"]);
});
test("addBrief avoids clashes and rejects other types", async () => {
  const h = new FakeHost();
  const d = `${ROOT}\\Film`;
  await h.fs.mkdir(d);
  assert.equal(await addBrief(h, d, { name: "brief.md", bytes: "1" }), `${d}\\brief.md`);
  assert.equal(await addBrief(h, d, { name: "brief.md", bytes: "2" }), `${d}\\brief_2.md`);
  assert.equal(await h.fs.read(`${d}\\brief.md`, "utf8"), "1");
  await assert.rejects(addBrief(h, d, { name: "brief.pdf", bytes: "x" }), { message: "Save the brief as Markdown or text in the film's folder first." });
});
test("takenPrefixes reads autocue scripts and other handovers", async () => {
  const h = new FakeHost();
  const ac = "C:\\ac";
  await h.fs.mkdir(ac);
  await h.fs.write(`${ac}\\china_clay_line_script.txt`, "# name: china_clay\n[01.s]  (clip 01)\nHi\n");
  await h.fs.mkdir(`${ROOT}\\Other\\handover`);
  await h.fs.write(`${ROOT}\\Other\\handover\\part1_handover.md`, "Episode: 003\n- File prefix: `post_office`\n");
  const got = await takenPrefixes(h, ROOT, { autocueDir: ac });
  assert.deepEqual(got.sort(), ["china_clay", "post_office"]);
  assert.deepEqual(await takenPrefixes(new FakeHost(), ROOT, { autocueDir: "C:\\nope" }), []);
});
