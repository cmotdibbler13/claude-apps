// Run a program with an argument list (no shell, so paths with & % ! ^ $ ` are safe), collect its
// output and wait for it to exit. With a timeout, the program is killed and the call rejects.
const KEEP = 64 * 1024; // keep the last 64 KB of each stream

export function runProcess(host, cmd, args = [], { timeout } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "", done = false, timer = null;
    const finish = (fn) => { if (done) return; done = true; if (timer) clearTimeout(timer); fn(); };
    const p = host.spawn(cmd, args);
    p.onOut((c) => { stdout = (stdout + String(c)).slice(-KEEP); });
    p.onErr((c) => { stderr = (stderr + String(c)).slice(-KEEP); });
    p.onExit((code) => finish(() => {
      if (code === null || code === undefined) {
        const why = stderr.trim().split(/\r?\n/).slice(-3).join("\n");
        reject(new Error(`${cmd} didn't start or was stopped${why ? `: ${why}` : ""}`));
      } else resolve({ code, stdout, stderr });
    }));
    if (timeout) {
      timer = setTimeout(() => finish(() => {
        try { Promise.resolve(p.kill()).catch(() => {}); } catch { /* already gone */ }
        reject(new Error(`${cmd} timed out after ${Math.round(timeout / 60000) || "<1"} min`));
      }), timeout);
    }
  });
}

// Run a program that prints one JSON object per line on stdout: {"progress":0..1,"text"} while running,
// then {"done":true,...} or {"error":"..."}. Resolves with the done object. Other lines (library warnings)
// are ignored, but the last five are kept for the error when the program stops without saying why.
const TAIL_LINES = 5;
const GRACE_MS = 100; // stdout can still be draining when the exit arrives

export function runJsonLines(host, cmd, args = [], { cwd, name = cmd, onProgress, timeout } = {}) {
  return new Promise((resolve, reject) => {
    const tail = [];
    const partial = { out: "", err: "" };
    let final = null, error = null, settled = false, timer = null;
    const keep = (l) => { tail.push(l); if (tail.length > TAIL_LINES) tail.shift(); };
    const line = (raw, json) => {
      const l = raw.trim();
      if (!l) return;
      let v = null;
      if (json && l.startsWith("{")) { try { v = JSON.parse(l); } catch { /* not JSON */ } }
      if (!v || typeof v !== "object" || Array.isArray(v)) return keep(l);
      if (v.error != null) error = String(v.error);
      else if (v.done === true) final = v;
      else if (typeof v.progress === "number" && Number.isFinite(v.progress)) {
        try { onProgress?.(Math.min(1, Math.max(0, v.progress)), typeof v.text === "string" ? v.text : null); } catch { /* reporting must not stop the run */ }
      } else keep(l);
    };
    const feed = (which, chunk) => {
      const lines = (partial[which] + String(chunk)).split(/\r?\n|\r/);
      partial[which] = lines.pop();
      for (const l of lines) line(l, which === "out");
    };
    const flush = () => {
      for (const which of ["out", "err"]) { if (partial[which]) { line(partial[which], which === "out"); partial[which] = ""; } }
    };
    const why = () => (tail.length ? `:\n${tail.join("\n")}` : "");
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      flush();
      if (error != null) return reject(new Error(error));
      if (code === null || code === undefined) return reject(new Error(`${name} didn't start or was stopped${why()}`));
      if (code !== 0) return reject(new Error(`${name} stopped with exit code ${code}${why()}`));
      if (!final) return reject(new Error(`${name} finished without a result${why()}`));
      resolve(final);
    };
    const p = host.spawn(cmd, args, cwd ? { cwd } : {});
    p.onOut((c) => feed("out", c));
    p.onErr((c) => feed("err", c));
    p.onExit((code) => {
      if (final || error != null) finish(code);
      else setTimeout(() => finish(code), GRACE_MS);
    });
    if (timeout) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { Promise.resolve(p.kill()).catch(() => {}); } catch { /* already gone */ }
        reject(new Error(`${name} timed out after ${Math.round(timeout / 60000) || "<1"} min`));
      }, timeout);
    }
  });
}


// Closes a process Studio started and everything it started (ComfyUI Desktop's Python server, Pinokio's app):
// taskkill /T asks the tree to close, /F forces it if that fails. Without a pid, the process alone.
export async function killTree(host, p) {
  if (!p) return;
  const pid = p.pid;
  if (pid != null) {
    try {
      const r = await runProcess(host, "taskkill", ["/PID", String(pid), "/T"], { timeout: 10000 });
      if (r.code !== 0) await runProcess(host, "taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 10000 });
    } catch { /* taskkill missing or timed out: fall back below */ }
  }
  try { await p.kill(); } catch { /* already gone */ }
}
