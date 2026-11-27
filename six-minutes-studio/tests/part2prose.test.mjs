import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { part1Facts, libraryFields, handoverProse, PART1_INSTRUCTIONS, LIBRARY_INSTRUCTIONS, HANDOVER_INSTRUCTIONS } from "../js/part2prose.js";

const host = (reply) => {
  const h = new FakeHost();
  h.seen = [];
  h.claudeScript((kind, text, opts) => { h.seen.push({ text, opts }); return typeof reply === "function" ? reply(text) : reply; });
  return h;
};
const rejects = (p) => assert.rejects(p, (e) => e.code === "invalid");

test("part1Facts: valid, null, and bad shapes", async () => {
  const h = host({ topic: "Tinned Fish", episode: "12" });
  assert.deepEqual(await part1Facts(h, "text"), { topic: "Tinned Fish", episode: "12" });
  assert.equal(h.seen[0].opts.tier, "default");
  assert.ok(h.seen[0].text.includes(PART1_INSTRUCTIONS));
  assert.deepEqual(await part1Facts(host({ topic: null, episode: null }), "x"), { topic: null, episode: null });
  await rejects(part1Facts(host({ topic: "A", episode: "12345" }), "x"));
  await rejects(part1Facts(host({ topic: "A", episode: "ep1" }), "x"));
  await rejects(part1Facts(host({ topic: "A", episode: 3 }), "x"));
  await rejects(part1Facts(host({ topic: "", episode: null }), "x"));
  await rejects(part1Facts(host({ topic: "A" }), "x"));
  await rejects(part1Facts(host([]), "x"));
});

const item = (key, kind = "approved") => ({ key, kind, shot: "HF-03", desc: "d", prompt: "p", line: "l", tool: "higgsfield", model: "Kling 3.0 pro", aspect: "16:9", probe: { width: 1920, height: 1080, fps: 24 }, note: "" });
const good = (key) => ({ key, description: "A tree.", setting: "Living room", period: "1970s", tags: ["a", "b", "c", "d", "e", "f", "g", "h"], notes: "Higgsfield Kling 3.0 pro, 16:9, 1920x1080 24 fps, sound off." });
const bad = (key) => ({ key, description: "A tree.", setting: "", period: "", tags: ["x", "rejected"], notes: "Rejected: not chosen in review" });

test("libraryFields: every item once, map keyed, tier default", async () => {
  const h = host({ items: [good("a"), bad("b")] });
  const m = await libraryFields(h, [item("a"), item("b", "rejected")]);
  assert.equal(h.seen.length, 1);
  assert.equal(h.seen[0].opts.tier, "default");
  assert.ok(h.seen[0].text.includes(LIBRARY_INSTRUCTIONS));
  assert.ok(h.seen[0].text.includes('"key":"a"') && h.seen[0].text.includes('"key":"b"'));
  assert.deepEqual([...m.keys()], ["a", "b"]);
  assert.equal(m.get("a").period, "1970s");
  assert.ok(!("key" in m.get("a")));
});

test("libraryFields: rejects bad shapes", async () => {
  const two = [item("a"), item("b", "rejected")];
  await rejects(libraryFields(host({ items: [good("a")] }), two));
  await rejects(libraryFields(host({ items: [good("a"), good("a")] }), two));
  await rejects(libraryFields(host({ items: [good("a"), good("zz")] }), two));
  await rejects(libraryFields(host({ items: [good("a"), good("b")] }), two));
  await rejects(libraryFields(host({ items: [{ ...good("a"), tags: ["a"] }, bad("b")] }), two));
  await rejects(libraryFields(host({ items: [{ ...good("a"), extra: 1 }, bad("b")] }), two));
  await rejects(libraryFields(host({ items: [good("a"), { ...bad("b"), notes: "nope" }] }), two));
  await rejects(libraryFields(host({}), two));
});

const data = { notes: [{ id: "HF-03", take: 2, note: "too fast" }], choices: ["Music: calm"], warnings: ["Slow pacing at 02:10"] };
test("handoverProse: data carries notes; validates lists", async () => {
  const h = host({ decisions: ["He chose calm."], openItems: ["Check pacing."] });
  assert.deepEqual(await handoverProse(h, data), { decisions: ["He chose calm."], openItems: ["Check pacing."] });
  assert.equal(h.seen[0].opts.tier, "default");
  assert.ok(h.seen[0].text.includes(HANDOVER_INSTRUCTIONS));
  assert.ok(h.seen[0].text.includes("too fast") && h.seen[0].text.includes("Slow pacing at 02:10"));
  await rejects(handoverProse(host({ decisions: [], openItems: ["a"] }), data));
  await rejects(handoverProse(host({ decisions: ["a"], openItems: [""] }), data));
  await rejects(handoverProse(host({ decisions: ["a"], openItems: ["x".repeat(601)] }), data));
});
test("handoverProse: a big film's long lists are kept; no open items is fine", async () => {
  const many = Array.from({ length: 42 }, (_, i) => `Decision ${i + 1}`);
  assert.deepEqual(await handoverProse(host({ decisions: many, openItems: [] }), data), { decisions: many, openItems: [] });
  await rejects(handoverProse(host({ decisions: ["a"] }), data));
  await rejects(handoverProse(host({ decisions: [], openItems: [] }), data));
  await rejects(handoverProse(host({ decisions: "a", openItems: ["a"] }), data));
});
