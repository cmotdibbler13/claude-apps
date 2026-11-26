import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { parseLineScript, findLineScript, narrationStatus, countsLine } from "../js/narration.js";

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
    { id: "01", section: "Opening", text: "It began in Cornwall, and it did not stop." },
    { id: "02", section: "Opening", text: "Second line." },
    { id: "04", section: "Middle", text: "Fourth." },
  ]);
  assert.equal(parseLineScript("[1]\nhi").name, null);
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
const result = (host, id, o) => put(host, `R:\\Rec\\p\\checks\\p_${id}.json`, JSON.stringify(o));

test("no recordings folder lists all lines missing", async () => {
  const st = await narrationStatus(new FakeHost(), S, LS);
  assert.deepEqual(st.rows.map((r) => r.status), Array(5).fill("missing"));
  assert.deepEqual(st.counts, { total: 5, recorded: 0, ok: 0, flagged: 0 });
  assert.equal(countsLine(st.counts), "0 of 5 recorded");
});

test("statuses: missing, ok, flagged, checking, error; notes vs flags; counts", async () => {
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
  assert.deepEqual(st.rows.map((r) => r.status), ["ok", "flagged", "checking", "checking", "error", "missing"]);
  assert.deepEqual(st.rows[0].notes, ["pause of 0.7 s"]);
  assert.deepEqual(st.rows[1].flags, ["ends too abruptly"]);
  assert.deepEqual(st.rows[1].notes, ["room noise"]);
  assert.deepEqual(st.rows[4].flags, ["model unavailable"]);
  assert.deepEqual(st.counts, { total: 6, recorded: 5, ok: 1, flagged: 1 });
  assert.equal(countsLine(st.counts), "5 of 6 recorded \u00B7 1 ok \u00B7 1 flagged");
  assert.equal(countsLine({ total: 4, recorded: 2, ok: 2, flagged: 0 }), "2 of 4 recorded \u00B7 2 ok");
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
