// Approve Part 2: add the approved clips to Jon's shared B-roll library and write the Part 2 handover.
// Every read, probe, file check and Claude call happens first; only then is anything written, in a fixed
// order. Nothing is overwritten or deleted: catalogues are copied aside, the sheet and an old handover moved aside.
import { join, filmKey } from "./paths.js";
import { part2Readiness, leftText, hfJobIdFor } from "./part2.js";
import { onCameraConflict } from "./shots.js";
import { nextBrNumber, librarySlug, plannedEntries, withClaudeFields, mdRow, appendMd } from "./library.js";
import { readCatalogue, writeSafely, copyAside, moveAside } from "./libraryio.js";
import { probeClip, makeThumb, contactSheet, windowsFont } from "./tools/libmedia.js";
import { handoverFacts, checkFiles, sfxCues, mixSettings, renderHandover, openingMessage } from "./part2handover.js";
import { part1Facts, libraryFields, handoverProse } from "./part2prose.js";
import { DEFAULT_SETTINGS } from "./settings.js";

export const RUNNING = "Wait for the running jobs to finish.";
export const UNLABELLED = "The contact sheet was made without BR labels.";
const LIBRARY_KINDS = new Set(["broll", "blender", "animated"]);

const lower = (s) => String(s ?? "").toLowerCase();
const baseOf = (p) => String(p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
const filled = (v) => typeof v === "string" && v.trim() !== "";
const chosenTake = (h) => (h?.takes ?? []).find((t) => t.n === h.chosen && t.status === "done" && t.file) ?? null;
const doneTakes = (h) => (h?.takes ?? []).filter((t) => t.status === "done" && filled(t.file));
const jobList = (jobs) => (Array.isArray(jobs) ? jobs : jobs?.list?.() ?? []);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const jsonText = (v) => JSON.stringify(v, null, 2) + "\n";
// The one place a catalogue entry's thumbnail lives: <library>\thumbs\BR-nnn.jpg.
const thumbOf = (paths, id) => join(paths.thumbs, `${id}.jpg`);

function relTo(root, p) {
  const r = String(root).replace(/[\\/]+$/, "") + "\\";
  return lower(p).startsWith(lower(r)) ? String(p).slice(r.length) : null;
}

// The signature of everything approved: [id, chosen, file] per approved holder, plus the mix's time.
export function part2Sig(state) {
  const rows = [];
  for (const a of state?.assets ?? []) {
    if (a.removedAt || !a.approved) continue;
    rows.push([a.id, a.chosen ?? null, chosenTake(a)?.file ?? null]);
  }
  const p = state?.presenter?.portrait;
  if (p?.hfId && p?.file) rows.push(["PORTRAIT", p.n ?? null, p.file ?? null]);
  const sc = state?.audio?.score;
  if (sc?.approved) rows.push([sc.id ?? "SCORE", sc.chosen ?? null, chosenTake(sc)?.file ?? null]);
  for (const x of state?.audio?.sfx ?? []) if (x.approved) rows.push([x.id, x.chosen ?? null, chosenTake(x)?.file ?? null]);
  rows.push(["MIX", state?.mix?.mix?.at ?? null]);
  return JSON.stringify(rows);
}

// True when something approved changed since the handover was written (false when it never was).
export function part2Changed(state) {
  return !!state?.part2 && state.part2.sig !== part2Sig(state);
}

// The library's view of a take: where it came from (Higgsfield job, or the local tool's workflow/script).
function sourceOf(asset, t, jobs) {
  const tool = t.tool ?? asset.tool;
  const out = { file: t.file };
  if (tool === "comfyui") out.local = { tool: "comfyui", workflow: t.workflow ?? t.local?.workflow, seed: t.seed ?? t.local?.seed };
  else if (tool === "blender") out.local = { tool: "blender", script: t.script };
  else out.hfJob = hfJobIdFor(t, jobs);
  return out;
}

const modelOf = (asset, t, settings) => {
  const tool = t.tool ?? asset.tool;
  if (tool === "comfyui") return t.workflow ? baseOf(t.workflow) : "ComfyUI";
  if (tool === "blender") return "Blender";
  return settings?.videoModel ?? DEFAULT_SETTINGS.videoModel;
};

// What Jon decided, for the prose: his notes, and what he picked.
function proseData(state, warnings) {
  const notes = [];
  const choices = [];
  const takeNotes = (h) => { for (const t of h?.takes ?? []) if (filled(t.note)) notes.push({ id: h.id, take: t.n, note: t.note }); };
  for (const a of state.assets ?? []) {
    if (a.removedAt) continue;
    takeNotes(a);
    if (!a.approved) continue;
    if (a.kind === "presenter") choices.push(`${a.id}: take ${a.chosen} approved to camera for line ${a.lineId ?? "?"}${a.line ? ` ("${a.line}")` : ""}`);
    else if (!onCameraConflict(a, state)) choices.push(`${a.id}: take ${a.chosen} approved (${a.kind}, ${a.tool})${a.desc ? `: ${a.desc}` : ""}`);
  }
  takeNotes(state.presenter?.portraits);
  if (state.presenter?.portrait?.hfId && state.presenter?.portrait?.file) choices.push(`Portrait: take ${state.presenter.portrait.n ?? "?"} approved`);
  const look = state.presenter?.look;
  if (look && (filled(look.outfit) || filled(look.set))) choices.push(`The look: ${[look.outfit, look.set].filter(filled).join("; ")}`);
  const sc = state.audio?.score;
  if (sc) { takeNotes({ ...sc, id: sc.id ?? "SCORE" }); if (sc.approved) choices.push(`Score: take ${sc.chosen} approved`); }
  for (const x of state.audio?.sfx ?? []) {
    takeNotes(x);
    if (x.approved) choices.push(`${x.id}${x.cue ? ` (${x.cue})` : ""}: take ${x.chosen} approved${x.startS != null ? ` at ${x.startS} s` : ""}${x.loop ? ", looped" : ""}`);
  }
  for (const [id, l] of Object.entries(state.mix?.pacing?.lines ?? {})) if (filled(l?.note)) notes.push({ id, take: null, note: l.note });
  if (filled(state.mix?.fit?.note)) notes.push({ id: "FIT", take: null, note: state.mix.fit.note });
  for (const t of state.mix?.voiceover?.tightened ?? []) if (filled(t?.id)) choices.push(`Stall tightened on ${t.id}`);
  if (!choices.length) choices.push("Everything approved.");
  return { notes, choices, warnings };
}

// The library is shared across films: one press at a time, whichever film it is for.
let inFlight = null;
export const part2InFlight = () => (inFlight ? { ...inFlight } : null);
export const alreadyText = (dir) => `Part 2 is already being written for ${baseOf(dir)}.`;

export async function approvePart2(ctx, opts = {}) {
  if (inFlight) throw new Error(alreadyText(inFlight.dir));
  inFlight = { dir: ctx.store.dir };
  try { return await run(ctx, opts); } finally { inFlight = null; }
}

async function run(ctx, { onStep } = {}) {
  const { host, store, settings = {}, root, lineScript = null } = ctx;
  const step = (n, text) => { try { onStep?.({ step: n, text }); } catch { /* reporting must not stop the run */ } };
  const state = structuredClone(store.state);
  const dir = store.dir;
  const jobs = jobList(ctx.jobs);

  // 1. Refuse while anything is left to approve, or a job of this film is still going.
  const ready = part2Readiness(state);
  if (!ready.ready) throw new Error(leftText(ready.left));
  const me = filmKey(dir);
  if (jobs.some((j) => filmKey(j?.film) === me && (j.status === "queued" || j.status === "running"))) throw new Error(RUNNING);

  // 2. Read and check everything. No writes in this part.
  step(1, "Reading the library");
  const cat = await readCatalogue(host, root);
  const folder = baseOf(dir);
  const filmFolder = relTo(root, dir) ?? folder;

  const live = (state.assets ?? []).filter((a) => !a.removedAt);
  const lib = [];
  for (const a of live) {
    if (!a.approved || !LIBRARY_KINDS.has(a.kind) || onCameraConflict(a, state)) continue;
    const chosen = chosenTake(a);
    if (!chosen) throw new Error(`Missing file: ${(a.takes ?? []).find((t) => t.n === a.chosen)?.file || `${a.id} chosen take`}`);
    const others = doneTakes(a).filter((t) => t.n !== chosen.n);
    lib.push({ a, chosen, others });
  }
  const sources = lib.flatMap(({ a, chosen, others }) => [chosen, ...others].map((t) => ({ group: "B-roll library", label: `${a.id} take ${t.n}`, path: t.file })));
  const check = handoverFacts({ state, dir, root, lineScript, part1: null, jobs, brIds: new Map(), settings, transcript: null });
  await checkFiles(host, [...sources, ...check.files]);

  const part1File = join(dir, "handover", "part1_handover.md");
  let part1 = { topic: null, episode: null };
  if (await host.fs.exists(part1File)) part1 = await part1Facts(host, String(await host.fs.read(part1File, "utf8")));
  // A film already in the library keeps its name and slug there, so its rows go under its existing table.
  const underFolder = (e) => e && lower(e.source_path).startsWith(lower(filmFolder) + "\\");
  let film = cat.entries.find((e) => underFolder(e) && filled(e.film))?.film;
  let slug;
  if (film) slug = librarySlug(cat.entries, filmFolder, film);
  else {
    film = filled(part1.topic) ? part1.topic : folder;
    slug = librarySlug(cat.entries, filmFolder, film);
    const bySlug = cat.entries.find((e) => e && filled(e.film) && lower(e.library_path).startsWith(lower(`B-roll library\\clips\\${slug}\\`)));
    if (bySlug) film = bySlug.film;
  }

  const transcriptFile = state.mix.voiceover.transcript;
  let transcript;
  try { transcript = JSON.parse(String(await host.fs.read(transcriptFile, "utf8"))); } catch (e) {
    throw new Error(`Couldn't read the voiceover transcript ${transcriptFile}: ${e?.message ?? e}`);
  }

  // Library shots, probed; the takes he didn't choose get a rejected row.
  const byFile = new Map();
  const shots = [];
  for (const { a, chosen, others } of lib) {
    const probe = await probeClip(host, chosen.file);
    const aspect = probe.width >= probe.height ? "16:9" : "9:16";
    const o = [];
    for (const t of others) {
      const size = (await host.fs.stat(t.file)).size;
      o.push({ ...sourceOf(a, t, jobs), note: t.note ?? "", size_mb: size / 1048576 });
      byFile.set(lower(t.file), { a, t, kind: "rejected", probe: null });
    }
    byFile.set(lower(chosen.file), { a, t: chosen, kind: "approved", probe });
    shots.push({ id: a.id, kind: a.kind, aspect, prompt: chosen.prompt ?? a.draftPrompt ?? null, chosen: { ...sourceOf(a, chosen, jobs), n: chosen.n }, others: o, probe });
  }
  const startNumber = nextBrNumber(cat.entries, cat.md);
  const taken = new Set();
  let planned, copies;
  // A different file already at a planned library path is never overwritten: that name is taken, plan again.
  // The same file there (an earlier press copied it, then stopped) is kept and not copied again.
  for (;;) {
    planned = plannedEntries({ shots, entries: cat.entries, film, filmFolder, slug, startNumber, root, taken });
    copies = [];
    let clash = false;
    for (const p of planned) {
      if (!p.copyFrom) continue;
      const dest = join(root, p.entry.library_path);
      let skip = false;
      if (await host.fs.exists(dest)) {
        const [d, src] = [await host.fs.stat(dest), await host.fs.stat(p.copyFrom)];
        if (d.size !== src.size) { taken.add(lower(p.entry.library_path)); clash = true; continue; }
        skip = true;
      }
      copies.push({ from: p.copyFrom, dest, skip, thumb: thumbOf(cat.paths, p.entry.id), id: p.entry.id });
    }
    if (!clash) break;
  }
  const whose = (e) => byFile.get(lower(e.source_path)) ?? byFile.get(lower(join(root, e.source_path)));

  let entries = [];
  if (planned.length) {
    const items = planned.map(({ entry }) => {
      const w = whose(entry);
      return {
        key: entry.id, kind: entry.status === "approved" ? "approved" : "rejected", shot: entry.shot, desc: w?.a.desc ?? "", prompt: entry.prompt ?? "",
        line: w?.a.line ?? "", tool: w ? (w.t.tool ?? w.a.tool) : "", model: w ? modelOf(w.a, w.t, settings) : "", aspect: entry.aspect,
        probe: w?.probe ? { width: w.probe.width, height: w.probe.height, fps: w.probe.fps } : null, note: w?.t.note ?? "",
      };
    });
    const fields = await libraryFields(host, items);
    entries = planned.map(({ entry }) => withClaudeFields(entry, fields.get(entry.id)));
  }
  const all = [...cat.entries, ...entries];

  // BR ids beside the shots: the entry holding each chosen take, new or from an earlier run.
  const brIds = new Map();
  for (const { a, chosen } of lib) {
    const r = relTo(root, chosen.file) ?? chosen.file;
    const e = all.find((x) => x && x.status !== "rejected" && lower(x.source_path) === lower(r));
    if (e) brIds.set(a.id, e.id);
  }
  const facts = handoverFacts({ state, dir, root, lineScript, part1, jobs, brIds, settings, transcript });
  await checkFiles(host, facts.files);
  for (const name of ["awaiting_permission.md", "images_to_download.md"]) {
    if (await host.fs.exists(join(dir, name))) facts.warnings.push(`Archive images: ${name} is still in the project folder.`);
  }
  const prose = await handoverProse(host, proseData(state, facts.warnings));

  // Repair what an earlier, interrupted press left: this film's catalogued entries without an MD row, and
  // its contact sheet when it, or a thumbnail of one of its clips, is missing. The JSON is the commit point.
  const mine = (e) => e && (lower(e.source_path).startsWith(lower(filmFolder) + "\\") || lower(e.library_path).startsWith(lower(`B-roll library\\clips\\${slug}\\`)));
  const inMd = new Set([...String(cat.md).matchAll(/^\|\s*(BR-\d+)\s*\|/gm)].map((m) => m[1]));
  const mdRows = [...cat.entries.filter((e) => mine(e) && !inMd.has(e.id)), ...entries].map(mdRow);
  const md = mdRows.length ? appendMd(cat.md, film, mdRows) : null;
  const doc = entries.length ? { ...cat.doc, [cat.key]: all } : null;
  const onSheet = all.filter((e) => mine(e) && e.status !== "rejected" && e.in_library && filled(e.library_path));
  const newIds = new Set(entries.map((e) => e.id));
  const remakeThumbs = [];
  for (const e of onSheet) {
    if (newIds.has(e.id) || (await host.fs.exists(thumbOf(cat.paths, e.id)))) continue;
    const copy = join(root, e.library_path);
    const src = (await host.fs.exists(copy)) ? copy : join(root, e.source_path);
    remakeThumbs.push({ id: e.id, from: src, thumb: thumbOf(cat.paths, e.id) });
  }
  const sheet = join(cat.paths.sheets, `${slug}.jpg`);
  const makeSheet = onSheet.length > 0 && (entries.length > 0 || remakeThumbs.length > 0 || !(await host.fs.exists(sheet)));
  const clipsDir = join(cat.paths.clips, slug);
  const fontfile = await windowsFont(host);
  const now = host.now();
  const handoverDir = join(dir, "studio", "handover");
  const handover = join(dir, "handover", "part2_handover.md");
  // Everything that can throw is worked out here, before the first write.
  const cuesText = jsonText(sfxCues(state, jobs));
  const mixText = jsonText(mixSettings(state, settings, jobs));
  renderHandover(facts, prose);

  // 3. Write, in order: clips, thumbnails, MD, JSON (the commit point), sheet, hand-off files, handover.
  const added = entries.filter((e) => e.status === "approved").length;
  step(2, `Adding ${plural(added, "clip", "clips")}`);
  if (copies.length) await host.fs.mkdir(clipsDir);
  for (const c of copies) if (!c.skip) await writeSafely(host, c.dest, await host.fs.read(c.from));

  step(3, "Thumbnails and contact sheet");
  const warnings = [];
  if (copies.length || remakeThumbs.length) await host.fs.mkdir(cat.paths.thumbs);
  for (const c of copies) {
    await moveAside(host, c.thumb, now);
    await makeThumb(host, c.from, c.thumb);
  }
  for (const r of remakeThumbs) {
    try { await makeThumb(host, r.from, r.thumb); } catch (e) { warnings.push(`The thumbnail for ${r.id} couldn't be made: ${e?.message ?? e}`); }
  }
  if (md != null) {
    await copyAside(host, cat.paths.md, now);
    await writeSafely(host, cat.paths.md, md);
  }
  if (doc) {
    await copyAside(host, cat.paths.json, now);
    await writeSafely(host, cat.paths.json, jsonText(doc));
  }
  if (makeSheet) {
    const items = [];
    for (const e of onSheet) if (await host.fs.exists(thumbOf(cat.paths, e.id))) items.push({ thumb: thumbOf(cat.paths, e.id), id: e.id });
    // No thumbnail made it (each already warned): leave the old sheet where it is.
    if (items.length) try {
      await host.fs.mkdir(cat.paths.sheets);
      await moveAside(host, sheet, now);
      const r = await contactSheet(host, items, sheet, { fontfile });
      if (!r.labelled) warnings.push(UNLABELLED);
    } catch (e) {
      warnings.push(`The contact sheet couldn't be made: ${e?.message ?? e}`);
    }
  }

  step(4, "Hand-off files");
  await host.fs.mkdir(handoverDir);
  for (const [name, text] of [["sfx_cues.json", cuesText], ["mix_settings.json", mixText]]) {
    const f = join(handoverDir, name);
    await moveAside(host, f, now);
    await writeSafely(host, f, text);
  }

  step(5, "Writing the handover");
  facts.warnings.push(...warnings);
  await host.fs.mkdir(join(dir, "handover"));
  await moveAside(host, handover, now);
  await writeSafely(host, handover, renderHandover(facts, prose));

  const ids = lib.map(({ a }) => brIds.get(a.id)).filter(Boolean);
  const sig = part2Sig(state);
  const topic = facts.project.topic;
  const message = openingMessage(topic, dir);
  await store.update((d) => { d.part2 = { approvedAt: now, handover, brIds: ids, sig, topic, message }; });
  await store.log(`Part 2 approved: ${plural(added, "clip", "clips")} added to the B-roll library, handover written`);
  return { brIds: ids, handover, added: entries.map((e) => e.id), warnings, message };
}
