import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { stampName, writeSafely, copyAside, moveAside, readCatalogue } from "../js/libraryio.js";

const txt = (h, p) => new TextDecoder().decode(h.files.get(p));
const NOW = new Date(2026, 10, 27, 9, 5).getTime();
const DIR = "S:\\Youtube video ideas\\B-roll library";

test("stampName adds the local date and time before the extension", () => {
  assert.equal(stampName(`${DIR}\\broll_catalogue.json`, NOW), `${DIR}\\broll_catalogue_2026-11-27-0905.json`);
  assert.equal(stampName("C:\\a.b\\noext", NOW), "C:\\a.b\\noext_2026-11-27-0905");
});

test("writeSafely writes tmp then renames, leaving no .tmp, strings as UTF-8 and bytes as is", async () => {
  const h = new FakeHost();
  await h.fs.mkdir(DIR);
  const p = `${DIR}\\x.json`;
  await writeSafely(h, p, "é\n");
  assert.equal(h.files.get(p), "é\n");
  assert.equal(await h.fs.exists(p + ".tmp"), false);
  await writeSafely(h, p, new Uint8Array([1, 2]));
  assert.deepEqual([...h.files.get(p)], [1, 2]);
  assert.equal(await h.fs.exists(p + ".tmp"), false);
});

test("copyAside keeps the original and never overwrites an existing stamped name", async () => {
  const h = new FakeHost();
  await h.fs.mkdir(DIR);
  const p = `${DIR}\\broll_catalogue.json`;
  await h.fs.write(p, "old");
  const a = await copyAside(h, p, NOW);
  assert.equal(a, `${DIR}\\broll_catalogue_2026-11-27-0905.json`);
  assert.equal(h.files.get(p), "old");
  assert.equal(txt(h, a), "old");
  await h.fs.write(p, "newer");
  const b = await copyAside(h, p, NOW);
  assert.equal(b, `${DIR}\\broll_catalogue_2026-11-27-0905_2.json`);
  const c = await copyAside(h, p, NOW);
  assert.equal(c, `${DIR}\\broll_catalogue_2026-11-27-0905_3.json`);
  assert.equal(txt(h, a), "old");
  assert.equal(txt(h, b), "newer");
});

test("moveAside renames; both are no-ops when the source is missing", async () => {
  const h = new FakeHost();
  await h.fs.mkdir(DIR);
  const p = `${DIR}\\part2_handover.md`;
  assert.equal(await moveAside(h, p, NOW), null);
  assert.equal(await copyAside(h, p, NOW), null);
  await h.fs.write(p, "x");
  const a = await moveAside(h, p, NOW);
  assert.equal(await h.fs.exists(p), false);
  assert.equal(h.files.get(a), "x");
  await h.fs.write(p, "y");
  const b = await moveAside(h, p, NOW);
  assert.equal(b, `${DIR}\\part2_handover_2026-11-27-0905_2.md`);
  assert.equal(h.files.get(a), "x");
});

const ROOT = "S:\\Youtube video ideas";
test("readCatalogue returns doc, key, entries, md and paths", async () => {
  const h = new FakeHost();
  await h.fs.mkdir(DIR);
  await h.fs.write(`${DIR}\\broll_catalogue.json`, JSON.stringify({ note: "n", clips: [{ id: "BR-001" }] }));
  await h.fs.write(`${DIR}\\broll_catalogue.md`, "# md\n");
  const r = await readCatalogue(h, ROOT);
  assert.equal(r.key, "clips");
  assert.equal(r.entries.length, 1);
  assert.equal(r.doc.note, "n");
  assert.equal(r.md, "# md\n");
  assert.deepEqual(r.paths, { dir: DIR, json: `${DIR}\\broll_catalogue.json`, md: `${DIR}\\broll_catalogue.md`, thumbs: `${DIR}\\thumbs`, sheets: `${DIR}\\contact_sheets`, clips: `${DIR}\\clips` });
});

test("readCatalogue works from a BOM file and an absent md, and throws with the reason otherwise", async () => {
  const h = new FakeHost();
  await h.fs.mkdir(DIR);
  await assert.rejects(readCatalogue(h, ROOT), /broll_catalogue\.json/);
  await h.fs.write(`${DIR}\\broll_catalogue.json`, "\uFEFF" + JSON.stringify({ clips: [] }));
  assert.equal((await readCatalogue(h, ROOT)).md, "");
  await h.fs.write(`${DIR}\\broll_catalogue.json`, "{not json");
  await assert.rejects(readCatalogue(h, ROOT), /isn't valid JSON/);
  await h.fs.write(`${DIR}\\broll_catalogue.json`, JSON.stringify({ a: 1 }));
  await assert.rejects(readCatalogue(h, ROOT));
});
