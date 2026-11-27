import { test } from "node:test";
import assert from "node:assert/strict";
import { SCRIPT_INSTRUCTIONS, CHECK_INSTRUCTIONS, validateScript, validateCheck } from "../js/tools/blenderprompts.js";

test("script instructions carry the contract", () => {
  const s = SCRIPT_INSTRUCTIONS;
  for (const needle of ["--still", "Freestyle", "#d5a867", "vertical", "70", "1920", "24 fps", "H264", "media_type", "freestyle_edge", "use_freestyle_mark", "sys.argv"]) {
    assert.ok(s.includes(needle), `missing ${needle}`);
  }
  assert.match(s, /never[^.]*image (plane|card)/i);
  assert.match(s, /point cloud/i);
  assert.match(s, /#03070c/);
  assert.match(s, /#091a2e/);
  assert.match(s, /MUST NOT use the network/);
  assert.match(s, /MUST NOT read any file other than the source image/);
  assert.match(s, /"frames"/);
});

test("check instructions name the two images and the answer shape", () => {
  const c = CHECK_INSTRUCTIONS;
  assert.match(c, /image 1[^.]*drawing/i);
  assert.match(c, /image 2[^.]*still/i);
  for (const needle of ['"matches"', '"fix"', '"blank"', '"note"', '"script"', '"frames"', "--still"]) {
    assert.ok(c.includes(needle), `missing ${needle}`);
  }
  assert.match(c, /error/i);
  assert.match(c, /JSON only/);
});

test("validateScript accepts a good answer", () => {
  validateScript({ script: "import bpy", frames: 240 });
  validateScript({ script: "x", frames: 1 });
  validateScript({ script: "x", frames: 2400 });
});

test("validateScript rejects each bad shape", () => {
  for (const bad of [null, "s", 3, {}, { script: "", frames: 10 }, { script: "  ", frames: 10 }, { script: 5, frames: 10 },
    { script: "x" }, { script: "x", frames: 0 }, { script: "x", frames: 2401 }, { script: "x", frames: 2.5 }, { script: "x", frames: "240" }]) {
    assert.throws(() => validateScript(bad), undefined, JSON.stringify(bad));
  }
});

test("validateCheck accepts good answers", () => {
  validateCheck({ verdict: "matches", note: "looks right" });
  validateCheck({ verdict: "fix", note: "made the top slab thicker; moved the shelves up", script: "import bpy", frames: 216 });
  validateCheck({ verdict: "fix", note: "thicker lines", script: "import bpy" });
  validateCheck({ verdict: "blank", note: "camera was inside the slab", script: "import bpy" });
});

test("validateCheck rejects each bad shape", () => {
  for (const bad of [null, "matches", {}, { verdict: "ok", note: "n" }, { verdict: "matches" }, { verdict: "matches", note: "" },
    { verdict: "matches", note: "   " }, { verdict: "matches", note: 3 }, { verdict: "fix", note: "n" }, { verdict: "fix", note: "n", script: "" },
    { verdict: "blank", note: "n" }, { verdict: "blank", note: "n", script: "  " }, { verdict: "fix", note: "n", script: "x", frames: 0 },
    { verdict: "fix", note: "n", script: "x", frames: 2401 }, { verdict: "fix", note: "n", script: "x", frames: 1.5 }]) {
    assert.throws(() => validateCheck(bad), undefined, JSON.stringify(bad));
  }
});
