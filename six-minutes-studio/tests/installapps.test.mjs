import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { APPS, installApp } from "../js/installapps.js";

const ROOT = "S:\\Youtube video ideas";
const PARENT = "D:\\Apps";
const setup = ({ curl = 0, pip = 0, ps = 0, py = 0, noFolder = false } = {}) => {
  const host = new FakeHost();
  host.dirs.add(ROOT); host.dirs.add("D:");
  const seen = [];
  host.spawnScript((cmd, args, o, p) => {
    seen.push([cmd, ...args]);
    if (cmd === "curl") { if (curl) p.err("curl: (22) The requested URL returned error: 404"); p.exit(curl); }
    else if (cmd === "tar") {
      if (!noFolder) {
        const tmp = args[args.indexOf("-C") + 1];
        for (const f of ["autocue-studio", "stem-remixer"]) { host.dirs.add(`${tmp}\\claude-apps-main\\${f}`); host.files.set(`${tmp}\\claude-apps-main\\${f}\\app.py`, "x"); }
      }
      p.exit(0);
    } else if (args.includes("--version")) p.exit(py);
    else if (args.includes("pip")) p.exit(pip);
    else if (cmd === "powershell") p.exit(ps);
    else p.exit(0);
  });
  return { host, seen };
};
const opts = (host, extra = {}) => ({ app: "autocue", parent: PARENT, python: "python", root: ROOT, computer: "LAPTOP", now: host.t, ...extra });
const noTmp = (host) => ![...host.dirs, ...host.files.keys()].some((k) => k.includes(".sms-install-"));

test("APPS names the two apps", () => {
  assert.equal(APPS.autocue.folder, "autocue-studio");
  assert.equal(APPS.stemremixer.name, "Stem Remixer");
});

test("installs Autocue Studio and saves the settings", async () => {
  const { host, seen } = setup();
  const steps = [];
  const r = await installApp(host, opts(host, { onStep: (t) => steps.push(t) }));
  assert.equal(r.dir, "D:\\Apps\\Autocue Studio");
  assert.ok(host.files.has("D:\\Apps\\Autocue Studio\\app.py"));
  assert.ok(host.files.has("D:\\Apps\\Autocue Studio\\voiceover_join.py"));
  assert.ok(seen.some((c) => c[0] === "curl" && c.includes("-f") && c.includes("https://codeload.github.com/cmotdibbler13/claude-apps/zip/refs/heads/main")));
  assert.ok(seen.some((c) => c.includes("pip") && c.includes("D:\\Apps\\Autocue Studio\\requirements.txt")));
  const s = JSON.parse(host.files.get(`${ROOT}\\.studio-settings.json`)).computers.LAPTOP;
  assert.deepEqual(s, { autocueDir: r.dir, autocueRecordings: `${r.dir}\\Recordings`, autocuePython: "python" });
  assert.ok(noTmp(host));
  assert.deepEqual(steps, ["Downloading…", "Unpacking…", "Installing…", "Done"]);
});

test("unpacks only the app's folder and doesn't restore file times (Windows tar refuses some)", async () => {
  const { host, seen } = setup();
  await installApp(host, opts(host));
  const tar = seen.find((c) => c[0] === "tar");
  assert.ok(tar.includes("-m"), "no -m");
  assert.equal(tar[tar.length - 1], "claude-apps-main/autocue-studio");
  const { host: h2, seen: s2 } = setup();
  await installApp(h2, opts(h2, { app: "stemremixer" }));
  assert.equal(s2.find((c) => c[0] === "tar").at(-1), "claude-apps-main/stem-remixer");
});

test("installs Stem Remixer through its PowerShell script", async () => {
  const { host, seen } = setup();
  const r = await installApp(host, opts(host, { app: "stemremixer", python: undefined }));
  assert.equal(r.dir, "D:\\Apps\\Stem Remixer");
  assert.ok(seen.some((c) => c[0] === "powershell" && c.includes("-File") && c.includes("D:\\Apps\\Stem Remixer\\Install.ps1")));
  assert.equal(JSON.parse(host.files.get(`${ROOT}\\.studio-settings.json`)).computers.LAPTOP.stemRemixerDir, r.dir);
});

test("a failed download leaves no folder and removes the temporary one", async () => {
  const { host } = setup({ curl: 22 });
  await assert.rejects(installApp(host, opts(host)), /download failed.*22/is);
  assert.ok(!(await host.fs.exists("D:\\Apps\\Autocue Studio")));
  assert.ok(noTmp(host));
});

test("a zip without the app folder fails before any rename", async () => {
  const { host } = setup({ noFolder: true });
  await assert.rejects(installApp(host, opts(host)), /didn't contain autocue-studio/);
  assert.ok(!(await host.fs.exists("D:\\Apps\\Autocue Studio")));
  assert.ok(noTmp(host));
});

test("a non-empty target is refused before any download", async () => {
  const { host, seen } = setup();
  host.dirs.add("D:\\Apps\\Autocue Studio"); host.files.set("D:\\Apps\\Autocue Studio\\mine.txt", "x");
  await assert.rejects(installApp(host, opts(host)), /already has files in it\. Choose another folder\./);
  assert.equal(seen.length, 0);
});

test("no Python refuses Autocue Studio before downloading", async () => {
  const { host, seen } = setup({ py: 1 });
  await assert.rejects(installApp(host, opts(host)), /Set up Python first\./);
  assert.ok(!seen.some((c) => c[0] === "curl"));
});

test("a failure after the rename keeps the folder and names the step", async () => {
  const { host } = setup({ pip: 1 });
  const steps = [];
  await assert.rejects(installApp(host, opts(host, { onStep: (t) => steps.push(t) })), /unpacked into D:\\Apps\\Autocue Studio.*requirements/is);
  assert.ok(!steps.includes("Done"));
  assert.ok(host.files.has("D:\\Apps\\Autocue Studio\\app.py"));
  assert.ok(noTmp(host));
});

test("a temporary folder that can't be removed is mentioned, not fatal", async () => {
  const { host } = setup();
  host.fs.trash = async () => { throw new Error("busy"); };
  const steps = [];
  await installApp(host, opts(host, { onStep: (t) => steps.push(t) }));
  assert.ok(steps.some((t) => /temporary folder/.test(t)));
  assert.equal(steps.at(-1), "Done");
});

test("an existing empty target is replaced by the app", async () => {
  const { host } = setup();
  host.dirs.add("D:\\Apps\\Autocue Studio");
  await installApp(host, opts(host));
  assert.ok(host.files.has("D:\\Apps\\Autocue Studio\\app.py"));
});

test("a target that gains a file during the download is left alone", async () => {
  const { host } = setup();
  host.dirs.add("D:\\Apps\\Autocue Studio");
  const inner = host._spawn;
  host.spawnScript((cmd, args, o, p) => {
    if (cmd === "tar") host.files.set("D:\\Apps\\Autocue Studio\\mine.txt", "x");
    inner(cmd, args, o, p);
  });
  await assert.rejects(installApp(host, opts(host)), /already has files in it/);
  assert.ok(host.files.has("D:\\Apps\\Autocue Studio\\mine.txt"));
  assert.ok(!host.files.has("D:\\Apps\\Autocue Studio\\app.py"));
  assert.ok(noTmp(host));
});
