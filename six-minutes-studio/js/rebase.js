// Path re-basing: a project saved on another computer (S:\... on the desktop) is read from this
// computer's project folder (N:\... on the laptop). Whole-string paths only; paths embedded in
// filter strings or key=value arguments are left alone.
const slashes = (p) => String(p).replace(/\//g, "\\");

export function rebasePath(p, spellings, root) {
  if (typeof p !== "string" || !root) return p;
  const s = slashes(p);
  const low = s.toLowerCase();
  for (const sp of spellings ?? []) {
    const spl = slashes(sp).replace(/\\+$/, "").toLowerCase();
    if (!spl || !low.startsWith(spl)) continue;
    const rest = s.slice(spl.length);
    if (rest !== "" && rest[0] !== "\\") continue;
    return root.replace(/[\\/]+$/, "") + rest;
  }
  return p;
}

// Returns a new host. Every path-taking method rebases its string path arguments; the rest
// (platform, mcp, claude, notify, now ...) is passed through untouched.
export function withRebase(host, spellings, root) {
  const rb = (p) => rebasePath(p, spellings, root);
  const wrap = (fn, thisArg, map) => (...a) => fn.apply(thisArg, map(a));
  const fs = { ...host.fs };
  for (const k of ["read", "write", "append", "exists", "list", "stat", "mkdir", "trash"]) {
    if (typeof host.fs?.[k] === "function") fs[k] = wrap(host.fs[k], host.fs, ([p, ...r]) => [rb(p), ...r]);
  }
  if (typeof host.fs?.rename === "function") fs.rename = wrap(host.fs.rename, host.fs, ([a, b, ...r]) => [rb(a), rb(b), ...r]);
  if (typeof host.fs?.copy === "function") fs.copy = wrap(host.fs.copy, host.fs, ([a, b, ...r]) => [rb(a), rb(b), ...r]);
  const out = Object.create(host);
  Object.assign(out, host, { fs });
  if (typeof host.open === "function") out.open = wrap(host.open, host, ([p, ...r]) => [rb(p), ...r]);
  if (typeof host.exec === "function") out.exec = wrap(host.exec, host, ([c, ...r]) => [rb(c), ...r]);
  if (typeof host.spawn === "function") {
    out.spawn = wrap(host.spawn, host, ([c, args, ...r]) => [rb(c), Array.isArray(args) ? args.map(rb) : args, ...r]);
  }
  if (host.shell && typeof host.shell.open === "function") {
    out.shell = { ...host.shell, open: wrap(host.shell.open, host.shell, ([p, ...r]) => [rb(p), ...r]) };
  }
  return out;
}
