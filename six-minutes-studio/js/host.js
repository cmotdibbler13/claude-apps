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
    exec: (cmd, opts = {}) => {
      const o = {};
      if (opts.cwd) o.cwd = opts.cwd;
      if (opts.timeout) o.timeout = opts.timeout;
      return childProcess.exec(cmd, o);
    },
    spawn(cmd, args = [], opts = {}) {
      const p = childProcess.spawn(cmd, args, opts.cwd ? { cwd: opts.cwd } : undefined);
      return {
        onOut: (f) => p.stdout.on("data", f),
        onErr: (f) => {
          p.stderr.on("data", f);
          p.on("error", (e) => f(String(e?.message ?? e)));
        },
        onExit: (f) => p.on("exit", (code) => f(code)),
        kill: () => p.kill(),
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
    now: () => Date.now(),
  };
}
