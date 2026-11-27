// Approve Part 2: what is still to approve before the handover can be written, and Higgsfield job ids.
import { onCameraConflict } from "./shots.js";
import { mixStale } from "./mixplan.js";

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// { ready, left, warnings }. Only live items count: removed versions and b-roll on to-camera lines don't.
export function part2Readiness(state) {
  const assets = state?.assets ?? [];
  const live = assets.filter((a) => !a.removedAt);
  const shots = live.filter((a) => a.kind !== "presenter" && !onCameraConflict(a, state));
  const clips = live.filter((a) => a.kind === "presenter");
  const left = [];
  const n = shots.filter((a) => !a.approved).length;
  if (n) left.push(plural(n, "shot", "shots"));
  if (clips.length) {
    if (!state?.presenter?.portrait?.approved && !state?.presenter?.portrait?.hfId) left.push("the portrait");
    const c = clips.filter((a) => !a.approved).length;
    if (c) left.push(plural(c, "clip", "clips"));
  }
  if (!state?.audio?.score?.approved) left.push("the score");
  const fx = (state?.audio?.sfx ?? []).filter((x) => !x.approved).length;
  if (fx) left.push(plural(fx, "sound effect", "sound effects"));
  const mix = state?.mix;
  if (mix?.voiceover?.status !== "done") left.push("the voiceover join");
  if (!mix?.mix || mix.mix.status !== "done" || !mix.mix.approved || mixStale(state)) left.push("the mix");

  const warnings = [];
  for (const a of clips) {
    if (!a.approved) continue;
    if (a.voiceoverChanged) warnings.push(`Clip ${a.id} was approved out of step with the current voiceover.`);
    if (a.staleReason) warnings.push(`Clip ${a.id} was approved made with an earlier portrait.`);
  }
  if (mix?.voiceover?.allowFlagged) warnings.push("The voiceover was joined with flagged narration lines.");
  return { ready: left.length === 0, left, warnings };
}

// "3 shots, the score and 2 sound effects still to approve"
export function leftText(left) {
  if (!left?.length) return "";
  const list = left.length === 1 ? left[0] : `${left.slice(0, -1).join(", ")} and ${left[left.length - 1]}`;
  return `${list} still to approve`;
}

// The Higgsfield job id of a take: stored on the take, else the jobRef of its job in .studio-jobs.json.
export function hfJobIdFor(take, jobs) {
  if (take?.hfId) return take.hfId;
  const j = (jobs ?? []).find((x) => x?.id === take?.jobId);
  return j?.jobRef || null;
}
