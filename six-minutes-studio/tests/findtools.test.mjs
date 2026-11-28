import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { GET_IT, openLink, findCandidates, checkChoice } from "../js/findtools.js";

const put = (host, p) => { const i = p.lastIndexOf("\\"); host.dirs.add(p.slice(0, i)); host.files.set(p, "x"); };
// Scripts `where <exe>`, `cmd /c echo %VAR%` and --version answers.
const script = (host, { where = {}, env = {}, version = {} } = {}) => {
  host.spawnScript((cmd, args, o, p) => {
    if (cmd === "where") {
      const r = where[args[0]];
      if (r) { p.out(r); p.exit(0); } else { p.out("INFO: Could not find files for the given pattern(s).\r\n"); p.exit(1); }
    } else if (cmd === "cmd" && args[0] === "/c" && args[1] === "echo") {
      const v = env[args[2]];
      if (v) { p.out(v + "\r\n"); p.exit(0); } else { p.exit(1); }
    } else if (version[cmd]) { p.out(version[cmd]); p.exit(0); }
    else { p.err(`spawn ${cmd} ENOENT`); p.exit(null); }
  });
};

test("GET_IT holds the download pages", () => {
  assert.equal(GET_IT.ffmpeg, "https://www.gyan.dev/ffmpeg/builds/");
  assert.equal(GET_IT.blender, "https://www.blender.org/download/");
  assert.equal(GET_IT.comfyui, "https://www.comfy.org/download");
  assert.equal(GET_IT.pinokio, "https://pinokio.computer/");
  assert.equal(GET_IT.python, "https://www.python.org/downloads/windows/");
  assert.equal(GET_IT.repo, "https://github.com/cmotdibbler13/claude-apps");
});

test("openLink opens a known page with cmd /c start and refuses anything else", async () => {
  const host = new FakeHost();
  const spawned = [];
  host.spawnScript((cmd, args, o, p) => { spawned.push([cmd, ...args]); p.exit(0); });
  await openLink(host, GET_IT.blender);
  assert.deepEqual(spawned, [["cmd", "/c", "start", "", GET_IT.blender]]);
  await assert.rejects(openLink(host, "https://example.com/"), /Not a known download page\./);
  assert.equal(spawned.length, 1);
});

test("Blender: newest version first across C: and D:, existing only", async () => {
  const host = new FakeHost();
  put(host, "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe");
  put(host, "D:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe");
  put(host, "D:\\Blender Foundation\\Blender 4.10\\blender.exe");
  host.dirs.add("C:\\Program Files\\Blender Foundation\\Blender 6.0"); // no exe
  script(host);
  assert.deepEqual(await findCandidates(host, "blender"), [
    "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe",
    "D:\\Blender Foundation\\Blender 4.10\\blender.exe",
    "D:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe",
  ]);
});

test("ffmpeg: where output is parsed, unique and existing only; nothing found is an empty list", async () => {
  const host = new FakeHost();
  put(host, "C:\\ffmpeg\\bin\\ffmpeg.exe");
  put(host, "D:\\tools\\ffmpeg.exe");
  script(host, { where: { ffmpeg: "C:\\ffmpeg\\bin\\ffmpeg.exe\r\nD:\\tools\\ffmpeg.exe\r\nC:\\ffmpeg\\bin\\ffmpeg.exe\r\nE:\\gone\\ffmpeg.exe\r\n" } });
  assert.deepEqual(await findCandidates(host, "ffmpeg"), ["C:\\ffmpeg\\bin\\ffmpeg.exe", "D:\\tools\\ffmpeg.exe"]);
  script(host);
  assert.deepEqual(await findCandidates(host, "ffmpeg"), []);
});

test("Python: where python plus the per-user installs, newest first", async () => {
  const host = new FakeHost();
  put(host, "C:\\Users\\jon\\AppData\\Local\\Programs\\Python\\Python311\\python.exe");
  put(host, "C:\\Users\\jon\\AppData\\Local\\Programs\\Python\\Python313\\python.exe");
  put(host, "D:\\Py\\python.exe");
  script(host, { where: { python: "D:\\Py\\python.exe\r\n" }, env: { "%LOCALAPPDATA%": "C:\\Users\\jon\\AppData\\Local" } });
  assert.deepEqual(await findCandidates(host, "python"), [
    "D:\\Py\\python.exe",
    "C:\\Users\\jon\\AppData\\Local\\Programs\\Python\\Python313\\python.exe",
    "C:\\Users\\jon\\AppData\\Local\\Programs\\Python\\Python311\\python.exe",
  ]);
});

test("Python: an unreadable LOCALAPPDATA just skips those locations", async () => {
  const host = new FakeHost();
  script(host);
  assert.deepEqual(await findCandidates(host, "python"), []);
});

test("Autocue Studio and Stem Remixer folders are found by name where app.py is", async () => {
  const host = new FakeHost();
  put(host, "C:\\Users\\jon\\Autocue Studio\\app.py");
  put(host, "D:\\Apps\\autocue-studio\\app.py");
  put(host, "D:\\Stem Remixer\\app.py");
  put(host, "D:\\Apps\\stem_remixer\\app.py");
  put(host, "D:\\Apps\\other\\app.py");
  host.dirs.add("D:\\Autocue empty");
  script(host, { env: { "%USERPROFILE%": "C:\\Users\\jon" } });
  assert.deepEqual((await findCandidates(host, "autocue")).sort(), ["C:\\Users\\jon\\Autocue Studio", "D:\\Apps\\autocue-studio"]);
  assert.deepEqual((await findCandidates(host, "stemremixer")).sort(), ["D:\\Apps\\stem_remixer", "D:\\Stem Remixer"]);
});

test("checkChoice runs the program check for programs and says why it fails", async () => {
  const host = new FakeHost();
  script(host, { version: { "C:\\b\\blender.exe": "Blender 5.2.0\nmore", "C:\\f\\ffmpeg.exe": "ffmpeg version 7" } });
  assert.deepEqual(await checkChoice(host, "blender", "C:\\b\\blender.exe"), { ok: true, detail: "Blender 5.2.0" });
  assert.deepEqual(await checkChoice(host, "ffmpeg", "C:\\f\\ffmpeg.exe"), { ok: true, detail: "ffmpeg version 7" });
  const bad = await checkChoice(host, "python", "C:\\nope\\python.exe");
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /ENOENT/);
});

test("checkChoice for folders: app.py for Autocue, the full check for Stem Remixer", async () => {
  const host = new FakeHost();
  put(host, "D:\\Autocue\\app.py");
  host.dirs.add("D:\\Empty");
  assert.equal((await checkChoice(host, "autocue", "D:\\Autocue")).ok, true);
  const no = await checkChoice(host, "autocue", "D:\\Empty");
  assert.equal(no.ok, false);
  assert.match(no.detail, /app\.py/);
  const stem = await checkChoice(host, "stemremixer", "D:\\Empty");
  assert.equal(stem.ok, false);
  assert.match(stem.detail, /Python/);
  put(host, "D:\\Stem\\.venv\\Scripts\\python.exe");
  put(host, "D:\\Stem\\fit.py");
  put(host, "D:\\Stem\\measure.py");
  put(host, "D:\\Stem\\VERSION");
  host.files.set("D:\\Stem\\VERSION", "1.9.2\n");
  assert.deepEqual(await checkChoice(host, "stemremixer", "D:\\Stem"), { ok: true, detail: "Stem Remixer 1.9.2" });
});
