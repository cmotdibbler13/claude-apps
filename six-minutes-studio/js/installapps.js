// Installs Jon's own apps (Autocue Studio, Stem Remixer) from the public repo into a folder he chooses.
// Nothing is ever put into an existing non-empty folder; Studio's own temporary folder is the only thing removed.
import { runProcess } from "./proc.js";
import { join } from "./paths.js";
import { GET_IT } from "./findtools.js";
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

export async function installApp(host, { app, parent, python, root, computer, now = host.now?.() ?? Date.now(), onStep = () => {} } = {}) {
  const a = APPS[app];
  if (!a) throw new Error(`Unknown app: ${app}.`);
  const say = (t) => { try { onStep(t); } catch { /* reporting must not stop the install */ } };
  const target = join(parent, a.name);

  let entries = [];
  if (await host.fs.exists(target)) {
    try { entries = await host.fs.list(target); } catch { entries = [{ name: "?" }]; }
    if (entries.length) throw new Error(`${target} already has files in it. Choose another folder.`);
  }
  if (app === "autocue") {
    let ok = false;
    try { ok = !!python && (await runProcess(host, python, ["--version"], { timeout: MIN })).code === 0; } catch { /* no Python */ }
    if (!ok) throw new Error("Set up Python first.");
  }

  const tmp = join(parent, `.sms-install-${now}`);
  let renamed = false;
  let leftover = false;
  try {
    await host.fs.mkdir(parent);
    await host.fs.mkdir(tmp);
    say("Downloading…");
    await step(host, "The download", "curl", ["-L", "-f", "-o", join(tmp, "repo.zip"), ZIP_URL], 10 * MIN);
    say("Unpacking…");
    await step(host, "Unpacking the download", "tar", ["-xf", join(tmp, "repo.zip"), "-C", tmp], 5 * MIN);
    const src = join(tmp, "claude-apps-main", a.folder);
    if (!(await host.fs.exists(src))) throw new Error(`The download didn't contain ${a.folder}.`);
    if (entries.length === 0 && (await host.fs.exists(target))) await host.fs.trash?.(target);
    await host.fs.rename(src, target);
    renamed = true;

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
      throw new Error(`${a.name} was unpacked into ${target}, but ${String(e?.message ?? e).replace(/^./, (c) => c.toLowerCase())}`);
    }
    return { dir: target };
  } finally {
    try { await host.fs.trash(tmp); }
    catch { leftover = true; }
    if (leftover) say(`Studio couldn't remove its temporary folder ${tmp}. It is safe to delete.`);
    if (!leftover && renamed) say("Done");
  }
}
