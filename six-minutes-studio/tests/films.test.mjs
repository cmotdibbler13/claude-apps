import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { scanFilms } from "../js/films.js";

const ROOT = "S:\\Youtube video ideas";

async function film(h, name, files = {}, dirs = []) {
  for (const d of dirs) await h.fs.mkdir(`${ROOT}\\${name}\\${d}`);
  for (const [rel, text] of Object.entries(files)) {
    const dir = rel.includes("\\") ? rel.slice(0, rel.lastIndexOf("\\")) : "";
    await h.fs.mkdir(`${ROOT}\\${name}${dir ? "\\" + dir : ""}`);
    await h.fs.write(`${ROOT}\\${name}\\${rel}`, text);
  }
}
const parts = (a, b, c, d) => ({ 1: a, 2: b, 3: c, shorts: d });

test("part 1 handover only: part 2 is next", async () => {
  const h = new FakeHost();
  await film(h, "Alpha", { "handover\\part1_handover.md": "x" });
  const [f] = await scanFilms(h, ROOT);
  assert.equal(f.title, "Alpha");
  assert.equal(f.dir, `${ROOT}\\Alpha`);
  assert.deepEqual(f.parts, parts("done", "now", "none", "none"));
  assert.equal(f.hasStudio, false);
  assert.equal(f.waiting, null);
  assert.equal(f.number, null);
});

test("parts 1 and 2: part 3 is next", async () => {
  const h = new FakeHost();
  await film(h, "Alpha", { "handover\\part1_handover.md": "x", "handover\\part2_handover.md": "x" });
  const [f] = await scanFilms(h, ROOT);
  assert.deepEqual(f.parts, parts("done", "done", "now", "none"));
});

test("part 3 handover: shorts are next", async () => {
  const h = new FakeHost();
  await film(h, "Alpha", {
    "handover\\part1_handover.md": "x", "handover\\part2_handover.md": "x", "handover\\part3_handover.md": "x",
  });
  const [f] = await scanFilms(h, ROOT);
  assert.deepEqual(f.parts, parts("done", "done", "done", "now"));
});

test("folders without handover or studio are skipped; only direct children scanned", async () => {
  const h = new FakeHost();
  await film(h, "Plain", { "notes.txt": "x" });
  await film(h, "voice files", { "a.wav": "x" });
  await film(h, "Wrap\\Nested", { "handover\\part1_handover.md": "x" });
  await film(h, "Real", {}, ["studio"]);
  await h.fs.write(`${ROOT}\\loose.md`, "x");
  const films = await scanFilms(h, ROOT);
  assert.deepEqual(films.map((f) => f.title), ["Real"]);
  assert.equal(films[0].hasStudio, true);
  assert.deepEqual(films[0].parts, parts("now", "none", "none", "none"));
});

test("number is parsed from an Episode line, else null", async () => {
  const h = new FakeHost();
  await film(h, "A", { "handover\\part1_handover.md": "# Title\nEpisode: 014\nmore" });
  await film(h, "B", { "handover\\part1_handover.md": "no number here" });
  const films = await scanFilms(h, ROOT);
  assert.equal(films.find((f) => f.title === "A").number, "014");
  assert.equal(films.find((f) => f.title === "B").number, null);
});

test("waiting is read from studio state.json", async () => {
  const h = new FakeHost();
  await film(h, "A", { "handover\\part1_handover.md": "x", "studio\\state.json": JSON.stringify({ waiting: "Review take 2" }) });
  await film(h, "B", { "studio\\state.json": JSON.stringify({}) });
  await film(h, "C", { "studio\\state.json": "{not json" });
  const films = await scanFilms(h, ROOT);
  const w = (t) => films.find((f) => f.title === t).waiting;
  assert.equal(w("A"), "Review take 2");
  assert.equal(w("B"), null);
  assert.equal(w("C"), null);
});

test("missing root yields no films", async () => {
  assert.deepEqual(await scanFilms(new FakeHost(), ROOT), []);
});

test("one folder that throws does not hide the others", async () => {
  const h = new FakeHost();
  await film(h, "Bad", { "handover\\part1_handover.md": "x" });
  await film(h, "Good", { "handover\\part1_handover.md": "x" });
  const real = h.fs.exists;
  h.fs.exists = async (p) => { if (/\\Bad\\/i.test(p)) throw new Error("EACCES"); return real(p); };
  const films = await scanFilms(h, ROOT);
  assert.deepEqual(films.map((f) => f.title), ["Good"]);
});
