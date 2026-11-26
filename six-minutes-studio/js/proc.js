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
