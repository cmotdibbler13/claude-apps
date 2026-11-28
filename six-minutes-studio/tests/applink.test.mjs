// app.js needs a browser, so this reads its source: Studio opening must not wait on the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const body = src.slice(src.indexOf("async function loadRoot()"), src.indexOf("function startRoot()"));

test("loadRoot starts the link after scanning films, without waiting on it, and catches a throw", () => {
  assert.ok(body.includes("app.jobs.restore(saved)"));
  assert.doesNotMatch(body, /await\s+startLink\(/);
  const scan = body.indexOf("scanFilms(");
  const link = body.indexOf("startLink(");
  assert.ok(scan > 0 && link > scan, "startLink comes after scanFilms");
  assert.ok(body.indexOf("app.jobs.restore(saved)") < link, "reconcile and tidy still follow restore");
  assert.match(body.slice(link - 200, link + 200), /try\s*\{[^}]*startLink\(/);
});

test("acceptance step 18 uses the real button label", () => {
  const doc = readFileSync(new URL("../docs/acceptance-slice1.md", import.meta.url), "utf8");
  const step = doc.split("\n").find((l) => l.startsWith("18. If a ComfyUI job fails"));
  assert.ok(step);
  assert.doesNotMatch(step, /\*\*Check\*\*/);
  assert.match(step, /\*\*Check again\*\*/);
});
