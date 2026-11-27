import { test } from "node:test";
import assert from "node:assert/strict";
import { readCredits, creditsLine, makeCredits } from "../js/credits.js";
import { FakeHost } from "./fake-host.mjs";

const answers = (h, { hf, el } = {}) => h.mcpScript((s, t) => {
  if (s === "Higgsfield" && t === "balance") { if (hf instanceof Error) throw hf; return hf ?? { credits: 1725.75, subscription_plan_type: "plus" }; }
  if (s === "ElevenLabs" && t === "account_get_usage") { if (el instanceof Error) throw el; return el ?? { character_count: 58372, character_limit: 221488, next_character_count_reset_unix: 1797024868 }; }
  throw new Error("unexpected " + s + "." + t);
});

test("reads both balances; ElevenLabs left = limit - used", async () => {
  const h = new FakeHost(); answers(h);
  const c = await readCredits(h);
  assert.deepEqual(c.higgsfield, { credits: 1725.75 });
  assert.deepEqual(c.elevenlabs, { left: 163116, limit: 221488, resetAt: 1797024868000 });
  assert.equal(creditsLine(c), "Higgsfield 1,726 · ElevenLabs 163,116 of 221,488");
});

test("one account failing doesn't hide the other", async () => {
  const h = new FakeHost(); answers(h, { hf: new Error("consent_required") });
  const c = await readCredits(h);
  assert.equal(c.higgsfield, null);
  assert.equal(creditsLine(c), "Higgsfield – · ElevenLabs 163,116 of 221,488");
});

test("JSON-text payloads are read too; no mcp → null line", async () => {
  const h = new FakeHost(); answers(h, { hf: JSON.stringify({ credits: 12 }) });
  assert.equal((await readCredits(h)).higgsfield.credits, 12);
  assert.equal(creditsLine(null), null);
  assert.equal(await readCredits(new FakeHost({ mcp: false })), null);
});

test("makeCredits: refresh tells listeners; overlapping refreshes share one read", async () => {
  const h = new FakeHost(); let calls = 0;
  h.mcpScript((s) => { calls++; return s === "Higgsfield" ? { credits: 5 } : { character_count: 1, character_limit: 3 }; });
  const c = makeCredits(h); let told = 0; c.onChange(() => told++);
  await Promise.all([c.refresh(), c.refresh()]);
  assert.equal(calls, 2); assert.equal(told, 1);
  assert.equal(c.line(), "Higgsfield 5 · ElevenLabs 2 of 3");
});
