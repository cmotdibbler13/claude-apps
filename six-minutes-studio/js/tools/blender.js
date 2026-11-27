// Blender runner (gpu lane). One take is model, check, render, all inside the job:
// Claude writes a scene script looking at Jon's drawing, Blender renders a check still, Claude compares
// the still with the drawing (fix it or it matches, at most 3 stills), then Blender renders the MP4.
// Claude never chooses a path; the runner passes source, output and still after "--".
import { askJson } from "../claude.js";
import { readImages, canSendImages } from "../images.js";
import { moveAside } from "../paths.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import { SCRIPT_INSTRUCTIONS, CHECK_INSTRUCTIONS, validateScript, validateCheck } from "./blenderprompts.js";

export const NO_PICTURES = "Claude can't see pictures in this view yet. Allow pictures for Six Minutes Studio when it asks, then press Run again.";
export const BLANK_TWICE = "The 3D render came out blank. Redo with a note.";
const ROUNDS = 3;

// Blender 5 only offers 'FFMPEG' once image_settings.media_type is 'VIDEO'. If a script sets the format
// without switching to video first, add the switch just before that line (it is a no-op on Blender 4).
const FFMPEG_LINE = /^([ \t]*)([A-Za-z_][\w.]*)\.file_format\s*=\s*(['"])FFMPEG\3/m;
export function ensureVideoMediaType(script) {
  if (/media_type/.test(script)) return script;
  return script.replace(FFMPEG_LINE, (line, indent, obj) =>
    `${indent}if hasattr(${obj}, "media_type"):\n${indent}    ${obj}.media_type = 'VIDEO'\n${line}`);
}

const FRA = /Fra:(\d+)/g;
const parentOf = (p) => String(p).replace(/[\\/][^\\/]*$/, "");
const fileName = (p) => String(p).split(/[\\/]/).pop();
// Frame count for progress when no saved check has it (a round whose compare never finished).
const frameEnd = (script) => Number(/frame_end\s*=\s*(\d+)/.exec(script)?.[1]) || null;

async function readJson(host, p) {
  try { return JSON.parse(await host.fs.read(p, "utf8")); } catch { return null; }
}

// Runs Blender once. Resolves { code, log } (log = last 20 lines); rejects only when Blender didn't start.
function runBlender(host, settings, args, onFrame) {
  return new Promise((resolve, reject) => {
    const tail = [];
    let partial = "", errText = "";
    const feed = (chunk) => {
      partial += String(chunk);
      const lines = partial.split(/\r?\n|\r/);
      partial = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        tail.push(line);
        if (tail.length > 20) tail.shift();
        if (onFrame) for (const m of line.matchAll(FRA)) onFrame(Number(m[1]));
      }
    };
    const p = host.spawn(settings.blenderPath, args);
    p.onOut((c) => feed(c));
    p.onErr((c) => { errText = String(c); feed(c); });
    p.onExit((code) => {
      if (partial) feed("\n");
      if (code === null || code === undefined) {
        return reject(new Error(`Blender didn't start: ${errText || "no reason given"}. Check the Blender path in .studio-settings.json.`));
      }
      resolve({ code, log: tail.join("\n") });
    });
  });
}

export function makeBlenderRunner({ settings = DEFAULT_SETTINGS } = {}) {
  // The full MP4 render, with frame progress. frames may be unknown (no percentage then).
  async function render(ctx, script, sourceFile, out, frames) {
    const { host } = ctx;
    // A leftover file at out (earlier interrupted run) must not pass for this run's result. Move it aside, never delete.
    if (await host.fs.exists(out)) await host.fs.rename(out, out.replace(/\.mp4$/i, "") + `.stale-${host.now()}.mp4`);
    // A script written before the Blender 5 fix: add the video switch so Run again works.
    try {
      const text = await host.fs.read(script, "utf8");
      const fixed = ensureVideoMediaType(text);
      if (fixed !== text) await host.fs.write(script, fixed);
    } catch { /* unreadable here: Blender reports it */ }
    let last = -1;
    const onFrame = (f) => {
      if (!(frames > 0)) return;
      const p = Math.min(1, Math.max(0, f / frames));
      // Blender prints several lines per frame: report only moves of 1 % or more (and the end).
      if (p - last >= 0.01 || (p === 1 && last !== 1)) {
        last = p;
        ctx.progress(p, `Rendering frame ${Math.min(f, frames)} of ${frames}`);
      }
    };
    const { code, log } = await runBlender(host, settings, ["-b", "--python-exit-code", "1", "-P", script, "--", sourceFile, out], onFrame);
    if (code !== 0) throw new Error(`Blender stopped with exit code ${code}.\n${log}`);
    if (!(await host.fs.exists(out))) throw new Error(`Blender finished but didn't write an output file.\n${log}`);
  }

  return {
    lane: "gpu",
    async start(job, ctx) {
      const input = job.input;
      // A job queued before takes checked themselves: it carries a ready script. Render it as before.
      if (!input.base) {
        await render(ctx, input.script, input.sourceFile, input.out, input.frames);
        return { file: input.out };
      }
      const { host } = ctx;
      const { asset, take, note, previousScript, previousStill, sourceFile, base, out } = input;
      if (!(await canSendImages(host))) throw new Error(NO_PICTURES);
      await host.fs.mkdir(parentOf(base));
      const scriptOf = (k) => `${base}_r${k}.py`;
      const stillOf = (k) => `${base}_check${k}.png`;
      const checkOf = (k) => `${base}_check${k}.json`;
      const finalScript = `${base}.py`;
      const writeScript = (k, text) => host.fs.write(scriptOf(k), ensureVideoMediaType(text));

      // What earlier runs of this job left: round scripts and saved compares.
      let top = 0;
      const saved = [];
      for (let k = 1; k <= ROUNDS; k++) {
        if (!(await host.fs.exists(scriptOf(k)))) break;
        top = k;
        const c = await readJson(host, checkOf(k));
        if (c) saved.push(c);
      }
      const checks = [...saved];
      const lastSaved = saved.at(-1);
      let frames = lastSaved?.frames ?? null;
      const loopDone = (await host.fs.exists(finalScript)) && (saved.some((c) => c.verdict === "matches") || saved.length >= ROUNDS);

      if (!loopDone) {
        const drawing = await readImages(host, [sourceFile]);
        let k = top;
        if (k === 0) {
          ctx.progress(null, "Modelling");
          const data = { asset: { id: asset.id, desc: asset.desc, line: asset.line }, take };
          if (note != null) data.note = note;
          if (previousScript) { try { data.previousScript = await host.fs.read(previousScript, "utf8"); } catch { /* gone: model afresh */ } }
          const images = [...drawing];
          if (data.previousScript != null && previousStill && (await host.fs.exists(previousStill))) images.push(...(await readImages(host, [previousStill])));
          const r = await askJson(host, { instructions: SCRIPT_INSTRUCTIONS, data, tier: "default", validate: validateScript, images });
          k = 1;
          await writeScript(k, r.script);
          frames = r.frames;
        }
        let script = await host.fs.read(scriptOf(k), "utf8");
        if (frames == null) frames = frameEnd(script);
        // Round k's compare is saved already (matches, the third round, or blank twice): only the outcome is left.
        let verdict = checks.find((c) => c.round === k) ?? null;
        while (!verdict) {
          ctx.progress(null, `Check ${k} of ${ROUNDS}`);
          const still = stillOf(k);
          await moveAside(host, still);
          const { code, log } = await runBlender(host, settings, ["-b", "--python-exit-code", "1", "-P", scriptOf(k), "--", sourceFile, out, "--still", still]);
          const ok = code === 0 && (await host.fs.exists(still));
          if (!ok && k === ROUNDS) {
            throw new Error(code !== 0 ? `Blender stopped with exit code ${code}.\n${log}` : `Blender finished but didn't write the check still.\n${log}`);
          }
          const data = { asset: { id: asset.id, desc: asset.desc, line: asset.line }, take, round: k, script, frames };
          if (!ok) data.error = code !== 0 ? `Blender stopped with exit code ${code}.\n${log}` : `Blender finished but didn't write ${fileName(still)}.\n${log}`;
          const images = ok ? [...drawing, ...(await readImages(host, [still]))] : drawing;
          const r = await askJson(host, { instructions: CHECK_INSTRUCTIONS, data, tier: "default", validate: validateCheck, images });
          const blankTwice = r.verdict === "blank" && checks.at(-1)?.verdict === "blank";
          const goOn = k < ROUNDS && !blankTwice && !(ok && r.verdict === "matches");
          const nextFrames = goOn && r.frames != null ? r.frames : frames;
          // The next round's script is written before this round's compare is saved, so a saved
          // "fix" always has its script on disk for Run again.
          if (goOn) await writeScript(k + 1, r.script ?? script);
          const c = { round: k, still: ok ? still : null, verdict: r.verdict, note: r.note, frames: nextFrames };
          await host.fs.write(checkOf(k), JSON.stringify(c));
          checks.push(c);
          if (!goOn) { verdict = c; break; }
          k += 1;
          frames = nextFrames;
          script = await host.fs.read(scriptOf(k), "utf8");
        }
        if (verdict.verdict === "blank" && checks.find((c) => c.round === k - 1)?.verdict === "blank") throw new Error(BLANK_TWICE);
        await host.fs.write(finalScript, ensureVideoMediaType(script));
        if (frames == null) frames = verdict.frames ?? frameEnd(script);
      }
      if (frames == null) frames = frameEnd(await host.fs.read(finalScript, "utf8").catch(() => ""));
      await render(ctx, finalScript, sourceFile, out, frames);
      return {
        file: out,
        meta: { script: finalScript, checks: checks.map(({ round, still, verdict, note }) => ({ round, still, verdict, note })) },
      };
    },
  };
}

export const blenderRunner = makeBlenderRunner();
