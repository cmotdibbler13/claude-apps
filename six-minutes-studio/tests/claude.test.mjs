import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { askJson, ClaudeError } from "../js/claude.js";

test("askJson sends instructions and data only, no prior turns", async () => {
  const h = new FakeHost();
  let seen;
  h.claudeScript((kind, input, opts) => { seen = { kind, input, opts }; return { ok: 1 }; });
  const r = await askJson(h, { instructions: "Do the thing.", data: { a: "b" }, tier: "quick" });
  assert.deepEqual(r, { ok: 1 });
  assert.equal(seen.kind, "json");
  assert.equal(typeof seen.input, "string");
  assert.ok(seen.input.startsWith("Do the thing."));
  assert.ok(seen.input.includes(JSON.stringify({ a: "b" })));
  assert.ok(seen.input.trimEnd().endsWith("Answer with JSON only."));
  assert.equal(seen.opts.tier, "quick");
});

test("refusal surfaces as ClaudeError code refusal", async () => {
  const h = new FakeHost();
  h.claudeScript(() => { throw { code: "refused", message: "no" }; });
  await assert.rejects(askJson(h, { instructions: "x", data: {} }), (e) => e instanceof ClaudeError && e.code === "refusal");
});

test("other sample codes are kept, bad json is bad_json", async () => {
  const h = new FakeHost();
  h.claudeScript(() => { throw { code: "rate_limited", message: "slow" }; });
  await assert.rejects(askJson(h, { instructions: "x", data: {} }), (e) => e.code === "rate_limited");
  h.claudeScript(() => { throw { code: "invalid_json", message: "nope" }; });
  await assert.rejects(askJson(h, { instructions: "x", data: {} }), (e) => e.code === "bad_json");
});

test("missing claude host is unavailable", async () => {
  const h = new FakeHost({ claude: false });
  await assert.rejects(askJson(h, { instructions: "x", data: {} }), (e) => e.code === "unavailable");
});

test("failed validate throws invalid with the reason", async () => {
  const h = new FakeHost();
  h.claudeScript(() => ({ n: 1 }));
  await assert.rejects(
    askJson(h, { instructions: "x", data: {}, validate: () => { throw new Error("n must be 2"); } }),
    (e) => e.code === "invalid" && /n must be 2/.test(e.message),
  );
});
