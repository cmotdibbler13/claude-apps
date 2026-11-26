// In-memory Host for tests: fs plus scripted exec/spawn/mcp/claude.
const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const err = (code, p) => new Error(`${code}: no such file or directory, '${p}'`);

export class FakeHost {
  constructor({ mcp = true, claude = true } = {}) {
    this.platform = "win32";
    this.files = new Map();
    this.dirs = new Set();
    this.notified = [];
    this.trays = [];
    this.t = 1_700_000_000_000;
    this._exec = () => ({ stdout: "", stderr: "", code: 0 });
    this._spawn = () => {};
    this._mcp = () => undefined;
    this._claude = () => undefined;
    this.mcpTools = {};
    const fs = {
      read: async (p, enc) => {
        const k = this._key(p);
        if (!this.files.has(k)) throw err("ENOENT", p);
        const v = this.files.get(k);
        if (enc) return typeof v === "string" ? v : new TextDecoder().decode(v);
        return typeof v === "string" ? new TextEncoder().encode(v) : v;
      },
      write: async (p, data) => { this.files.set(this._key(p), data); },
      append: async (p, s) => {
        const k = this._key(p);
        const cur = this.files.get(k) ?? "";
        this.files.set(k, (typeof cur === "string" ? cur : new TextDecoder().decode(cur)) + s);
      },
      exists: async (p) => this._isFile(p) || this._isDir(p),
      list: async (p) => {
        if (!this._isDir(p)) throw err("ENOENT", p);
        const base = norm(p), out = new Map();
        for (const k of [...this.files.keys(), ...this.dirs]) {
          const n = norm(k);
          if (!n.startsWith(base + "/")) continue;
          const rest = k.replace(/\\/g, "/").slice(base.length + 1);
          const [name, ...more] = rest.split("/");
          if (!out.has(name.toLowerCase())) {
            out.set(name.toLowerCase(), { name, isFile: !more.length && this.files.has(k), isDirectory: more.length > 0 || !this.files.has(k), isSymbolicLink: false });
          }
        }
        return [...out.values()];
      },
      stat: async (p) => {
        if (this._isFile(p)) { const v = this.files.get(this._key(p)); return { size: v.length, isFile: true, isDirectory: false, mtimeMs: this.t }; }
        if (this._isDir(p)) return { size: 0, isFile: false, isDirectory: true, mtimeMs: this.t };
        throw err("ENOENT", p);
      },
      mkdir: async (p) => { this.dirs.add(p); },
      rename: async (a, b) => {
        const ka = this._key(a);
        if (this.files.has(ka)) { const v = this.files.get(ka); this.files.delete(ka); this.files.set(this._key(b), v); return; }
        if (!this._isDir(a)) throw err("ENOENT", a);
        const base = norm(a);
        for (const k of [...this.files.keys()]) {
          if (norm(k).startsWith(base + "/")) { const v = this.files.get(k); this.files.delete(k); this.files.set(b + k.slice(a.length), v); }
        }
      },
      trash: async (p) => {
        const base = norm(p);
        for (const k of [...this.files.keys()]) if (norm(k) === base || norm(k).startsWith(base + "/")) this.files.delete(k);
        for (const d of [...this.dirs]) if (norm(d) === base || norm(d).startsWith(base + "/")) this.dirs.delete(d);
      },
    };
    this.fs = fs;
    this.mcp = mcp ? {
      call: async (s, t, i) => this._mcp(s, t, i),
      listTools: async (s) => this.mcpTools[s] ?? [],
    } : null;
    this.claude = claude ? {
      json: async (input, opts = {}) => this._claude("json", input, opts),
      text: async (input, opts = {}) => this._claude("text", input, opts),
    } : null;
  }
  _key(p) {
    const n = norm(p);
    for (const k of this.files.keys()) if (norm(k) === n) return k;
    return p;
  }
  _isFile(p) { return this.files.has(this._key(p)); }
  _isDir(p) {
    const n = norm(p);
    if (!n) return false;
    for (const d of this.dirs) if (norm(d) === n || norm(d).startsWith(n + "/")) return true;
    for (const k of this.files.keys()) if (norm(k).startsWith(n + "/")) return true;
    return false;
  }
  execScript(fn) { this._exec = fn; }
  spawnScript(fn) { this._spawn = fn; }
  mcpScript(fn) { this._mcp = fn; }
  claudeScript(fn) { this._claude = fn; }
  async exec(cmd, opts = {}) { return this._exec(cmd, opts); }
  spawn(cmd, args = [], opts = {}) {
    const h = { out: [], err: [], exit: [] };
    let done = false;
    const emit = (list, v) => h[list].forEach((f) => f(v));
    const ctl = {
      out: (s) => emit("out", s),
      err: (s) => emit("err", s),
      exit: (c) => { if (!done) { done = true; emit("exit", c); } },
    };
    const proc = {
      onOut: (f) => h.out.push(f),
      onErr: (f) => h.err.push(f),
      onExit: (f) => h.exit.push(f),
      kill: () => ctl.exit(null),
    };
    Promise.resolve().then(() => this._spawn(cmd, args, opts, ctl));
    return proc;
  }
  async notify(body) { this.notified.push(body); }
  async tray(opts) { this.trays.push(opts); }
  now() { return this.t; }
}
