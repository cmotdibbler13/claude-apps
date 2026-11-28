// What this computer says about itself in its presence file, worked out from its job list. No DOM, no timers.
const gpuBusy = (j) => j.lane === "gpu" && (j.status === "queued" || j.status === "running");
const remoteCount = (jobs, state) => jobs.filter((j) => j.status === "running" && j.remote === state).length;

export function presenceState({ role, jobs, settings, counts, tools }) {
  if (role === "desktop") {
    return { paused: settings?.laptopJobs === "paused", running: jobs.filter(gpuBusy).length, waiting: counts?.waiting ?? 0, tools: tools ?? {} };
  }
  return { paused: false, running: remoteCount(jobs, "running"), waiting: remoteCount(jobs, "waiting"), tools: {} };
}
