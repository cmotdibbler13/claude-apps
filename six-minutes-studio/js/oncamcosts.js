// Costs for the On camera step, asked of Higgsfield (free): the portrait's for the saved look, a clip's per
// padded length. One cache per open review: reset() when a review opens, so a "(cost unknown)" or an old price
// never sticks. A look change (new prompt) asks the portrait cost again; forgetClips() after a portrait approval.
import { portraitPrompt, portraitParams, clipParams, clipPrompt, clipSeconds, lineLengthS } from "./presenter.js";

// estimate(tool, input) -> Promise<number|null> (hfmedia.estimateCredits bound to the host).
export function makeCosts(estimate) {
  const fresh = () => ({ portraitFor: null, portrait: undefined, clips: new Map() });
  let e = fresh();
  return {
    reset() { e = fresh(); },
    forgetClips() { e.clips = new Map(); },
    // { portrait: credits|null|undefined (being asked), clips: { [seconds]: credits|null } } (absent while asked)
    view() {
      return { portrait: e.portrait, clips: Object.fromEntries([...e.clips].filter(([, v]) => v !== undefined)) };
    },
    ask({ state, transcript }, onChange) {
      if (!state?.presenter?.lines?.length) return;
      const cur = e;
      const look = state.presenter.look;
      if (look?.outfit && look?.set) {
        const prompt = portraitPrompt(look);
        if (cur.portraitFor !== prompt) {
          cur.portraitFor = prompt; cur.portrait = undefined;
          Promise.resolve(estimate("estimate_image_cost", { params: portraitParams(prompt) })).catch(() => null)
            .then((v) => { if (e === cur && cur.portraitFor === prompt) { cur.portrait = v; onChange(); } });
        }
      }
      for (const a of state.assets ?? []) {
        if (a.kind !== "presenter") continue;
        const len = lineLengthS(transcript, a.lineId);
        if (len == null) continue;
        const secs = clipSeconds(len);
        if (cur.clips.has(secs)) continue;
        const gen = cur.clips;
        gen.set(secs, undefined);
        Promise.resolve(estimate("estimate_video_cost", { params: clipParams({ seconds: secs, prompt: clipPrompt() }) })).catch(() => null)
          .then((v) => { if (e === cur && cur.clips === gen) { gen.set(secs, v); onChange(); } });
      }
    },
  };
}
