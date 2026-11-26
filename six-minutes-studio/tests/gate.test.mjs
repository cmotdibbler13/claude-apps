import { test } from "node:test";
import assert from "node:assert/strict";
import { accessGate } from "../js/gate.js";

test("granted boots straight away", () => {
  assert.deepEqual(accessGate("granted"), { boot: true });
});

test("not asked yet: explain and ask from a click", () => {
  const g = accessGate("prompt");
  assert.equal(g.boot, false);
  assert.equal(g.message, "Six Minutes Studio needs full access to read your project folders on S:.");
  assert.equal(g.button, "Allow access");
  assert.equal(g.action, "request");
});

test("denied: offer the permissions dialog", () => {
  const g = accessGate("denied");
  assert.equal(g.boot, false);
  assert.match(g.message, /full access is turned off/i);
  assert.equal(g.button, "Open permissions");
  assert.equal(g.action, "manage");
});

test("unavailable says so plainly and can check again", () => {
  for (const s of ["unavailable", undefined, "something new"]) {
    const g = accessGate(s);
    assert.equal(g.boot, false);
    assert.match(g.message, /full access isn't available in this window/i);
    assert.equal(g.button, "Try again");
    assert.equal(g.action, "recheck");
  }
});

test("gate copy: sentence case, no exclamation marks", () => {
  for (const s of ["prompt", "denied", "unavailable"]) {
    const g = accessGate(s);
    for (const t of [g.title, g.message, g.button]) { assert.ok(!t.includes("!"), t); assert.match(t, /^[A-Z]/); }
  }
});
