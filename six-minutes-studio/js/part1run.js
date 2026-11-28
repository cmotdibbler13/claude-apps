// Part 1 drafts, to-camera picks and the runs that make them: write, revise, redo one clip, edit, restore.
// State: state.part1 = { setup, drafts:[{n, at, why, note, script}], picks:[{id, text, from, why}], pickNotes:[], approvedAt }.
import { writeClips, writeLists, redoClip } from "./part1claude.js";
import { sameWords, scriptLines, clipList, scriptStats, scriptWarnings, readingScriptText, lineScriptText } from "./part1script.js";
import { renderPart1Handover, decisionsFrom, appendPronunciations } from "./part1handover.js";
import { moveAside, writeSafely } from "./libraryio.js";
import { suggestLines } from "./presenter.js";
import { prefixProblem } from "./part1setup.js";
import { openFilm } from "./store.js";
import { join } from "./paths.js";

export const BUSY = "Wait for Claude to finish.";
export const NO_REFERENCE = "No reference script found. Set referenceScripts in .studio-settings.json.";

const keyOf = (dir) => String(dir).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
const busy = new Set();

export const part1Busy = (dir) => busy.has(keyOf(dir));

async function single(ctx, fn) {
  const key = keyOf(ctx.store.dir);
  if (busy.has(key)) throw new Error(BUSY);
  busy.add(key);
  try { return await fn(); } finally { busy.delete(key); }
}

// Claude-backed runs log their start, their end and any failure.
async function logged(ctx, fn) {
  await ctx.store.log("Part 1: writing the script");
  try {
    const d = await fn();
    await ctx.store.log(`Part 1: script written (draft ${d.n})`);
    return d;
  } catch (e) {
    await ctx.store.log(`Part 1: failed: ${e?.message ?? e}`);
    throw e;
  }
}

export const currentDraft = (state) => state?.part1?.drafts?.at(-1) ?? null;

const part1Of = (store) => {
  const p = store.state.part1;
  if (!p) throw new Error("This film has no Part 1 yet.");
  return p;
};
const two = (n) => String(n).padStart(2, "0");

const claudeSetup = (setup) => ({
  topic: setup.topic, prefix: setup.prefix, episode: setup.episode, runtimeTarget: setup.runtime, voice: setup.voice ?? "own",
});

async function readBrief(ctx, setup) {
  try { return await ctx.host.fs.read(setup.brief, "utf8"); } catch { throw new Error(`Couldn't read the brief: ${setup.brief}`); }
}

async function readOptional(host, path) {
  try { if (path && await host.fs.exists(path)) return await host.fs.read(path, "utf8"); } catch { /* unreadable: treat as none */ }
  return null;
}

function mergePronunciations(base, extra) {
  const out = [];
  const seen = new Set();
  for (const p of [...(base ?? []), ...(extra ?? [])]) {
    if (!p?.name || seen.has(p.name)) continue;
    seen.add(p.name);
    out.push({ name: p.name, say: p.say });
  }
  return out;
}

const clipPronunciations = (script) => clipList(script).flatMap((c) => c.clip.pronunciations ?? []);

// Saves a draft (and optionally new picks) in one atomic update. Returns the draft.
async function saveDraft(ctx, { why, note = null, script, picks, pickNotes }) {
  let draft;
  await ctx.store.update((s) => {
    const p = s.part1;
    draft = { n: (p.drafts.at(-1)?.n ?? 0) + 1, at: ctx.host.now(), why, note, script };
    p.drafts.push(draft);
    if (picks !== undefined) p.picks = picks;
    if (pickNotes !== undefined) p.pickNotes = pickNotes;
  });
  return draft;
}

async function suggest(host, script) {
  try {
    const lines = scriptLines(script);
    const byId = new Map(lines.map((l) => [l.id, l]));
    const r = await suggestLines(host, { lines: lines.map(({ id, section, text }) => ({ id, section, text })) });
    return { picks: r.map((x) => ({ id: x.id, text: byId.get(x.id).text, from: "claude", why: x.why })), pickNotes: [] };
  } catch (e) {
    return { picks: [], pickNotes: [`Couldn't suggest to-camera lines: ${e?.message ?? e}`] };
  }
}

// After a change that doesn't re-suggest: keep picks whose line still exists with the same text.
function keepPicks(p, script) {
  const byId = new Map(scriptLines(script).map((l) => [l.id, l.text]));
  const picks = [];
  const pickNotes = [...(p.pickNotes ?? [])];
  for (const pick of p.picks ?? []) {
    if (byId.get(pick.id) === pick.text) picks.push(pick);
    else pickNotes.push(`To-camera line ${pick.id} changed: pick again`);
  }
  return { picks, pickNotes };
}

const needDraft = (p) => {
  const d = p.drafts.at(-1);
  if (!d) throw new Error("There is no draft yet.");
  return d;
};

// ---------- write / revise ----------

export function writeScript(ctx, { note } = {}) {
  return single(ctx, () => logged(ctx, async () => {
    const { host, settings, store } = ctx;
    const p = part1Of(store);
    const setup = p.setup;
    const prev = note ? p.drafts.at(-1)?.script ?? null : null;
    const brief = await readBrief(ctx, setup);
    let reference = null;
    for (const path of settings?.referenceScripts ?? []) {
      try { if (await host.fs.exists(path)) { reference = await host.fs.read(path, "utf8"); break; } } catch { /* try the next */ }
    }
    if (reference === null) throw new Error(NO_REFERENCE);
    const pronunciations = await readOptional(host, settings?.pronunciationsFile);

    const args = { brief, reference, pronunciations, setup: claudeSetup(setup) };
    if (note) Object.assign(args, { note, current: prev });
    const clips = await writeClips(host, args);
    const lists = await writeLists(host, { brief, setup: claudeSetup(setup), sections: clips.sections });
    const script = { ...clips, ...lists, pronunciations: mergePronunciations(prev?.pronunciations, clipPronunciations(clips)) };
    const s = await suggest(host, script);
    return saveDraft(ctx, { why: note ? "Revised from your note" : "Written", note: note || null, script, ...s });
  }));
}

// ---------- redo one clip ----------

export function redoOne(ctx, n, note) {
  return single(ctx, () => logged(ctx, async () => {
    const p = part1Of(ctx.store);
    const cur = needDraft(p);
    const brief = await readBrief(ctx, p.setup);
    const approvedPronunciations = await readOptional(ctx.host, ctx.settings?.pronunciationsFile);
    const clip = await redoClip(ctx.host, { brief, setup: claudeSetup(p.setup), script: cur.script, n, note, approvedPronunciations });
    const script = structuredClone(cur.script);
    const target = clipList(script).find((c) => c.n === n);
    if (!target) throw new Error(`Clip ${two(n)} is not in the script.`);
    const i = target.section.clips.indexOf(target.clip);
    target.section.clips[i] = clip;
    script.pronunciations = mergePronunciations(script.pronunciations, clip.pronunciations);
    return saveDraft(ctx, { why: `Clip ${two(n)} redone: ${note}`, note, script, ...keepPicks(p, script) });
  }));
}

// ---------- edits that don't call Claude ----------

export function editClip(ctx, n, { narration, spoken, cue }) {
  return single(ctx, async () => {
    const p = part1Of(ctx.store);
    const cur = needDraft(p);
    const script = structuredClone(cur.script);
    const target = clipList(script).find((c) => c.n === n);
    if (!target) throw new Error(`Clip ${two(n)} is not in the script.`);
    const c = target.clip;
    if (narration !== undefined) c.narration = narration;
    if (spoken !== undefined) c.spoken = spoken;
    if (cue !== undefined) c.cue = cue;
    const same = sameWords(c.narration, c.spoken);
    if (!same.ok) throw new Error(`The reading and spoken words differ: ${same.diff}`);
    return saveDraft(ctx, { why: `Clip ${two(n)} edited`, script, ...keepPicks(p, script) });
  });
}

export function editLists(ctx, patch = {}) {
  return single(ctx, async () => {
    const p = part1Of(ctx.store);
    const lists = ["shots", "sfx", "pronunciations"].filter((k) => patch[k] !== undefined);
    let draft = null;
    if (lists.length) {
      const cur = needDraft(p);
      const script = structuredClone(cur.script);
      for (const k of lists) script[k] = structuredClone(patch[k]);
      draft = await saveDraft(ctx, { why: "Lists edited", script, ...keepPicks(p, script) });
    }
    if (patch.episode !== undefined) await ctx.store.update((s) => { s.part1.setup.episode = patch.episode; });
    return draft ?? currentDraft(ctx.store.state);
  });
}

export function restoreDraft(ctx, n) {
  return single(ctx, async () => {
    const p = part1Of(ctx.store);
    const old = p.drafts.find((d) => d.n === n);
    if (!old) throw new Error(`There is no draft ${n}.`);
    const script = structuredClone(old.script);
    return saveDraft(ctx, { why: `Back to draft ${n}`, script, ...keepPicks(p, script) });
  });
}

// ---------- picks ----------

export function setPicks(ctx, ids) {
  return single(ctx, async () => {
    const p = part1Of(ctx.store);
    const cur = needDraft(p);
    const byId = new Map(scriptLines(cur.script).map((l) => [l.id, l.text]));
    const old = new Map((p.picks ?? []).map((x) => [x.id, x]));
    const picks = [];
    for (const id of [...new Set(ids)]) {
      if (!byId.has(id)) throw new Error(`There is no line ${id}.`);
      picks.push(old.get(id) ?? { id, text: byId.get(id), from: "jon", why: "" });
    }
    // Jon has now chosen: earlier "pick again" notes no longer apply.
    await ctx.store.update((s) => { s.part1.picks = picks; s.part1.pickNotes = []; });
    return picks;
  });
}

// Starts a film: checks first (nothing is created on a failure), then makes the folder and the studio state.
// briefPending: the brief is copied into the new folder right after (so it isn't there yet).
export async function createFilm(host, root, input, { taken = [], briefPending = false } = {}) {
  const { folder, newFolder, brief, topic, prefix, runtime, episode } = input ?? {};
  const name = typeof newFolder === "string" ? newFolder.trim() : "";
  if (!!folder === !!name) throw new Error("Choose a folder.");
  if (name) {
    if (/[\\/:*?"<>|]/.test(name)) throw new Error("A folder name can't use \\ / : * ? \" < > |.");
    if (await host.fs.exists(join(root, name))) throw new Error(`A folder called ${name} is already there.`);
  }
  if (!brief) throw new Error("Choose a brief.");
  const t = String(topic ?? "").trim();
  if (!t) throw new Error("Add a topic.");
  const problem = prefixProblem(prefix, taken);
  if (problem) throw new Error(problem);
  const ep = String(episode ?? "").trim();
  if (!/^\d{1,4}$/.test(ep)) throw new Error("The episode number is digits only, such as 008.");
  if (!name) {
    if (!(await host.fs.exists(folder))) throw new Error(`That folder isn't there: ${folder}`);
    let existing = null;
    try { existing = JSON.parse(await host.fs.read(join(folder, "studio", "state.json"), "utf8")); } catch { /* none or unreadable: no Part 1 to protect */ }
    if (existing?.part1) throw new Error("This film already has a script started. Open it from Films.");
  }
  if (!briefPending && !(await host.fs.exists(brief))) throw new Error(`The brief isn't there: ${brief}`);
  const dir = name ? join(root, name) : folder;
  if (name) await host.fs.mkdir(dir);
  const store = await openFilm(host, dir);
  await store.update((s) => {
    s.part1 = {
      setup: { folder: dir, brief, topic: t, prefix, episode: ep, runtime: String(runtime ?? "").trim() || "6:00–6:45", voice: "own" },
      drafts: [], picks: [], pickNotes: [], approvedAt: null,
    };
  });
  return dir;
}

// ---------- approve ----------

// Moves an existing file aside (stamped name), then writes the new one.
async function writeNew(host, path, text) {
  await moveAside(host, path, host.now());
  await writeSafely(host, path, text);
}

export function approvePart1(ctx) {
  return single(ctx, async () => {
    const { host, store, settings = {}, root } = ctx;
    const p = part1Of(store);
    const draft = needDraft(p);
    const setup = p.setup;
    if (!String(setup.episode ?? "").trim()) throw new Error("Add the episode number first.");
    const { prefix } = setup;
    const dir = setup.folder;
    const script = draft.script;
    const stats = scriptStats(script, settings);
    const warnings = scriptWarnings(stats, setup.runtime);
    const picks = p.picks ?? [];

    const narration = join(dir, "narration");
    const handoverDir = join(dir, "handover");
    for (const d of [narration, handoverDir]) if (!(await host.fs.exists(d))) await host.fs.mkdir(d);

    const readingPath = join(dir, `${prefix}_script.md`);
    const linePath = join(narration, `${prefix}_line_script.txt`);
    const handoverPath = join(handoverDir, "part1_handover.md");
    const lineText = lineScriptText(script, { prefix, picks: picks.map((x) => x.id) });

    await writeNew(host, readingPath, readingScriptText(script, { prefix, runtimeTarget: setup.runtime, stats }));
    await writeNew(host, linePath, lineText);

    const openItems = [...warnings, ...(p.pickNotes ?? [])];
    let autocueCopy = null;
    if (settings.autocueDir) {
      const target = join(settings.autocueDir, `${prefix}_line_script.txt`);
      try {
        if (!(await host.fs.exists(settings.autocueDir))) throw new Error("folder missing");
        await writeNew(host, target, lineText);
        autocueCopy = target;
      } catch {
        openItems.push(`Copy the line script to Autocue Studio's folder by hand: ${target}`);
      }
    }

    if (settings.pronunciationsFile) {
      const file = settings.pronunciationsFile;
      try {
        const old = (await host.fs.exists(file)) ? await host.fs.read(file, "utf8") : null;
        const next = appendPronunciations(old, setup.topic, script.pronunciations ?? []);
        if (next !== null) await writeSafely(host, file, next);
      } catch (e) {
        openItems.push(`Couldn't add the approved pronunciations to ${file}: ${e?.message ?? e}`);
      }
    }

    const approvedAt = host.now();
    const text = renderPart1Handover({
      topic: setup.topic, prefix, episode: setup.episode, dir, root, brief: setup.brief,
      files: { script: readingPath, lineScript: linePath, autocueCopy },
      recordings: settings.autocueRecordings ? join(settings.autocueRecordings, prefix) : "not set (set autocueRecordings in .studio-settings.json)",
      picks, pronunciations: script.pronunciations ?? [], sfx: script.sfx ?? [],
      decisions: decisionsFrom(p.drafts, setup), openItems, approvedAt,
    });
    await writeNew(host, handoverPath, text);
    await store.update((s) => { s.part1.approvedAt = approvedAt; });
    await store.log(`Part 1 approved (draft ${draft.n})`);
    return { handover: handoverPath, openItems };
  });
}
