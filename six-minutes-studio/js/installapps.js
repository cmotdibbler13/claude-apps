// Installs Jon's own apps (Autocue Studio, Stem Remixer) from the public repo into a folder he chooses.
// Nothing is ever put into an existing non-empty folder; Studio's own temporary folder is the only thing removed.
import { runProcess } from "./proc.js";
import { join } from "./paths.js";
import { GET_IT, findCandidates } from "./findtools.js";
import { installAutocueJoin } from "./autocueinstall.js";
import { saveComputerSettings } from "./computer.js";

export const APPS = {
  autocue: { folder: "autocue-studio", name: "Autocue Studio" },
  stemremixer: { folder: "stem-remixer", name: "Stem Remixer" },
};

const MIN = 60000;
const ZIP_URL = `${GET_IT.repo.replace("https://github.com/", "https://codeload.github.com/")}/zip/refs/heads/main`;

async function step(host, what, cmd, args, timeout) {
  let r;
  try { r = await runProcess(host, cmd, args, { timeout }); }
  catch (e) { throw new Error(`${what} failed: ${e?.message ?? e}`); }
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join("\n");
    throw new Error(`${what} failed (exit code ${r.code})${why ? `:\n${why}` : ""}`);
  }
}

// Autocue Studio's speech checker (faster-whisper) needs onnxruntime, which only exists for 64-bit
// x86 Python 3.9 to 3.14 on Windows (not 3.15 yet, not 32-bit, not ARM).
const PY_INFO = ["-c", "import sys,struct,platform;print(sys.version_info[0],sys.version_info[1],struct.calcsize('P')*8,platform.machine())"];

// {major, minor, bits, machine}, or null when it doesn't run.
export async function pythonInfo(host, python) {
  if (!python) return null;
  let r;
  try { r = await runProcess(host, python, PY_INFO, { timeout: MIN }); } catch { return null; }
  if (r.code !== 0) return null;
  const m = /(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(String(r.stdout ?? ""));
  return m ? { major: +m[1], minor: +m[2], bits: +m[3], machine: m[4] } : null;
}

const pyOk = (i) => !!i && i.major === 3 && i.minor >= 9 && i.minor <= 14 && i.bits === 64 && /^(amd64|x86_64)$/i.test(i.machine);
const pyName = (i) => `Python ${i.major}.${i.minor} (${i.bits}-bit${/^(amd64|x86_64)$/i.test(i.machine) ? "" : `, ${i.machine}`})`;

// Left in the app's folder from the moment it is unpacked until its install finishes, so a failed install
// can be finished later instead of refused (the folder is no longer empty).
export const UNFINISHED = ".studio-install-unfinished.json";

// The app's folder under `parent` when an earlier install of this app into it didn't finish, else null.
export async function unfinishedInstall(host, parent, app) {
  const a = APPS[app];
  if (!a || !parent) return null;
  const target = join(parent, a.name);
  try {
    const mark = JSON.parse(await host.fs.read(join(target, UNFINISHED), "utf8"));
    return mark?.app === app ? target : null;
  } catch { return null; }
}

export async function installApp(host, { app, parent, python: givenPython, root, computer, now = host.now?.() ?? Date.now(), onStep = () => {} } = {}) {
  const a = APPS[app];
  if (!a) throw new Error(`Unknown app: ${app}.`);
  const say = (t) => { try { onStep(t); } catch { /* reporting must not stop the install */ } };
  const target = join(parent, a.name);

  let entries = [];
  let finishing = false;
  if (await host.fs.exists(target)) {
    try { entries = await host.fs.list(target); } catch { entries = [{ name: "?" }]; }
    if (entries.length) {
      if ((await unfinishedInstall(host, parent, app)) === target) finishing = true;
      else throw new Error(`${target} already has files in it. Choose another folder.`);
    }
  }
  let python = givenPython;
  if (app === "autocue") {
    const info = await pythonInfo(host, python);
    if (!info) throw new Error("Set up Python first.");
    if (!pyOk(info)) {
      // Another Python on this computer may do: use the first suitable one.
      let other = null;
      for (const c of await findCandidates(host, "python").catch(() => [])) {
        if (String(c).toLowerCase() === String(python).toLowerCase()) continue;
        const i = await pythonInfo(host, c);
        if (pyOk(i)) { other = { path: c, info: i }; break; }
      }
      if (!other) throw new Error(`Autocue Studio needs 64-bit Python 3.9 to 3.14 for its speech checker; ${python} is ${pyName(info)}. Install Python 3.13 (Windows installer, 64-bit) from Get it, then press Install again.`);
      python = other.path;
      say(`Using ${python} (Python ${other.info.major}.${other.info.minor}) for Autocue Studio: ${givenPython} is ${pyName(info)}.`);
    }
  }

  const tmp = join(parent, `.sms-install-${now}`);
  let ok = false;
  let leftover = false;
  let madeTmp = false;
  const mark = join(target, UNFINISHED);
  try {
    if (finishing) say("Finishing the earlier install…");
    else {
      await host.fs.mkdir(parent);
      await host.fs.mkdir(tmp);
      madeTmp = true;
      say("Downloading…");
      await step(host, "The download", "curl", ["-L", "-f", "-o", join(tmp, "repo.zip"), ZIP_URL], 10 * MIN);
      say("Unpacking…");
      // Only this app's folder, and -m: Windows tar stops with "Can't restore time" on some files in the zip.
      await step(host, "Unpacking the download", "tar", ["-x", "-m", "-f", join(tmp, "repo.zip"), "-C", tmp, `claude-apps-main/${a.folder}`], 5 * MIN);
      const src = join(tmp, "claude-apps-main", a.folder);
      if (!(await host.fs.exists(src))) throw new Error(`The download didn't contain ${a.folder}.`);
      if (await host.fs.exists(target)) {
        // The folder was empty before the download; check again, since the download can take a while.
        let now2;
        try { now2 = await host.fs.list(target); } catch { now2 = [{ name: "?" }]; }
        if (now2.length) throw new Error(`${target} already has files in it. Choose another folder.`);
        if (typeof host.fs.trash !== "function") throw new Error(`${target} already exists and Studio can't clear it. Choose another folder.`);
        await host.fs.trash(target);
      }
      await host.fs.rename(src, target);
      await host.fs.write(mark, JSON.stringify({ app, at: now }));
    }

    try {
      if (app === "autocue") {
        say("Installing…");
        await step(host, "Installing Autocue Studio's requirements", python, ["-m", "pip", "install", "-r", join(target, "requirements.txt")], 15 * MIN);
        await installAutocueJoin(host, target);
        await saveComputerSettings(host, root, computer, { autocueDir: target, autocueRecordings: join(target, "Recordings"), autocuePython: python }, { now });
      } else {
        say("Installing… (this can take a long while)");
        await step(host, "Installing Stem Remixer", "powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(target, "Install.ps1")], 60 * MIN);
        await saveComputerSettings(host, root, computer, { stemRemixerDir: target }, { now });
      }
    } catch (e) {
      throw new Error(`${a.name} was unpacked into ${target}, but ${String(e?.message ?? e).replace(/^./, (c) => c.toLowerCase())}\nPress Install again to finish it.`);
    }
    try { if (await host.fs.exists(mark)) await host.fs.trash(mark); } catch { /* a leftover mark only offers Finish again */ }
    ok = true;
    return { dir: target };
  } finally {
    if (madeTmp) {
      try { await host.fs.trash(tmp); }
      catch { leftover = true; }
    }
    if (leftover) say(`Studio couldn't remove its temporary folder ${tmp}. It is safe to delete.`);
    if (ok) say("Done");
  }
}
