// Probe view: checks the PC and connectors. Never calls a generate tool.
const ROOT = "S:\\Youtube video ideas\\";
const UNC = "\\\\192.168.1.171\\jon\\Youtube video ideas\\";

const listCheck = (path) => async (host) => {
  const entries = await host.fs.list(path);
  return `${entries.length} entries`;
};
const cmdCheck = (cmd) => async (host) => {
  const r = await host.exec(cmd, { timeout: 15000 });
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${(r.stderr || r.stdout).trim()}`);
  return (r.stdout || r.stderr).trim().split(/\r?\n/)[0];
};

export const CHECKS = [
  { name: "S: root readable", run: listCheck(ROOT) },
  { name: "UNC root readable", run: listCheck(UNC) },
  { name: "Blender", run: cmdCheck("blender --version") },
  { name: "ffmpeg", run: cmdCheck("ffmpeg -version") },
  { name: "Python", run: cmdCheck("python --version") },
  {
    name: "Higgsfield tools",
    async run(host) {
      if (!host.mcp) throw new Error("connector access is not available");
      const tools = await host.mcp.listTools("Higgsfield");
      const want = ["generate_video", "generate_image", "jobs_wait", "models_explore"];
      const missing = want.filter((t) => !tools.includes(t));
      if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
      return `${tools.length} tools`;
    },
  },
  {
    name: "Claude answers JSON",
    async run(host) {
      if (!host.claude) throw new Error("Claude access is not available");
      const r = await host.claude.json('Reply with exactly this JSON and nothing else: {"ok":true}', { tier: "quick" });
      if (r?.ok !== true) throw new Error(`unexpected answer: ${JSON.stringify(r)}`);
      return "ok";
    },
  },
];

export async function runChecks(host, onResult = () => {}) {
  const out = [];
  for (const c of CHECKS) {
    let r;
    try { r = { name: c.name, ok: true, detail: await c.run(host) }; }
    catch (e) { r = { name: c.name, ok: false, detail: String(e?.message ?? e) }; }
    out.push(r);
    onResult(r);
  }
  return out;
}

function row(r) {
  const li = document.createElement("li");
  li.className = r.ok ? "pass" : "fail";
  const st = document.createElement("span"); st.className = "st"; st.textContent = r.ok ? "Pass" : "Fail";
  const nm = document.createElement("span"); nm.textContent = r.name;
  const d = document.createElement("span"); d.className = "detail"; d.textContent = r.detail;
  li.append(st, nm, d);
  return li;
}

export function mountProbe(host, button, list) {
  button.onclick = async () => {
    button.disabled = true;
    list.replaceChildren();
    await runChecks(host, (r) => list.append(row(r)));
    button.disabled = false;
  };
}
