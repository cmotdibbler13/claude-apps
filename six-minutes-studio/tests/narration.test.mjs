import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { parseLineScript, findLineScript, loadLineScript, refreshLineScript, narrationStatus, countsLine } from "../js/narration.js";

const SCRIPT = `\uFEFF# name: china_clay
# a comment
## Opening
[01]  (cold open)
It began in Cornwall,
and it did not stop.
> slowly
[02] x
Second line.
## Middle
[03]
> only a note, no text
[04]
Fourth.
`;

test("parse parity: name, sections, notes, multi-line, empty lines dropped", () => {
  const p = parseLineScript(SCRIPT);
  assert.equal(p.name, "china_clay");
  assert.deepEqual(p.lines, [
    { id: "01", section: "Opening", text: "It began in Cornwall, and it did not stop.", toCamera: false },
    { id: "02", section: "Opening", text: "Second line.", toCamera: false },
    { id: "04", section: "Middle", text: "Fourth.", toCamera: false },
  ]);
  assert.equal(parseLineScript("[1]\nhi").name, null);
});

test("a '> To Camera ' note marks a line to camera; other notes do not", () => {
  const p = parseLineScript("[a]\nOne.\n> slowly\n[b]\nTwo.\n>  To Camera \n[c]\nThree.\n> to camera please\n");
  assert.deepEqual(p.lines.map((l) => l.toCamera), [false, true, false]);
});

async function put(host, p, data) {
  await host.fs.mkdir(p.replace(/\\[^\\]*$/, ""));
  await host.fs.write(p, data);
}

test("findLineScript order: handover path, film folder, narration folder, autocueDir", async () => {
  const host = new FakeHost();
  const film = "S:\\Films\\Clay", settings = { autocueDir: "C:\\Autocue" };
  await put(host, "C:\\Autocue\\clay_line_script.txt", "x");
  assert.equal(await findLineScript(host, film, "", settings), "C:\\Autocue\\clay_line_script.txt");
  await put(host, `${film}\\narration\\a_line_script.txt`, "x");
  assert.equal(await findLineScript(host, film, "", settings), `${film}\\narration\\a_line_script.txt`);
  await put(host, `${film}\\b_line_script.txt`, "x");
  assert.equal(await findLineScript(host, film, "", settings), `${film}\\b_line_script.txt`);
  await put(host, `${film}\\handover\\my_lines.txt`, "x");
  assert.equal(await findLineScript(host, film, "Use `handover/my_lines.txt` for it", settings), `${film}\\handover\\my_lines.txt`);
  assert.equal(await findLineScript(host, film, "Read D:\\x\\abs_line.txt now", settings), `${film}\\b_line_script.txt`);
  await put(host, "D:\\x\\abs_line.txt", "x");
  assert.equal(await findLineScript(host, film, "Read D:\\x\\abs_line.txt now", settings), "D:\\x\\abs_line.txt");
  assert.equal(await findLineScript(host, film, "see notes.txt", { }), `${film}\\b_line_script.txt`);
  assert.equal(await findLineScript(new FakeHost(), film, "", settings), null);
});

test("autocueDir only offers this film's line script, never another film's", async () => {
  const host = new FakeHost();
  const settings = { autocueDir: "C:\\Autocue" };
  await put(host, "C:\\Autocue\\aardvark_line_script.txt", "x"); // alphabetically first
  await put(host, "C:\\Autocue\\china_clay_line_script.txt", "x");
  await put(host, "C:\\Autocue\\WhealJane-line-script.txt", "x");
  assert.equal(await findLineScript(host, "S:\\Films\\China Clay", "", settings), "C:\\Autocue\\china_clay_line_script.txt");
  assert.equal(await findLineScript(host, "S:\\Films\\Wheal Jane", "", settings), "C:\\Autocue\\WhealJane-line-script.txt"); // slug without "_"
  assert.equal(await findLineScript(host, "S:\\Films\\Botallack", "", settings), null);
  // The film's own folders still take any line script.
  await put(host, "S:\\Films\\Botallack\\narration\\lines_script.txt", "x");
  assert.equal(await findLineScript(host, "S:\\Films\\Botallack", "", settings), "S:\\Films\\Botallack\\narration\\lines_script.txt");
});

const LS = { name: "p", lines: [{ id: "01", section: "", text: "a" }, { id: "02", section: "", text: "b" }, { id: "03", section: "", text: "c" }, { id: "04", section: "", text: "d" }, { id: "05", section: "", text: "e" }] };
const S = { autocueRecordings: "R:\\Rec" };
// FakeHost stats every file at host.t, so a take's mtime is kept in a side table.
const take = async (host, id, mtimeMs) => {
  const path = `R:\\Rec\\p\\p_${id}.wav`;
  if (!host.mt) {
    host.mt = new Map();
    const stat = host.fs.stat;
    host.fs.stat = async (p) => ({ ...(await stat(p)), mtimeMs: host.mt.get(p) ?? host.t });
  }
  host.mt.set(path, mtimeMs);
  await put(host, path, "wav");
};
// Results from the current checks unless a test says otherwise.
const result = (host, id, o) => put(host, `R:\\Rec\\p\\checks\\p_${id}.json`, JSON.stringify({ version: 2, ...o }));

test("no recordings folder lists all lines missing", async () => {
  const st = await narrationStatus(new FakeHost(), S, LS);
  assert.deepEqual(st.rows.map((r) => r.status), Array(5).fill("missing"));
  assert.deepEqual(st.counts, { total: 5, recorded: 0, ok: 0, jon: 0, flagged: 0, unchecked: 0 });
  assert.equal(countsLine(st.counts), "0 of 5 recorded");
});

test("statuses: missing, ok, flagged, unchecked, checking, error; notes vs flags; counts", async () => {
  const host = new FakeHost();
  await take(host, "01", 1_000_000);
  await result(host, "01", { take_mtime: 1000, ok: true, flags: [{ kind: "pause", text: "pause of 0.7 s" }] });
  await take(host, "02", 2_000_000);
  await result(host, "02", { take_mtime: 2000.004, ok: false, flags: [{ kind: "cut_off", text: "ends too abruptly" }, { kind: "noise", text: "room noise" }] });
  await take(host, "03", 3_000_000); // no result yet
  await take(host, "04", 4_000_000);
  await result(host, "04", { take_mtime: 3999, ok: true, flags: [] }); // older take checked
  await take(host, "05", 5_000_000);
  await result(host, "05", { take_mtime: 5000, error: "model unavailable" });
  const st = await narrationStatus(host, S, { ...LS, lines: [...LS.lines, { id: "06", section: "", text: "f" }] });
  assert.deepEqual(st.rows.map((r) => r.status), ["ok", "flagged", "unchecked", "checking", "error", "missing"]);
  assert.deepEqual(st.rows[0].notes, ["pause of 0.7 s"]);
  assert.deepEqual(st.rows[1].flags, ["ends too abruptly"]);
  assert.deepEqual(st.rows[1].notes, ["room noise"]);
  assert.deepEqual(st.rows[4].flags, ["model unavailable"]);
  assert.deepEqual(st.counts, { total: 6, recorded: 5, ok: 1, jon: 0, flagged: 1, unchecked: 1 });
  assert.equal(countsLine(st.counts), "5 of 6 recorded \u00B7 1 ok \u00B7 1 flagged \u00B7 1 not checked \u2014 press Check all in Autocue Studio");
  assert.equal(countsLine({ total: 4, recorded: 2, ok: 2, flagged: 0, unchecked: 0 }), "2 of 4 recorded \u00B7 2 ok");
  assert.equal(countsLine({ total: 4, recorded: 3, ok: 0, flagged: 0, unchecked: 3 }), "3 of 4 recorded \u00B7 3 not checked \u2014 press Check all in Autocue Studio");
});

test("a take with no check yet is Not checked; an out-of-date check is Checking", async () => {
  const { narrationModel } = await import("../js/ui/review.js");
  const host = new FakeHost();
  await take(host, "01", 1_000_000); // never checked (e.g. recorded before checks existed)
  await take(host, "02", 2_000_000);
  await result(host, "02", { take_mtime: 1990, ok: true, flags: [] }); // re-recorded since
  const st = await narrationStatus(host, S, { ...LS, lines: LS.lines.slice(0, 2) });
  const m = narrationModel(st);
  assert.deepEqual(m.rows.map((r) => [r.status, r.chip]), [["unchecked", "Not checked"], ["checking", "Checking\u2026"]]);
});

test("refreshLineScript: one stat; re-reads only when the file's mtime changes", async () => {
  const host = new FakeHost();
  const p = "S:\\Films\\Clay\\clay_line_script.txt";
  await put(host, p, "# name: clay\n[01]\nOne.\n");
  host.t = 1000;
  const ls = await loadLineScript(host, p);
  assert.equal(ls.path, p);
  assert.equal(ls.mtimeMs, 1000);
  let stats = 0, reads = 0;
  const { stat, read } = host.fs;
  host.fs.stat = async (q) => { stats++; return stat(q); };
  host.fs.read = async (...a) => { reads++; return read(...a); };
  assert.equal(await refreshLineScript(host, ls), ls);
  assert.deepEqual([stats, reads], [1, 0]);
  await host.fs.write(p, "# name: clay\n[01]\nOne.\n[02]\nTwo.\n");
  host.t = 2000;
  const again = await refreshLineScript(host, ls);
  assert.deepEqual(again.lines.map((l) => l.id), ["01", "02"]);
  assert.equal(again.mtimeMs, 2000);
  assert.deepEqual([stats, reads], [3, 1]); // the check, then the reload's own stat
  host.fs.stat = async () => { throw new Error("ENOENT"); };
  assert.equal(await refreshLineScript(host, again), null); // gone: look for it again
});

test("review model: counts line, snipped text, flag text, missing line script", async () => {
  const { reviewModel, narrationModel } = await import("../js/ui/review.js");
  const long = "w".repeat(90);
  const m = narrationModel({ rows: [{ id: "01", section: "", text: long, status: "flagged", flags: ["ends too abruptly"], notes: [] }], counts: { total: 2, recorded: 1, ok: 0, flagged: 1 } });
  assert.equal(m.counts, "1 of 2 recorded · 1 flagged");
  assert.ok(m.rows[0].text.length <= 61);
  assert.equal(m.rows[0].chip, "Flagged");
  assert.equal(m.rows[0].flag, "ends too abruptly");
  assert.equal(narrationModel({ missingScript: true }).message, "No line script found for this film. Name it in part1_handover.md.");
  assert.equal(narrationModel(null), null);
  assert.equal(reviewModel({ film: { title: "T" }, state: { assets: [] }, narration: { missingScript: true } }).narration.rows.length, 0);
});

test("render never passes null/undefined to replaceChildren when narration is absent", async () => {
  const mk = (tag) => ({ tag, children: [], style: {}, setAttribute() {}, addEventListener() {}, append(...k) { this.children.push(...k); } });
  globalThis.Node = class {};
  globalThis.document = { createElement: mk, createTextNode: (t) => ({ t }) };
  try {
    const { reviewModel, render } = await import("../js/ui/review.js");
    for (const assets of [[], [{ id: "A1", kind: "broll", tool: "higgsfield", line: "l", desc: "d", takes: [], chosen: 0 }]]) {
      const el = { args: null, replaceChildren(...a) { this.args = a; } };
      render(el, reviewModel({ film: { title: "T" }, state: { assets }, narration: null }), {});
      assert.ok(el.args.length > 0);
      assert.ok(el.args.every((a) => a !== null && a !== undefined));
    }
  } finally { delete globalThis.document; delete globalThis.Node; }
});

test("recorded lines carry their take file for the play button; missing ones don't", async () => {
  const { FakeHost } = await import("./fake-host.mjs");
  const { narrationStatus } = await import("../js/narration.js");
  const h = new FakeHost();
  const base = "C:\\A\\Recordings\\skara";
  await h.fs.mkdir(base);
  await h.fs.write(`${base}\\skara_01.1.wav`, "RIFF");
  const st = await narrationStatus(h, { autocueRecordings: "C:\\A\\Recordings" },
    { name: "skara", lines: [{ id: "01.1", section: "", text: "One." }, { id: "01.2", section: "", text: "Two." }] });
  assert.equal(st.rows[0].file, `${base}\\skara_01.1.wav`);
  assert.equal(st.rows[1].file, undefined);
});

test("narration rows show which take is playing", async () => {
  const { narrationModel } = await import("../js/ui/review.js");
  const n = { counts: { total: 2, recorded: 1, ok: 1, flagged: 0, unchecked: 0 },
    rows: [{ id: "01.1", text: "One.", status: "ok", flags: [], notes: [], file: "C:\\t\\a_01.1.wav" },
           { id: "01.2", text: "Two.", status: "missing", flags: [], notes: [] }] };
  const m = narrationModel(n, "C:\\t\\a_01.1.wav");
  assert.equal(m.rows[0].playing, true);
  assert.equal(m.rows[0].file, "C:\\t\\a_01.1.wav");
  assert.equal(m.rows[1].file, null);
  assert.equal(m.rows[1].playing, false);
  assert.equal(narrationModel(n, null).rows[0].playing, false);
});

test("results from the old checks show as Old check; OK by Jon holds only for that take", async () => {
  const { narrationStatus, countsLine } = await import("../js/narration.js");
  const h = new FakeHost();
  const base = "C:\\A\\Recordings\\skara";
  await h.fs.mkdir(`${base}\\checks`);
  for (const id of ["01.1", "01.2", "01.3"]) await h.fs.write(`${base}\\skara_${id}.wav`, "RIFF");
  const stat = h.fs.stat.bind(h.fs);
  h.fs.stat = async (p) => ({ ...(await stat(p)), isFile: true, mtimeMs: 100000 });
  const res = (o) => JSON.stringify({ take_mtime: 100, ...o });
  await h.fs.write(`${base}\\checks\\skara_01.1.json`, res({ ok: false, version: 1, flags: [{ kind: "misread", text: "old" }] }));
  await h.fs.write(`${base}\\checks\\skara_01.2.json`, res({ ok: false, version: 2, flags: [{ kind: "misread", text: "may have added \"A\"" }] }));
  await h.fs.write(`${base}\\checks\\skara_01.3.json`, res({ ok: false, version: 2, flags: [{ kind: "cut_off", text: "cut" }] }));
  const ls = { name: "skara", lines: ["01.1", "01.2", "01.3"].map((id) => ({ id, section: "", text: id })) };
  const st = await narrationStatus(h, { autocueRecordings: "C:\\A\\Recordings" }, ls,
    { "01.2": { take_mtime: 100 }, "01.3": { take_mtime: 99 } });   // 01.3 approved for an older take
  assert.deepEqual(st.rows.map((r) => r.status), ["outdated", "jon", "flagged"]);
  assert.equal(st.rows[1].checkedStatus, "flagged");
  assert.deepEqual(st.rows[1].flags, ['may have added "A"']);
  assert.equal(st.counts.jon, 1);
  assert.match(countsLine(st.counts), /1 OK by Jon/);
});

test("Sounds OK is offered on recorded takes that aren't already OK", async () => {
  const { narrationModel } = await import("../js/ui/review.js");
  const row = (status, extra = {}) => ({ id: status, text: "x", status, flags: [], notes: [], file: status === "missing" ? undefined : "f.wav", takeS: 1, ...extra });
  const n = { counts: { total: 5, recorded: 4, ok: 1, flagged: 1, unchecked: 1, jon: 1 },
    rows: [row("ok"), row("flagged"), row("outdated"), row("jon"), row("missing")] };
  const m = narrationModel(n).rows;
  assert.deepEqual(m.map((r) => r.canOk), [false, true, true, false, false]);
  assert.deepEqual(m.map((r) => r.canUndoOk), [false, false, false, true, false]);
  assert.deepEqual(m.map((r) => r.chip), ["OK", "Flagged", "Old check", "OK by Jon", "Missing"]);
});

test("Re-record shows in the counts, the chip and the reason", async () => {
  const { narrationModel } = await import("../js/ui/review.js");
  const { STATUS_LABEL } = await import("../js/narration.js");
  assert.equal(STATUS_LABEL.rerecord, "Re-record");
  const n = { counts: { total: 2, recorded: 2, ok: 1, flagged: 0, rerecord: 1 },
    rows: [{ id: "a", text: "x", status: "ok", flags: [], notes: [] }, { id: "b", text: "x", status: "rerecord", flags: ["too fast"], notes: [], file: "f.wav", takeS: 1 }] };
  assert.match(countsLine(n.counts), /1 ok · 1 to re-record/);
  const m = narrationModel(n).rows[1];
  assert.equal(m.chip, "Re-record");
  assert.equal(m.flag, "too fast");
});

test("a Re-record row does not offer Sounds OK", async () => {
  const { narrationModel } = await import("../js/ui/review.js");
  const n = { counts: { total: 1, recorded: 1 }, rows: [{ id: "a", text: "x", status: "rerecord", flags: ["n"], notes: [], file: "f.wav", takeS: 1 }] };
  assert.equal(narrationModel(n).rows[0].canOk, false);
});
