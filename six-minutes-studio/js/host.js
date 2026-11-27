// Host adapter: the one place that touches claude.use("desktop" | "mcp" | "sample").
// Everything else in the app talks to the Host shape returned here (or FakeHost in tests).

export async function makeHost(claude = globalThis.claude) {
  const desktop = await claude?.use("desktop");
  if (!desktop?.fs) return null;
  const mcp = await claude.use("mcp");
  const sample = await claude.use("sample");
  const { fs, childProcess, shell, os } = desktop;
  const platform = await os.platform();
  const sampleOpts = (o = {}) => (o.tier ? { modelTier: o.tier } : {});

  // Permissions are only asked for on first real use (a click), never at load.
  const allowed = async (name) => {
    try {
      const s = await desktop.permissions.state(name);
      return s !== "denied" && s !== "unavailable";
    } catch { return true; }
  };

  return {
    platform,
    // Read without asking (safe at load); request and manage need a click.
    async permissionState(name) {
      try { return await desktop.permissions.state(name); } catch { return "unavailable"; }
    },
    async requestPermission(name) {
      try { return (await desktop.permissions.request([name]))?.[name] ?? "unavailable"; } catch { return "unavailable"; }
    },
    managePermissions: () => desktop.permissions.manage(),
    fs: {
      read: (p, enc) => (enc ? fs.readFile(p, enc) : fs.readFile(p)),
      write: (p, data, enc) => fs.writeFile(p, data, enc),
      append: (p, s) => fs.appendFile(p, s),
      exists: (p) => fs.exists(p),
      list: (p) => fs.readdir(p),
      stat: (p) => fs.stat(p),
      mkdir: (p) => fs.mkdir(p, { recursive: true }),
      rename: (a, b) => fs.rename(a, b),
      trash: (p) => shell.trashItem(p),
    },
    open: (p) => shell.openPath(p),
    exec: (cmd, opts = {}) => {
      const o = {};
      if (opts.cwd) o.cwd = opts.cwd;
      if (opts.timeout) o.timeout = opts.timeout;
      return childProcess.exec(cmd, o);
    },
    spawn(cmd, args = [], opts = {}) {
      const so = {};
      if (opts.cwd) so.cwd = opts.cwd;
      if (opts.shell === true) so.shell = true; // only for fixed commands such as pterm
      // A detached app (Stem Remixer) gets no pipes, so it keeps running after Studio closes.
      if (opts.detached === true) { so.detached = true; so.stdio = "ignore"; }
      const p = childProcess.spawn(cmd, args, Object.keys(so).length ? so : undefined);
      if (opts.detached === true) { try { p.unref?.(); } catch { /* not supported: still runs */ } }
      // A refused spawn (e.g. Blender not found) arrives as an 'error' event with no 'exit'.
      // Surface the text to onErr and settle onExit once with code null so callers never hang.
      const errFns = [], exitFns = [];
      let errText = null, exited = false, exitCode;
      const settle = (code) => {
        if (exited) return;
        exited = true; exitCode = code;
        exitFns.forEach((f) => f(code));
      };
      p.on("error", (e) => {
        errText = String(e?.message ?? e);
        errFns.forEach((f) => f(errText));
        settle(null);
      });
      p.on("exit", (code) => settle(code));
      return {
        onOut: (f) => p.stdout?.on("data", f),
        onErr: (f) => {
          p.stderr?.on("data", f);
          errFns.push(f);
          if (errText !== null) f(errText);
        },
        onExit: (f) => {
          exitFns.push(f);
          if (exited) f(exitCode);
        },
        kill: async () => { try { await p.kill(); } catch { /* already gone */ } },
        pid: p.pid ?? null, // for closing a whole process tree (taskkill /T)
      };
    },
    mcp: mcp ? {
      async call(server, tool, input) {
        const r = await mcp.callTool(server, tool, input);
        return r && r.payload !== undefined ? r.payload : r;
      },
      async listTools(server) {
        const r = await mcp.listTools(server);
        return (r.servers ?? []).filter((s) => !server || s.server === server).flatMap((s) => s.tools.map((t) => t.name));
      },
    } : null,
    claude: sample ? {
      json: (input, opts) => sample.json(input, sampleOpts(opts)),
      text: async (input, opts) => (await sample(input, sampleOpts(opts))).text,
    } : null,
    async notify(body) {
      if (await allowed("notifications")) await desktop.notification.show({ body });
    },
    async tray(opts) {
      if (await allowed("menu-bar")) await desktop.tray.set(opts);
    },
    async showWindow() { await desktop.window.show(); },
    now: () => Date.now(),
  };
}
