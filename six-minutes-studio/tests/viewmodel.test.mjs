import { test } from "node:test";
import assert from "node:assert/strict";
import { filmRow, filmsModel } from "../js/ui/films.js";
import { activeCount, jobsModel, render as jobsRender } from "../js/ui/jobs.js";
import { summarize, cardModel, reviewModel, scriptCandidates, card, MSG_I2V_SETUP } from "../js/ui/review.js";

const DIR = "S:\\Youtube video ideas\\Skara Brae";
const parts = (a, b, c, d) => ({ 1: a, 2: b, 3: c, shorts: d });
const film = (o = {}) => ({ dir: DIR, title: "Skara Brae", number: "014", parts: parts("done", "now", "none", "none"), waiting: null, hasStudio: true, ...o });
const take = (n, status, o = {}) => ({ n, status, prompt: "p", at: 1, ...o });
const asset = (o = {}) => ({ id: "HF-01", kind: "lineart", line: "The village sat under sand.", lineIndex: 0, desc: "Village plan", tool: "higgsfield", draftPrompt: "d", takes: [], chosen: 0, approved: false, ...o });
const job = (o = {}) => ({ id: "j1", film: DIR, assetId: "HF-01", take: 1, tool: "higgsfield", what: "HF-01: Village plan", why: "First take", lane: "connector", status: "queued", progress: null, eta: null, ...o });

// Films

test("waiting line uses brass when waiting on Jon", () => {
  const row = filmRow(film({ waiting: "Shot list ready to review" }), []);
  assert.equal(row.wait.you, true);
  assert.equal(row.wait.label, "Waiting on you:");
  assert.equal(row.wait.text, "Shot list ready to review");
  assert.equal(row.button.primary, true);
});

test("film row without waiting shows running jobs, not brass", () => {
  const row = filmRow(film(), [job({ status: "running" }), job({ id: "j2", status: "queued" }), job({ id: "j3", film: "other", status: "running" })]);
  assert.equal(row.wait.you, false);
  assert.equal(row.wait.live, true);
  assert.equal(row.wait.text, "2 jobs");
  assert.equal(row.button.primary, false);
});

test("film row: number, tracker and the review button only for part 2", () => {
  const row = filmRow(film(), []);
  assert.equal(row.meta, "No. 014");
  assert.equal(row.dot, null);
  assert.equal(row.wait, null);
  assert.deepEqual(row.parts.map((p) => [p.label, p.state]), [["1 Script", "done"], ["2 Assets", "now"], ["3 Build", "none"], ["Shorts", "none"]]);
  assert.equal(row.button.label, "Open review");
  assert.equal(filmRow(film({ number: null, parts: parts("done", "done", "now", "none") }), []).button, null);
  assert.equal(filmRow(film({ number: null }), []).meta, null);
});

test("films model reports an unreachable root", () => {
  const m = filmsModel({ root: null, films: [], jobs: [] });
  assert.equal(m.unreachable, true);
  assert.match(m.message, /Can't reach S:\\Youtube video ideas or the server copy\. Check the drive is connected\./);
  assert.equal(filmsModel({ root: "S:\\x", films: [], jobs: [] }).empty, true);
});

// Live jobs

test("nav badge counts queued and running only", () => {
  assert.equal(activeCount([job(), job({ status: "running" }), job({ status: "done" }), job({ status: "failed" }), job({ status: "interrupted" })]), 2);
});

test("jobs newest first with progress, eta and run again rules", () => {
  const jobs = [
    job({ id: "a", status: "failed", error: "boom", assetId: "HF-09" }),
    job({ id: "b", status: "running", progress: 0.42, tool: "blender" }),
    job({ id: "c", status: "running", progress: null }),
    job({ id: "d", status: "queued", assetId: "HF-02" }),
    job({ id: "e", status: "interrupted", assetId: "HF-03", film: "S:\\Youtube video ideas\\Other" }),
  ];
  const m = jobsModel({ jobs, log: null, retried: new Set(["e"]) });
  assert.deepEqual(m.rows.map((r) => r.id), ["e", "d", "c", "b", "a"]);
  const by = Object.fromEntries(m.rows.map((r) => [r.id, r]));
  assert.equal(by.b.pct, 42);
  assert.equal(by.b.eta, "42%");
  assert.equal(by.b.tool, "Blender");
  assert.equal(by.c.pct, null);
  assert.equal(by.c.indeterminate, true);
  assert.equal(by.d.eta, "queued");
  assert.equal(by.d.indeterminate, false);
  assert.equal(by.a.canRetry, true);
  assert.equal(by.a.error, "boom");
  assert.equal(by.e.canRetry, false, "already clicked");
  assert.equal(by.e.filmTitle, "Other");
  assert.equal(by.a.filmTitle, "Skara Brae");
  assert.equal(m.keepOpen, true);
});

test("a failed job with a later job for the same take cannot run again", () => {
  const m = jobsModel({ jobs: [job({ id: "a", status: "failed" }), job({ id: "b", status: "running" })], log: null, retried: new Set() });
  assert.equal(m.rows.find((r) => r.id === "a").canRetry, false);
});

test("no run again while another take of the same shot is active", () => {
  const m = jobsModel({ jobs: [job({ id: "a", status: "failed" }), job({ id: "b", take: 2, status: "running" })], log: null, retried: new Set() });
  assert.equal(m.rows.find((r) => r.id === "a").canRetry, false);
  const n = jobsModel({ jobs: [job({ id: "a", status: "failed" }), job({ id: "b", take: 2, status: "done" })], log: null, retried: new Set() });
  assert.equal(n.rows.find((r) => r.id === "a").canRetry, true);
});

test("activity log needs an open film", () => {
  assert.equal(jobsModel({ jobs: [], log: null, retried: new Set() }).logEmpty, "Open a film to see its activity");
  const m = jobsModel({ jobs: [job({ status: "done" })], log: [{ t: Date.UTC(2026, 10, 26, 16, 42), text: "HF-01 take 1 ready" }], retried: new Set() });
  assert.equal(m.log[0].text, "HF-01 take 1 ready");
  assert.match(m.log[0].time, /^\d\d:\d\d$/);
  assert.equal(m.keepOpen, false);
});

test("persist error banner text", () => {
  const m = jobsModel({ jobs: [], log: null, retried: new Set(), persistError: "EACCES" });
  assert.equal(m.banner, "Couldn't save job progress to the drive: EACCES. If you close the app now, running jobs may not reconnect.");
  assert.equal(jobsModel({ jobs: [], log: null, retried: new Set() }).banner, null);
});

// Review

test("summary counts approved and regenerating", () => {
  const assets = [
    asset({ id: "HF-01", approved: true, takes: [take(1, "done")], chosen: 1 }),
    asset({ id: "HF-02", takes: [take(1, "done"), take(2, "running")], chosen: 2 }),
    asset({ id: "HF-03", takes: [take(1, "queued")], chosen: 1 }),
    asset({ id: "HF-04", takes: [take(1, "failed")], chosen: 1 }),
  ];
  assert.deepEqual(summarize(assets), { approved: 1, total: 4, regenerating: 2 });
});

test("blender card locked until source approved", () => {
  const src = asset({ id: "HF-01", takes: [take(1, "done", { file: "S:\\f\\HF-01_t1.png" })], chosen: 1 });
  const bl = asset({ id: "HF-02", kind: "blender", tool: "blender", sourceId: "HF-01", lineIndex: 1 });
  let c = cardModel(bl, [src, bl]);
  assert.equal(c.locked, true);
  assert.equal(c.lockText, "Approve HF-01 first");
  assert.equal(c.canMakeFirst, false);
  assert.equal(c.tool, "Blender");
  assert.equal(c.sourceFile, "S:\\f\\HF-01_t1.png");
  const ok = { ...src, approved: true };
  c = cardModel(bl, [ok, bl]);
  assert.equal(c.locked, false);
  assert.equal(c.canMakeFirst, true);
});

test("card buttons follow take state", () => {
  const busy = cardModel(asset({ takes: [take(1, "done", { file: "a.png" }), take(2, "running", { note: "darker" })], chosen: 2 }), []);
  assert.equal(busy.busy, true);
  assert.equal(busy.overlay, "Regenerating in Higgsfield");
  assert.equal(busy.canApprove, false);
  assert.equal(busy.canRedo, false);
  assert.equal(busy.canPick, false);
  assert.deepEqual(busy.takes.map((t) => [t.n, t.pressed]), [[1, false], [2, true]]);
  assert.equal(busy.tag, "HF-01 · Higgsfield · take 2/2");
  assert.deepEqual(busy.history, ['take 2, your note: "darker"']);

  const done = cardModel(asset({ takes: [take(1, "done", { file: "a.mp4" })], chosen: 1 }), []);
  assert.equal(done.canApprove, true);
  assert.equal(done.canRedo, true);
  assert.equal(done.file, "a.mp4");
  assert.equal(done.isVideo, true);
  assert.equal(done.canMakeFirst, false);

  const fresh = cardModel(asset(), []);
  assert.equal(fresh.canMakeFirst, true);
  assert.equal(fresh.canRedo, false);
  assert.equal(fresh.file, null);

  const failed = cardModel(asset({ takes: [take(1, "failed", { error: "nsfw" })], chosen: 1 }), []);
  assert.equal(failed.canApprove, false);
  assert.equal(failed.canRedo, true);
  assert.equal(failed.status, "Take 1 failed: nsfw");

  const pending = cardModel(asset({ takes: [take(1, "done", { file: "a.png" })], chosen: 1 }), [], { pending: true, error: "No luck" });
  assert.equal(pending.canApprove, false);
  assert.equal(pending.canRedo, false);
  assert.equal(pending.error, "No luck");
});

test("review model orders cards by script and offers a shot list when empty", () => {
  const empty = reviewModel({ film: film(), state: { assets: [] }, layout: "script" });
  assert.equal(empty.needsShotList, true);
  const m = reviewModel({
    film: film(),
    state: { assets: [asset({ id: "HF-02", lineIndex: 5 }), asset({ id: "HF-01", lineIndex: 1 })] },
    layout: "grid",
  });
  assert.equal(m.needsShotList, false);
  assert.deepEqual(m.cards.map((c) => c.id), ["HF-01", "HF-02"]);
  assert.equal(m.layout, "grid");
  assert.equal(m.eyebrow, "Skara Brae / Part 2 assets / review");
  assert.equal(reviewModel({ film: null }).noFilm, true);
});

test("script path candidates from the handover", () => {
  const text = [
    "Episode: 014",
    "Script: `Skara Brae_script.md`",
    "Brief: brief.md",
    "Old copy: C:\\Users\\Jon\\Youtube video ideas\\Skara Brae\\old_script.md",
    "Also S:\\Youtube video ideas\\Skara Brae\\drafts\\Final Script.md",
  ].join("\n");
  assert.deepEqual(scriptCandidates(text, DIR), [
    DIR + "\\Skara Brae_script.md",
    "S:\\Youtube video ideas\\Skara Brae\\drafts\\Final Script.md",
  ]);
  assert.deepEqual(scriptCandidates("no paths here", DIR), []);
});

test("moved-aside job list banner", async () => {
  const { movedAsideBanner } = await import("../js/ui/jobs.js");
  assert.equal(movedAsideBanner(".studio-jobs.bad-1.json"), "The job list couldn't be read and was saved as .studio-jobs.bad-1.json. Jobs that were running may not reconnect.");
  assert.equal(movedAsideBanner(null), "The job list couldn't be read. Jobs that were running may not reconnect.");
});

test("film rows and job rows match jobs by folder name, not by full path", () => {
  const unc = "\\\\192.168.1.171\\jon\\Youtube video ideas\\skara brae";
  const row = filmRow(film(), [job({ film: unc, status: "running" })]);
  assert.equal(row.wait.text, "1 job");
  const m = jobsModel({ jobs: [job({ id: "a", status: "failed" }), job({ id: "b", film: unc, status: "running" })], log: null, retried: new Set() });
  assert.equal(m.rows.find((r) => r.id === "a").canRetry, false);
});

test("state save error banner", async () => {
  const { stateErrorBanner } = await import("../js/ui/jobs.js");
  assert.equal(stateErrorBanner("S:\\Youtube video ideas\\Skara Brae", "EACCES"), "Couldn't save Skara Brae's state: EACCES");
});

test("connector jobs: check again, run again warns about credits and ambiguous failures", () => {
  const m = jobsModel({ jobs: [
    job({ id: "a", status: "failed", error: "Couldn't reach", jobRef: "R1", ambiguous: true }),
    job({ id: "b", assetId: "HF-02", status: "interrupted" }),
    job({ id: "c", assetId: "HF-03", status: "failed", error: "nsfw", jobRef: "R3" }),
    job({ id: "d", assetId: "HF-04", status: "failed", error: "exit 1", tool: "blender", lane: "gpu" }),
  ], log: null, retried: new Set() });
  const by = Object.fromEntries(m.rows.map((r) => [r.id, r]));
  assert.equal(by.a.canCheck, true);
  assert.equal(by.a.retryLabel, "Run again (new generation, uses credits)");
  assert.equal(by.a.warning, "Check Higgsfield first: this job may still be running.");
  assert.equal(by.b.canCheck, false);
  assert.equal(by.b.warning, "Check Higgsfield first: this job may still be running.", "interrupted before a job id came back");
  assert.equal(by.c.canCheck, true);
  assert.equal(by.c.warning, null);
  assert.equal(by.d.canCheck, false);
  assert.equal(by.d.retryLabel, "Run again");
  assert.equal(by.d.warning, null);
});

test("a failed boot shows its message with Try again", () => {
  const m = filmsModel({ root: null, films: [], jobs: [], error: "EIO: i/o error" });
  assert.equal(m.failed, true);
  assert.equal(m.message, "Couldn't load your films: EIO: i/o error");
});

test("a film that fails to open shows its message on the review screen", () => {
  const m = reviewModel({ film: null, openError: { dir: DIR, title: "Skara Brae", message: "EACCES" } });
  assert.equal(m.openFailed, true);
  assert.equal(m.title, "Skara Brae");
  assert.equal(m.message, "Couldn't open Skara Brae: EACCES");
  assert.equal(m.dir, DIR);
});

// ComfyUI

const broll = (o = {}) => asset({ id: "HF-05", kind: "broll", desc: "Dunes at dusk", ...o });

test("tool switch shows only on b-roll cards, with the current tool pressed", () => {
  assert.equal(cardModel(asset(), [asset()]).toolSwitch, null);
  const bl = asset({ id: "BL-01", kind: "lineart", tool: "blender", sourceId: "HF-01" });
  assert.equal(cardModel(bl, [bl]).toolSwitch, null);
  const c = cardModel(broll({ tool: "comfyui" }), [broll({ tool: "comfyui" })]);
  assert.deepEqual(c.toolSwitch.options, [
    { tool: "higgsfield", label: "Higgsfield", pressed: false },
    { tool: "comfyui", label: "ComfyUI", pressed: true },
  ]);
  assert.equal(c.toolSwitch.disabled, false);
  assert.equal(c.tool, "ComfyUI");
  assert.match(c.tag, /HF-05 \u00B7 ComfyUI/);
});

test("tool switch is disabled while the shot is busy or pending", () => {
  const busy = broll({ takes: [take(1, "running")], chosen: 1 });
  assert.equal(cardModel(busy, [busy]).toolSwitch.disabled, true);
  const queued = broll({ takes: [take(1, "queued")], chosen: 1 });
  assert.equal(cardModel(queued, [queued]).toolSwitch.disabled, true);
  assert.equal(cardModel(broll(), [broll()], { pending: true }).toolSwitch.disabled, true);
  const done = broll({ takes: [take(1, "done", { file: "x.mp4" })], chosen: 1 });
  assert.equal(cardModel(done, [done]).toolSwitch.disabled, false);
});

test("comfyui overlay text; other tools keep Regenerating in", () => {
  const run = broll({ tool: "comfyui", takes: [take(1, "running")], chosen: 1 });
  assert.equal(cardModel(run, [run]).overlay, "Rendering in ComfyUI");
  const q = broll({ tool: "comfyui", takes: [take(1, "queued")], chosen: 1 });
  assert.equal(cardModel(q, [q]).overlay, "Queued for ComfyUI");
  const hf = broll({ takes: [take(1, "running")], chosen: 1 });
  assert.equal(cardModel(hf, [hf]).overlay, "Regenerating in Higgsfield");
});

test("the tag and overlay follow the running take's tool, falling back to the shot's tool", () => {
  const a = broll({ tool: "higgsfield", takes: [take(1, "running", { tool: "comfyui" })], chosen: 1 });
  const c = cardModel(a, [a]);
  assert.equal(c.overlay, "Rendering in ComfyUI");
  assert.equal(c.tag, "HF-05 \u00B7 ComfyUI \u00B7 take 1/1");
  const old = broll({ tool: "comfyui", takes: [take(1, "queued")], chosen: 1 });
  const o = cardModel(old, [old]);
  assert.equal(o.overlay, "Queued for ComfyUI");
  assert.match(o.tag, /ComfyUI/);
  const idle = broll({ tool: "higgsfield", takes: [take(1, "done", { tool: "comfyui", file: "a.mp4" })], chosen: 1 });
  assert.match(cardModel(idle, [idle]).tag, /Higgsfield/);
});

test("review model carries the prefer ComfyUI preference, before and after a shot list", () => {
  const f = film();
  const empty = reviewModel({ film: f, state: { assets: [], prefs: { preferComfy: true } } });
  assert.equal(empty.needsShotList, true);
  assert.equal(empty.preferComfy, true);
  assert.equal(empty.preferDisabled, false);
  const m = reviewModel({ film: f, state: { assets: [broll()] }, pending: new Set(["HF-05"]) });
  assert.equal(m.preferComfy, false);
  assert.equal(m.preferDisabled, true, "while any card action is pending");
  assert.equal(reviewModel({ film: f, state: { assets: [] }, making: true }).preferDisabled, true);
});

test("comfyui jobs: check again is free, plain run again, ComfyUI warning", () => {
  const cj = (o) => job({ tool: "comfyui", lane: "gpu", ...o });
  const m = jobsModel({ jobs: [
    cj({ id: "a", status: "failed", error: "Couldn't reach ComfyUI", jobRef: "P1", ambiguous: true }),
    cj({ id: "b", assetId: "HF-02", status: "interrupted" }),
    cj({ id: "c", assetId: "HF-03", status: "failed", error: "bad node", jobRef: "P3" }),
    cj({ id: "d", assetId: "HF-04", status: "failed", error: "x", jobRef: "P4" }),
    cj({ id: "e", assetId: "HF-04", take: 2, status: "running" }),
  ], log: null, retried: new Set() });
  const by = Object.fromEntries(m.rows.map((r) => [r.id, r]));
  assert.equal(by.a.tool, "ComfyUI");
  assert.equal(by.a.canCheck, true);
  assert.equal(by.a.retryLabel, "Run again");
  assert.equal(by.a.warning, "Check ComfyUI first: this render may still be running.");
  assert.equal(by.b.canCheck, false);
  assert.equal(by.b.warning, "Check ComfyUI first: this render may still be running.");
  assert.equal(by.c.canCheck, true);
  assert.equal(by.c.warning, null);
  assert.equal(by.d.canCheck, false, "superseded by another take of the shot");
});

test("higgsfield on the gpu lane still gets the credits wording; blender never checks", () => {
  const m = jobsModel({ jobs: [
    job({ id: "a", status: "failed", jobRef: "R1", ambiguous: true, lane: undefined }),
    job({ id: "b", assetId: "BL-01", status: "failed", jobRef: "X", tool: "blender", lane: "gpu" }),
  ], log: null, retried: new Set() });
  const by = Object.fromEntries(m.rows.map((r) => [r.id, r]));
  assert.equal(by.a.canCheck, true);
  assert.equal(by.a.retryLabel, "Run again (new generation, uses credits)");
  assert.equal(by.a.warning, "Check Higgsfield first: this job may still be running.");
  assert.equal(by.b.canCheck, false);
  assert.equal(by.b.retryLabel, "Run again");
  assert.equal(by.b.warning, null);
});

import { keepOpenText } from "../js/ui/jobs.js";
test("keep-open line explains the tray once the app lives there", () => {
  assert.equal(keepOpenText(false), "Keep this window open while jobs run.");
  assert.match(keepOpenText(true), /system tray/);
  assert.match(keepOpenText(true), /right-click its tray icon and choose Exit/);
});

test("cardModel can3d: line art without a Blender version, when free", () => {
  const la = asset({ id: "HF-02" });
  const b = asset({ id: "HF-03", kind: "blender", tool: "blender", sourceId: "HF-02" });
  assert.equal(cardModel(la, [la]).can3d, true);
  assert.equal(cardModel(la, [la, b]).can3d, false);
  assert.equal(cardModel(asset({ id: "HF-05", kind: "broll" }), []).can3d, false);
  assert.equal(cardModel(b, [la, b]).can3d, false);
  const running = asset({ takes: [take(1, "running")], chosen: 1 });
  assert.equal(cardModel(running, [running]).can3d, false);
  assert.equal(cardModel(la, [la], { pending: true }).can3d, false);
});

const READY = { ok: true, why: "" };
const NOT_READY = { ok: false, why: "animate_i2v.json isn't in ComfyUI workflows" };

test("cardModel animate: line art without an animated version; disabled with the set-up title until i2v is ready", () => {
  const la = asset({ id: "HF-02" });
  const an = asset({ id: "HF-04", kind: "animated", tool: "comfyui", sourceId: "HF-02" });
  let c = cardModel(la, [la], { i2v: READY });
  assert.equal(c.showAnimate, true);
  assert.equal(c.canAnimate, true);
  assert.equal(c.animateWhy, null);
  c = cardModel(la, [la], { i2v: NOT_READY });
  assert.equal(c.showAnimate, true);
  assert.equal(c.canAnimate, false);
  assert.equal(c.animateWhy, "Set up the image-to-video workflow (see Probe)");
  assert.equal(MSG_I2V_SETUP, "Set up the image-to-video workflow (see Probe)");
  // Not checked yet counts as not ready.
  assert.equal(cardModel(la, [la]).canAnimate, false);
  // Hidden once the drawing has a live animated version; never on other kinds.
  assert.equal(cardModel(la, [la, an], { i2v: READY }).showAnimate, false);
  assert.equal(cardModel(an, [la, an], { i2v: READY }).showAnimate, false);
  assert.equal(cardModel(asset({ id: "HF-05", kind: "broll" }), [], { i2v: READY }).showAnimate, false);
  // Can't start while the card is busy or pending (same rule as Make 3D).
  const running = asset({ takes: [take(1, "running")], chosen: 1 });
  assert.equal(cardModel(running, [running], { i2v: READY }).canAnimate, false);
  assert.equal(cardModel(la, [la], { pending: true, i2v: READY }).canAnimate, false);
  // A 3D version doesn't hide Animate, nor an animated one Make 3D.
  const b = asset({ id: "HF-03", kind: "blender", tool: "blender", sourceId: "HF-02" });
  assert.equal(cardModel(la, [la, b], { i2v: READY }).showAnimate, true);
  assert.equal(cardModel(la, [la, an], { i2v: READY }).can3d, true);
});

test("cardModel remove: derived versions only, not while a take is queued, running or pending; confirm copy", () => {
  const la = asset({ id: "HF-01", approved: true });
  const b = asset({ id: "HF-02", kind: "blender", tool: "blender", sourceId: "HF-01" });
  const an = asset({ id: "HF-03", kind: "animated", tool: "comfyui", sourceId: "HF-01" });
  assert.equal(cardModel(b, [la, b]).removable, true);
  assert.equal(cardModel(b, [la, b]).canRemove, true);
  assert.equal(cardModel(an, [la, an]).canRemove, true);
  assert.equal(cardModel(la, [la]).removable, false);
  assert.equal(cardModel(asset({ id: "HF-05", kind: "broll" }), []).removable, false);
  for (const st of ["queued", "running"]) {
    const busy = { ...b, takes: [take(1, st)], chosen: 1 };
    assert.equal(cardModel(busy, [la, busy]).canRemove, false);
  }
  assert.equal(cardModel(b, [la, b], { pending: true }).canRemove, false);
  assert.equal(cardModel(b, [la, b]).confirmRemove, null);
  assert.equal(cardModel(b, [la, b], { confirmRemove: true }).confirmRemove, "Remove HF-02 from the review? Its takes stay on disk.");
  // An animated version shows its drawing like a 3D one.
  const src = { ...la, takes: [take(1, "done", { file: "S:\\f\\HF-01_t1.png" })], chosen: 1 };
  assert.equal(cardModel(an, [src, an]).sourceFile, "S:\\f\\HF-01_t1.png");
});

test("review model passes i2v readiness and the remove confirm to the cards", () => {
  const la = asset({ id: "HF-01", approved: true });
  const b = asset({ id: "HF-02", kind: "blender", tool: "blender", sourceId: "HF-01", lineIndex: 0 });
  const m = reviewModel({ film: film(), state: { assets: [la, b] }, i2v: READY, removeFor: "HF-02" });
  const byId = Object.fromEntries(m.cards.map((c) => [c.id, c]));
  assert.equal(byId["HF-01"].canAnimate, true);
  assert.match(byId["HF-02"].confirmRemove, /^Remove HF-02 from the review\?/);
  assert.equal(byId["HF-01"].confirmRemove, null);
});

const CHECKS = [
  { round: 1, still: "S:\\f\\HF-02_t1_check1.png", verdict: "fix", note: "Made the top slab thicker and moved the far upright back so it lines up with the drawing's back edge." },
  { round: 2, still: "S:\\f\\HF-02_t1_check2.png", verdict: "matches", note: "Matches the drawing." },
];

test("cardModel checks: the chosen blender take's last check still and its notes", () => {
  const la = asset({ id: "HF-01", approved: true });
  const b = asset({ id: "HF-02", kind: "blender", tool: "blender", sourceId: "HF-01",
    takes: [take(1, "done", { file: "a.mp4", checks: CHECKS })], chosen: 1 });
  const c = cardModel(b, [la, b]);
  assert.equal(c.checks.take, 1);
  assert.equal(c.checks.still, "S:\\f\\HF-02_t1_check2.png");
  assert.deepEqual(c.checks.notes.map((n) => n.label), ["Check 1 (fixed)", "Check 2 (matched)"]);
  assert.equal(c.checks.notes[1].text, "Matches the drawing.");
  assert.ok(c.checks.notes[0].text.length <= 81 && c.checks.notes[0].text.endsWith("\u2026"));
  assert.equal(c.checks.notes[0].full, CHECKS[0].note);
  // A round whose still didn't render: the last still that did.
  const noStill = { ...b, takes: [take(1, "done", { file: "a.mp4", checks: [CHECKS[0], { round: 2, still: null, verdict: "fix", note: "n" }] })] };
  assert.equal(cardModel(noStill, [la, noStill]).checks.still, CHECKS[0].still);
  // No checks: none shown.
  assert.equal(cardModel({ ...b, takes: [take(1, "done", { file: "a.mp4" })] }, [la, b]).checks, null);
  // The chosen take has none (a failed redo): the newest take that has them, named.
  const two = { ...b, takes: [take(1, "done", { file: "a.mp4", checks: CHECKS }), take(2, "failed", { error: "x" })], chosen: 2 };
  assert.equal(cardModel(two, [la, two]).checks.take, 1);
});

// A stub DOM with just enough for h(), mediaEl and click handlers.
function withDom(fn) {
  const mk = (tag) => {
    const el = { tag, attrs: {}, children: [], listeners: {}, style: {}, className: "", textContent: "",
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
      addEventListener(k, f) { (this.listeners[k] ||= []).push(f); },
      append(...k) { this.children.push(...k); }, replaceChildren(...k) { this.children = [...k]; } };
    Object.setPrototypeOf(el, globalThis.Node.prototype);
    return el;
  };
  globalThis.Node = class {};
  globalThis.document = { createElement: mk, createTextNode: (t) => ({ t }) };
  return Promise.resolve().then(fn).finally(() => { delete globalThis.document; delete globalThis.Node; });
}
const all = (el, pred, out = []) => {
  if (!el || typeof el !== "object") return out;
  if (pred(el)) out.push(el);
  for (const c of el.children ?? []) all(c, pred, out);
  return out;
};
const textOf = (el) => (el.textContent ?? "") + (el.children ?? []).map((c) => (c.t ?? textOf(c))).join("");
const buttons = (el) => all(el, (x) => x.tag === "button");
const byText = (el, t) => buttons(el).find((b) => textOf(b) === t);
const click = (el) => { for (const f of el.listeners.click ?? []) f({}); };
const stubActions = (calls = []) => new Proxy({ preview: (f) => `blob:${f}`, draft: () => "" }, {
  get: (o, k) => (k in o ? o[k] : (...a) => { calls.push([k, ...a]); }),
});

test("card DOM: Animate with ComfyUI beside Make 3D, disabled with its title until set up", () => withDom(() => {
  const la = asset({ id: "HF-01", approved: true, takes: [take(1, "done", { file: "a.png" })], chosen: 1 });
  const calls = [];
  let el = card(cardModel(la, [la], { i2v: NOT_READY }), { layout: "script" }, stubActions(calls));
  const labels = buttons(el).map(textOf);
  assert.equal(labels[labels.indexOf("Make 3D in Blender") + 1], "Animate with ComfyUI");
  const an = byText(el, "Animate with ComfyUI");
  assert.equal(an.disabled, true);
  assert.equal(an.attrs.title, "Set up the image-to-video workflow (see Probe)");
  el = card(cardModel(la, [la], { i2v: READY }), { layout: "script" }, stubActions(calls));
  const on = byText(el, "Animate with ComfyUI");
  assert.ok(!on.disabled);
  assert.equal(on.attrs.title, undefined);
  click(on);
  assert.deepEqual(calls.at(-1), ["animate", "HF-01"]);
}));

test("card DOM: Remove this version opens a confirm row; Remove and Cancel", () => withDom(() => {
  const la = asset({ id: "HF-01", approved: true });
  const b = asset({ id: "HF-02", kind: "blender", tool: "blender", sourceId: "HF-01" });
  const calls = [];
  let el = card(cardModel(b, [la, b]), { layout: "script" }, stubActions(calls));
  const rm = byText(el, "Remove this version");
  assert.match(rm.className, /ghost/);
  click(rm);
  assert.deepEqual(calls.at(-1), ["askRemove", "HF-02"]);
  assert.equal(byText(el, "Remove"), undefined);
  el = card(cardModel(b, [la, b], { confirmRemove: true }), { layout: "script" }, stubActions(calls));
  const row = all(el, (x) => String(x.className).split(" ").includes("confirm"))[0];
  assert.ok(row);
  assert.match(textOf(row), /Remove HF-02 from the review\? Its takes stay on disk\./);
  click(byText(row, "Remove"));
  assert.deepEqual(calls.at(-1), ["removeVersion", "HF-02"]);
  click(byText(row, "Cancel"));
  assert.deepEqual(calls.at(-1), ["cancelRemove"]);
  assert.equal(byText(el, "Remove this version"), undefined);
  // Disabled while a take runs.
  const busy = { ...b, takes: [take(1, "running")], chosen: 1 };
  el = card(cardModel(busy, [la, busy]), { layout: "script" }, stubActions(calls));
  assert.equal(byText(el, "Remove this version").disabled, true);
}));

test("card DOM: a blender take's checks show the last still and the notes", () => withDom(() => {
  const la = asset({ id: "HF-01", approved: true });
  const b = asset({ id: "HF-02", kind: "blender", tool: "blender", sourceId: "HF-01",
    takes: [take(1, "done", { file: "a.mp4", checks: CHECKS })], chosen: 1 });
  const el = card(cardModel(b, [la, b]), { layout: "script" }, stubActions());
  const box = all(el, (x) => String(x.className).split(" ").includes("checks3d"))[0];
  assert.ok(box);
  const img = all(box, (x) => x.tag === "img")[0];
  assert.equal(img.src, "blob:S:\\f\\HF-02_t1_check2.png");
  const items = all(box, (x) => x.tag === "li").map(textOf);
  assert.equal(items.length, 2);
  assert.match(items[0], /^Check 1 \(fixed\): Made the top slab thicker/);
  assert.equal(items[1], "Check 2 (matched): Matches the drawing.");
}));

// ---- Score and sound effects ----
import { audioModel } from "../js/ui/audio.js";
import { nodeSig } from "../js/tools/elevenlabs.js";

const score = (o = {}) => ({ id: "SCORE", cue: "Score", prompt: "Dark ambient. Energy arc: 0:00 drone", durationS: 372, takes: [], chosen: null, approved: false, node: null, est: null, ...o });
const cue = (o = {}) => ({ id: "SFX-01", cue: "door creak", prompt: "an old door creaks", durationS: 4, loop: false, source: "stableaudio", takes: [], chosen: null, approved: false, node: null, est: null, ...o });
const sa = (state = "off", message = null) => ({ state, message });

test("audio: nothing planned yet needs a plan", () => {
  assert.equal(audioModel(undefined, { sa: sa() }).needsPlan, true);
  assert.equal(audioModel({ flowId: null, score: null, sfx: [] }, { sa: sa() }).needsPlan, true);
  assert.equal(audioModel({ score: score(), sfx: [] }, { sa: sa() }).needsPlan, false);
});

test("audio: the score on ElevenLabs shows 2 takes at twice the current estimate", () => {
  const s = score();
  const fresh = audioModel({ score: { ...s, est: { credits: 6149, sig: nodeSig("score", s) } }, sfx: [] }, { sa: sa() }).score;
  assert.equal(fresh.source, "elevenlabs");
  assert.equal(fresh.sourceLabel, "ElevenLabs");
  assert.equal(fresh.generateLabel, "Generate 2 takes · about 12298 credits");
  assert.equal(fresh.canGenerate, true);
  assert.equal(fresh.estStale, false);
  const stale = audioModel({ score: { ...s, est: { credits: 6149, sig: "old" } }, sfx: [] }, { sa: sa() }).score;
  assert.equal(stale.generateLabel, "Get the cost");
  assert.equal(stale.canGenerate, false);
  assert.equal(stale.estStale, true);
  assert.equal(stale.est, null);
});

test("audio: getting the cost shows only while that card's estimate runs", () => {
  const m = audioModel({ score: score(), sfx: [] }, { sa: sa(), pending: new Set(["SCORE"]), estimating: new Set(["SCORE"]) }).score;
  assert.equal(m.generateLabel, "Getting the cost…");
  assert.equal(m.canGenerate, false);
  const saving = audioModel({ score: score(), sfx: [] }, { sa: sa(), pending: new Set(["SCORE"]) }).score;
  assert.equal(saving.generateLabel, "Get the cost", "another card action (a prompt save) is not getting the cost");
  assert.equal(saving.canGetCost, false);
});

test("audio: typed text is cleared only after the save succeeds", async () => {
  const { saveTyped } = await import("../js/ui/audio.js");
  const make = (result) => {
    const fields = new Map([["k", "new words"]]);
    const calls = [];
    let release;
    const done = new Promise((r) => { release = r; });
    const actions = { field: (k) => fields.get(k), setField: (k, v) => (v === undefined ? fields.delete(k) : fields.set(k, v)),
      editAudio: (id, patch) => { calls.push([id, patch]); return done.then(() => result); } };
    return { fields, calls, actions, release };
  };
  const ok = make(true);
  const p = saveTyped(ok.actions, "SFX-01", "k", "new words", "old", { prompt: "new words" });
  assert.equal(ok.fields.get("k"), "new words", "still shows the typed text while saving");
  ok.release(); assert.equal(await p, true);
  assert.deepEqual(ok.calls, [["SFX-01", { prompt: "new words" }]]);
  assert.equal(ok.fields.has("k"), false);

  const bad = make(false);
  const q = saveTyped(bad.actions, "SFX-01", "k", "new words", "old", { prompt: "new words" });
  bad.release(); assert.equal(await q, false);
  assert.equal(bad.fields.get("k"), "new words", "a failed save keeps the typed text");

  const more = make(true);
  const r = saveTyped(more.actions, "SFX-01", "k", "new words", "old", { prompt: "new words" });
  more.fields.set("k", "new words and more");
  more.release(); await r;
  assert.equal(more.fields.get("k"), "new words and more", "text typed during the save is kept");

  const same = make(true);
  assert.equal(await saveTyped(same.actions, "SFX-01", "k", "4", 4, { durationS: 4 }), true);
  assert.equal(same.calls.length, 0);
  assert.equal(same.fields.has("k"), false);
});

test("audio: an ElevenLabs cue is one take at the estimate", () => {
  const c = cue({ source: "elevenlabs", loop: true });
  const m = audioModel({ score: null, sfx: [{ ...c, est: { credits: 80, sig: nodeSig("sfx", c) } }] }, { sa: sa() }).sfx[0];
  assert.equal(m.generateLabel, "Generate take · about 80 credits");
  assert.equal(m.canGenerate, true);
  assert.equal(m.loopShown, true);
});

test("audio: a Stable Audio cue is free", () => {
  const m = audioModel({ score: score(), sfx: [cue()] }, { sa: sa() }).sfx[0];
  assert.equal(m.generateLabel, "Generate take · Free");
  assert.equal(m.canGenerate, true);
  assert.equal(m.sourceLabel, "Stable Audio");
  assert.equal(m.loopShown, false);
});

test("audio: a quiet take gets its chip, the playing file is marked, levels read plainly", () => {
  const takes = [
    { n: 1, source: "stableaudio", prompt: "p", status: "done", file: "a.wav", lengthS: 4, peakDb: -5.2, meanDb: -20, quiet: false },
    { n: 2, source: "stableaudio", prompt: "p", status: "done", file: "b.wav", lengthS: 4, peakDb: -40, meanDb: -60, quiet: true },
  ];
  const m = audioModel({ score: score(), sfx: [cue({ takes, chosen: 2 })] }, { sa: sa(), playing: "b.wav" }).sfx[0];
  assert.equal(m.takes[0].meta, "4.0 s · peak -5 dB");
  assert.equal(m.takes[0].chip, null);
  assert.equal(m.takes[0].playing, false);
  assert.equal(m.takes[1].chip, "Near-silent");
  assert.equal(m.takes[1].playing, true);
  assert.equal(m.takes[1].chosen, true);
  assert.equal(m.canApprove, true);
});

test("audio: Stable Audio chip labels and Start", () => {
  const lbl = (s) => audioModel({ score: score(), sfx: [] }, { sa: sa(s) }).sa;
  assert.equal(lbl("off").label, "Off");
  assert.equal(lbl("starting").label, "Starting…");
  assert.equal(lbl("starting").canStart, false);
  assert.equal(lbl("ready").label, "Ready");
  assert.equal(lbl("ready").canStart, false);
  assert.equal(lbl("music").label, "Music model loaded");
  assert.equal(lbl("failed").label, "Didn't start");
  assert.equal(lbl("failed").canStart, true);
});

test("audio: a busy take blocks generate, approve and edits; a pending note shows", () => {
  const takes = [{ n: 1, source: "stableaudio", prompt: "p", status: "running" }];
  const m = audioModel({ score: score(), sfx: [cue({ takes, chosen: 1, pendingNote: "drier" })] }, { sa: sa() }).sfx[0];
  assert.equal(m.busy, true);
  assert.equal(m.canGenerate, false);
  assert.equal(m.canApprove, false);
  assert.equal(m.canEdit, false);
  assert.equal(m.nextNote, "Next take: from your note “drier”");
});

test("review model carries the audio sections, with or without a shot list", () => {
  const f = film();
  const a = reviewModel({ film: f, state: { assets: [] }, sa: sa() });
  assert.equal(a.audio.needsPlan, true);
  const b = reviewModel({ film: f, state: { assets: [asset()], audio: { score: score(), sfx: [cue()] } }, sa: sa("ready") });
  assert.equal(b.audio.needsPlan, false);
  assert.equal(b.audio.sa.label, "Ready");
  assert.equal(b.audio.sfx.length, 1);
});

test("live jobs: ElevenLabs never offers Run again, but checks when it has a job ref; Stable Audio runs again", () => {
  const m = jobsModel({ jobs: [
    job({ id: "a", assetId: "SCORE", tool: "elevenlabs", status: "failed", error: "x", jobRef: "F1", ambiguous: true }),
    job({ id: "b", assetId: "SFX-01", tool: "elevenlabs", status: "interrupted" }),
    job({ id: "c", assetId: "SFX-02", tool: "stableaudio", lane: "gpu", status: "failed", error: "y" }),
  ], log: null, retried: new Set() });
  const by = Object.fromEntries(m.rows.map((r) => [r.id, r]));
  assert.equal(by.a.tool, "ElevenLabs");
  assert.equal(by.a.canCheck, true);
  assert.equal(by.a.canRetry, false);
  assert.equal(by.a.retryNote, "Make a new take from its card");
  assert.equal(by.a.warning, "Check ElevenLabs first: this take may still be running.");
  assert.equal(by.b.canCheck, false);
  assert.equal(by.b.canRetry, false);
  assert.equal(by.c.tool, "Stable Audio");
  assert.equal(by.c.canRetry, true);
  assert.equal(by.c.retryLabel, "Run again");
  assert.equal(by.c.retryNote, null);
  assert.equal(by.c.canCheck, false);
});

test("audio: a running take does not hide check again on a different failed take; the same take does", () => {
  const aj = (o) => job({ tool: "elevenlabs", assetId: "SFX-01", ...o });
  const m = jobsModel({ jobs: [
    aj({ id: "a", take: 1, status: "failed", error: "x", jobRef: "R1" }),
    aj({ id: "b", take: 2, status: "running" }),
    aj({ id: "c", assetId: "SCORE", take: 1, status: "failed", error: "x", jobRef: "R2" }),
    aj({ id: "d", assetId: "SCORE", take: 2, status: "queued" }),
    aj({ id: "e", assetId: "SFX-02", take: 1, status: "failed", error: "x", jobRef: "R3" }),
    aj({ id: "f", assetId: "SFX-02", take: 1, status: "running" }),
  ], log: null, retried: new Set() });
  const by = Object.fromEntries(m.rows.map((r) => [r.id, r]));
  assert.equal(by.a.canCheck, true);
  assert.equal(by.c.canCheck, true);
  assert.equal(by.e.canCheck, false, "a later job for the same take supersedes");
  const sa = jobsModel({ jobs: [
    aj({ id: "g", tool: "stableaudio", take: 1, status: "failed", error: "x" }),
    aj({ id: "h", tool: "stableaudio", take: 2, status: "running" }),
  ], log: null, retried: new Set() });
  assert.equal(sa.rows.find((r) => r.id === "g").canRetry, true);
});

test("the card shows the start time as m:ss.s, or Not placed yet", () => {
  const c = { id: "SFX-01", cue: "door creak", prompt: "p", durationS: 3, takes: [], source: "stableaudio" };
  const m = audioModel({ score: null, sfx: [c, { ...c, id: "SFX-02", startS: 65.3 }] }, { sa: { state: "off" } }).sfx;
  assert.equal(m[0].startText, "");
  assert.equal(m[0].placedNote, "Not placed yet");
  assert.equal(m[1].startText, "1:05.3");
  assert.equal(m[1].placedNote, null);
});

// ---- Voiceover and mix ----
import { mixModel } from "../js/ui/mix.js";
import { OUT_OF_DATE } from "../js/mixplan.js";

const VOW = "S:\\f\\studio\\voiceover\\f_voiceover.wav";
const FITW = "S:\\f\\studio\\mix\\f_score_fitted.wav";
const SC1 = "S:\\f\\studio\\media\\f_score_t1.wav";
const nrow = (id, status, o = {}) => ({ id, section: "Opening", text: "one two three four five", status, flags: [], notes: [], file: status === "missing" ? undefined : `S:\\rec\\f_${id}.wav`, takeS: 100, ...o });
const narr = (rows) => ({ project: "f", rows, counts: { total: rows.length, recorded: rows.filter((r) => r.status !== "missing").length, ok: rows.filter((r) => r.status === "ok").length, jon: rows.filter((r) => r.status === "jon").length, flagged: rows.filter((r) => r.status === "flagged").length, unchecked: 0 } });
const goodNarr = () => narr([nrow("01.1", "ok"), nrow("01.2", "jon"), nrow("02.1", "ok")]);
const approvedScore = () => score({ approved: true, chosen: 1, takes: [{ n: 1, status: "done", file: SC1 }] });
const vo = (o = {}) => ({ id: "VOICEOVER", status: "done", at: 200_000, wav: VOW, csv: "S:\\f\\t.csv", lengthS: 362, tightened: [{ id: "01.2", at_s: 1.2, from_s: 0.9, to_s: 0.3 }], extra: [], silent: [], takes: [{ n: 1, status: "done" }], ...o });
const SHEET = { rows: [{ section: "Opening", targetS: 6, landsS: 6.4, missS: 0.4, noMove: false }, { section: "The dig", targetS: 95.2, landsS: null, missS: null, noMove: true }, { section: "The end", targetS: 300, landsS: 292.8, missS: -7.2, noMove: false }], worstS: 7.2, suggestNewTake: true, missing: ["The dig"] };
const TARGETS = { filmS: 380.5, sections: [{ name: "Opening", startS: 6 }, { name: "The dig", startS: 95.2 }, { name: "The end", startS: 300 }] };
const fitH = (o = {}) => ({ id: "FIT", status: "done", at: 300_000, file: FITW, sheet: SHEET, targets: TARGETS, plan: { steps: [], notes: "Cut the middle." }, source: "app", scoreFile: SC1, fromVoiceoverAt: 200_000, fromScoreTake: 1, lengthS: 380.5, takes: [{ n: 1, status: "done" }], ...o });
const MIXF = { wav: "S:\\f\\studio\\mix\\f_mix.wav", mp3: "S:\\f\\studio\\mix\\f_mix_preview.mp3", voice: "S:\\f\\studio\\mix\\f_voice_stem.flac", music: "S:\\f\\studio\\mix\\f_music_stem.flac" };
const mixH = (o = {}) => ({ id: "MIX", status: "done", at: 400_000, files: MIXF, unplaced: ["SFX-02"], approved: false, fromFitAt: 300_000, fromVoiceoverAt: 200_000, fromSfx: [], takes: [{ n: 1, status: "done" }], ...o });
const mstate = (mix = {}, o = {}) => ({ assets: [], audio: { score: approvedScore(), sfx: [] }, mix: { voiceover: null, fit: null, mix: null, ...mix }, ...o });
const mm = (state, o = {}) => mixModel({ state, narration: goodNarr(), settings: { stemRemixer: true }, ...o });
const step = (m, id) => m.steps.find((x) => x.id === id);

test("mix: before anything, join is ready and fit and mix say what they wait for", () => {
  const m = mm(mstate());
  const j = step(m, "VOICEOVER"), f = step(m, "FIT"), x = step(m, "MIX");
  assert.equal(j.state, "ready");
  assert.equal(j.run.label, "Join voiceover");
  assert.equal(j.run.allowFlagged, false);
  assert.equal(j.run.enabled, true);
  assert.equal(j.counts, "3 of 3 recorded · 2 ok · 1 OK by Jon");
  assert.equal(f.state, "locked");
  assert.equal(f.statusText, "Waits for the voiceover join.");
  assert.equal(f.run.enabled, false);
  assert.equal(x.state, "locked");
  assert.equal(x.statusText, "Waits for the score fit.");
});

test("mix: flagged, unchecked and outdated lines make it Join anyway (N not OK) with each id's status; OK by Jon counts as fine", () => {
  const m = mm(mstate(), { narration: narr([nrow("01.1", "flagged"), nrow("01.2", "jon"), nrow("02.1", "unchecked"), nrow("02.2", "outdated"), nrow("03.1", "ok")]) });
  const j = step(m, "VOICEOVER");
  assert.equal(j.state, "ready");
  assert.equal(j.run.label, "Join anyway (3 not OK)");
  assert.equal(j.run.allowFlagged, true);
  assert.equal(j.flagged, "Not OK: 01.1 flagged, 02.1 unchecked, 02.2 outdated");
  const one = step(mm(mstate(), { narration: narr([nrow("01.1", "unchecked"), nrow("01.2", "ok")]) }), "VOICEOVER");
  assert.equal(one.run.label, "Join anyway (1 not OK)");
  assert.equal(one.flagged, "Not OK: 01.1 unchecked");
  const err = step(mm(mstate(), { narration: narr([nrow("01.1", "error"), nrow("01.2", "ok")]) }), "VOICEOVER");
  assert.equal(err.run.label, "Join anyway (1 not OK)");
});

test("mix: a done join lists the lines that had two takes and which file it used", () => {
  const dup = [{ id: "05.2", files: ["S:\\rec\\f_05.2.wav", "S:\\rec\\old\\f_05.2.wav"] }, { id: "06.1", files: ["S:\\rec\\a\\f_06.1.wav", "S:\\rec\\b\\f_06.1.wav", "S:\\rec\\c\\f_06.1.wav"] }];
  const j = step(mm(mstate({ voiceover: vo({ duplicates: dup }) })), "VOICEOVER");
  assert.deepEqual(j.details.slice(-2), ["Two takes for 05.2; used f_05.2.wav", "Three takes for 06.1; used f_06.1.wav"]);
});

test("mix: a missing take locks the join with Record these first", () => {
  const m = mm(mstate(), { narration: narr([nrow("01.1", "ok"), nrow("01.2", "missing"), nrow("03.1", "missing")]) });
  const j = step(m, "VOICEOVER");
  assert.equal(j.state, "locked");
  assert.equal(j.statusText, "Record these first: 01.2, 03.1");
  assert.equal(j.run.enabled, false);
  const none = mm(mstate(), { narration: null });
  assert.equal(step(none, "VOICEOVER").state, "locked");
  assert.equal(step(none, "VOICEOVER").statusText, "Waiting for the Narration list.");
});

test("mix: running steps show their progress and block their button", () => {
  const s = mstate({ voiceover: { id: "VOICEOVER", status: "running", jobId: "jv", takes: [{ n: 1, status: "running", jobId: "jv" }] } });
  const j = step(mm(s, { jobs: [{ id: "jv", status: "running", progress: 0.42 }] }), "VOICEOVER");
  assert.equal(j.state, "running");
  assert.equal(j.statusText, "Joining… 42%");
  assert.equal(j.run.enabled, false);
  const q = step(mm(mstate({ voiceover: { id: "VOICEOVER", status: "queued", takes: [{ n: 1, status: "queued" }] } })), "VOICEOVER");
  assert.equal(q.statusText, "Queued");
  const f = step(mm(mstate({ voiceover: vo() }), { pending: new Set(["FIT"]) }), "FIT");
  assert.equal(f.state, "running");
  assert.equal(f.statusText, "Working…");
  const x = step(mm(mstate({ voiceover: vo(), fit: fitH(), mix: { id: "MIX", status: "running", jobId: "jm", takes: [{ n: 1, status: "running" }] } }), { jobs: [{ id: "jm", status: "running", progress: 0.5 }] }), "MIX");
  assert.equal(x.statusText, "Mixing… 50%");
});

test("mix: a done join shows its length against the estimate, ▶ and the stalls tightened", () => {
  const m = mm(mstate({ voiceover: vo({ extra: ["stray.wav"], silent: ["02.1"] }) }), { playing: VOW });
  const j = step(m, "VOICEOVER");
  assert.equal(j.state, "done");
  assert.equal(j.lengthText, "6:02 (the script estimate is 0:06)");
  assert.equal(j.file, VOW);
  assert.equal(j.playing, true);
  assert.deepEqual(j.details, ["Stall tightened: 01.2, 0.9 s to 0.3 s", "Takes that match no line: stray.wav", "No speech found, joined as silence: 02.1"]);
  assert.equal(j.run.label, "Join again");
  const f = step(m, "FIT");
  assert.equal(f.state, "ready");
  assert.equal(f.run.label, "Fit score");
});

test("mix: a take recorded after the join makes the join out of date", () => {
  const n = narr([nrow("01.1", "ok", { takeS: 250 }), nrow("01.2", "ok")]);
  const j = step(mm(mstate({ voiceover: vo() }), { narration: n }), "VOICEOVER");
  assert.equal(j.state, "stale");
  assert.equal(j.statusText, OUT_OF_DATE);
  assert.equal(j.run.enabled, true);
});

test("mix: the fit waits for an approved score and for the Stem Remixer folder", () => {
  const noScore = mstate({ voiceover: vo() }, { audio: { score: score(), sfx: [] } });
  assert.equal(step(mm(noScore), "FIT").statusText, "Waits for an approved score take (Score card).");
  const noDir = step(mm(mstate({ voiceover: vo() }), { settings: { stemRemixer: false } }), "FIT");
  assert.equal(noDir.state, "locked");
  assert.match(noDir.statusText, /stemRemixerDir/);
});

test("mix: a done fit shows the sheet table, the suggestion line and the hand-tweak buttons", () => {
  const f = step(mm(mstate({ voiceover: vo(), fit: fitH() })), "FIT");
  assert.equal(f.state, "done");
  assert.deepEqual(f.sheet, [
    { section: "Opening", target: "0:06", lands: "0:06", miss: "+0.4 s" },
    { section: "The dig", target: "1:35", lands: "no move found", miss: "" },
    { section: "The end", target: "5:00", lands: "4:53", miss: "-7.2 s" },
  ]);
  assert.equal(f.suggestion, "A big move is still 7.2 s off. A new score take may fit better (Score card).");
  assert.equal(f.notes, "Cut the middle.");
  assert.equal(f.file, FITW);
  assert.equal(f.run.label, "Fit again with a note");
  assert.equal(f.canOpen, true);
  assert.equal(f.canUseExport, true);
  const ok = step(mm(mstate({ voiceover: vo(), fit: fitH({ sheet: { ...SHEET, suggestNewTake: false, worstS: 0.4 } }) })), "FIT");
  assert.equal(ok.suggestion, null);
  const sr = step(mm(mstate({ voiceover: vo(), fit: fitH({ source: "stemremixer", file: "C:\\sr\\my export.wav" }) })), "FIT");
  assert.equal(sr.sourceText, "Using your Stem Remixer export: my export.wav");
  assert.equal(step(mm(mstate({ voiceover: vo(), fit: fitH() })), "MIX").state, "ready");
});

test("mix: a fit from an older join or another score take is out of date, and so is the mix", () => {
  const s = mstate({ voiceover: vo({ at: 250_000 }), fit: fitH(), mix: mixH({ approved: true }) });
  const m = mm(s);
  const f = step(m, "FIT"), x = step(m, "MIX");
  assert.equal(f.state, "stale");
  assert.equal(f.statusText, OUT_OF_DATE);
  assert.equal(f.run.label, "Fit again");
  assert.equal(f.run.enabled, true);
  assert.equal(x.state, "stale");
  assert.equal(x.statusText, OUT_OF_DATE);
  assert.equal(x.approved, false, "an old approval is not shown as approved");
  assert.equal(x.canApprove, false);
  assert.equal(x.approvalNote, "The approval was for an earlier mix.");
  assert.equal(x.run.enabled, false, "the fit must be run again first");
  assert.equal(x.lock, "Waits for the score fit to be run again.");
});

test("mix: a done mix shows the player, the section marks, the files and Approve mix", () => {
  const x = step(mm(mstate({ voiceover: vo(), fit: fitH(), mix: mixH() })), "MIX");
  assert.equal(x.state, "done");
  assert.equal(x.player, MIXF.mp3);
  assert.deepEqual(x.marks, [{ t: 6, label: "0:06 Opening" }, { t: 95.2, label: "1:35 The dig" }, { t: 300, label: "5:00 The end" }]);
  assert.deepEqual(x.files.map((f) => f.name), ["f_mix.wav", "f_mix_preview.mp3", "f_voice_stem.flac", "f_music_stem.flac"]);
  assert.equal(x.unplaced, "Not placed (no start time): SFX-02");
  assert.equal(x.canApprove, true);
  assert.equal(x.run.label, "Make mix again");
  const a = step(mm(mstate({ voiceover: vo(), fit: fitH(), mix: mixH({ approved: true }) })), "MIX");
  assert.equal(a.approved, true);
  assert.equal(a.canApprove, false);
  const r = step(mm(mstate({ voiceover: vo(), fit: fitH() })), "MIX");
  assert.equal(r.run.label, "Make mix preview");
});

test("mix: an interrupted or failed step says so and can run again", () => {
  const i = step(mm(mstate({ voiceover: { id: "VOICEOVER", status: "interrupted", error: "Interrupted", takes: [{ n: 1, status: "interrupted" }] } })), "VOICEOVER");
  assert.equal(i.state, "interrupted");
  assert.equal(i.statusText, "Interrupted; run it again.");
  assert.equal(i.run.enabled, true);
  const lost = step(mm(mstate({ voiceover: vo(), fit: { id: "FIT", status: "failed", error: "Interrupted; run it again.", takes: [{ n: 1, status: "failed" }] } })), "FIT");
  assert.equal(lost.state, "interrupted");
  const bad = step(mm(mstate({ voiceover: vo(), fit: { id: "FIT", status: "failed", error: "fit.py said no", takes: [{ n: 1, status: "failed" }] } })), "FIT");
  assert.equal(bad.state, "failed");
  assert.equal(bad.statusText, "Failed: fit.py said no");
  assert.equal(bad.run.label, "Fit again");
});

test("mix: card errors, the export list and the open message reach the model", () => {
  const m = mm(mstate({ voiceover: vo(), fit: fitH() }), { cardErrors: new Map([["FIT", "boom"]]), ui: { exports: { files: [{ path: "C:\\sr\\b.wav", name: "b.wav", when: 2 }, { path: "C:\\sr\\a.mp3", name: "a.mp3", when: 1 }], pick: "C:\\sr\\b.wav" }, opened: "Opened in Stem Remixer" } });
  const f = step(m, "FIT");
  assert.equal(f.error, "boom");
  assert.deepEqual(f.exports.files.map((x) => [x.name, x.picked]), [["b.wav", true], ["a.mp3", false]]);
  assert.equal(f.opened, "Opened in Stem Remixer");
  assert.equal(f.confirm, null);
  const c = step(mm(mstate({ voiceover: vo(), fit: fitH() }), { ui: { confirm: { path: "C:\\sr\\b.wav", text: "This export is 1.8 s longer than the film. Use it anyway?" } } }), "FIT");
  assert.deepEqual(c.confirm, { path: "C:\\sr\\b.wav", text: "This export is 1.8 s longer than the film. Use it anyway?" });
  assert.equal(reviewModel({ film: film(), state: mstate(), sa: sa(), narration: goodNarr() }).mix.steps.length, 3);
});

test("audio: Starts at is always sent, so a retyped time marks it Jon's; it stays editable while busy", async () => {
  const { saveTyped } = await import("../js/ui/audio.js");
  const calls = [];
  const fields = new Map([["k", "1:05.3"]]);
  const actions = { field: (k) => fields.get(k), setField: (k, v) => (v === undefined ? fields.delete(k) : fields.set(k, v)), editAudio: async (id, p) => { calls.push(p); return true; } };
  assert.equal(await saveTyped(actions, "SFX-01", "k", "1:05.3", "1:05.3", { startS: "1:05.3" }, { always: true }), true);
  assert.deepEqual(calls, [{ startS: "1:05.3" }]);
  const takes = [{ n: 1, source: "stableaudio", prompt: "p", status: "running" }];
  const m = audioModel({ score: score(), sfx: [cue({ takes, chosen: 1 })] }, { sa: sa() }).sfx[0];
  assert.equal(m.canEdit, false);
  assert.equal(m.canEditStart, true);
});

test("mix: a stale join makes the fit and mix out of date and blocks Approve mix", () => {
  // The take was saved during the join: after it started (190 s) but before it ended (200 s).
  const n = narr([nrow("01.1", "ok", { takeS: 195 }), nrow("01.2", "ok")]);
  const m = mm(mstate({ voiceover: vo({ startedAt: 190_000 }), fit: fitH(), mix: mixH() }), { narration: n });
  const [j, f, x] = m.steps;
  assert.equal(j.state, "stale");
  assert.equal(f.state, "stale");
  assert.equal(f.statusText, OUT_OF_DATE);
  assert.equal(f.lock, "Waits for the voiceover join to be run again.");
  assert.equal(f.run.enabled, false);
  assert.equal(f.canUseExport, false);
  assert.equal(x.state, "stale");
  assert.equal(x.statusText, OUT_OF_DATE);
  assert.equal(x.lock, "Waits for the voiceover join to be run again.");
  assert.equal(x.canApprove, false);
  assert.equal(x.run.enabled, false);
  // Before the join started: still current.
  const ok = mm(mstate({ voiceover: vo({ startedAt: 190_000 }), fit: fitH(), mix: mixH() }), { narration: narr([nrow("01.1", "ok", { takeS: 189 })]) });
  assert.deepEqual(ok.steps.map((s) => s.state), ["done", "done", "done"]);
  assert.equal(ok.steps[2].canApprove, true);
});

test("mix: the player is keyed on the file and the mix run, so a new run gets a new player", async () => {
  const { playerKey, keepPlayer } = await import("../js/ui/mix.js");
  const a = step(mm(mstate({ voiceover: vo(), fit: fitH(), mix: mixH() })), "MIX").playerKey;
  const b = step(mm(mstate({ voiceover: vo(), fit: fitH(), mix: mixH({ at: 500_000 }) })), "MIX").playerKey;
  assert.equal(a, playerKey(MIXF.mp3, 400_000));
  assert.notEqual(a, b);
  const el = {};
  assert.equal(keepPlayer({ key: a, el }, a), true);
  assert.equal(keepPlayer({ key: a, el }, b), false);
  assert.equal(keepPlayer({ key: a, el: null }, a), false);
});

test("mix: one Re-record line makes it Join anyway (1 not OK)", () => {
  const j = step(mm(mstate(), { narration: narr([nrow("01.1", "rerecord"), nrow("01.2", "ok")]) }), "VOICEOVER");
  assert.equal(j.run.label, "Join anyway (1 not OK)");
  assert.equal(j.flagged, "Not OK: 01.1 rerecord");
});

test("mix: a ticked missing line still locks Join", async () => {
  const { withRerecord } = await import("../js/pacing.js");
  const n = withRerecord(narr([nrow("01.1", "missing"), nrow("01.2", "ok")]), { lines: { "01.1": { rerecord: { at: 5 } } } });
  const j = step(mm(mstate(), { narration: n }), "VOICEOVER");
  assert.match(j.lock, /^Record these first: 01\.1/);
});

test("cardModel checks: each label carries its verdict; a third-round fix was not applied", () => {
  const la = asset({ id: "HF-01", approved: true });
  const checks = [
    { round: 1, still: "S:\\f\\c1.png", verdict: "blank", note: "all navy" },
    { round: 2, still: "S:\\f\\c2.png", verdict: "fix", note: "moved the camera" },
    { round: 3, still: "S:\\f\\c3.png", verdict: "fix", note: "thicker slab" },
  ];
  const b = asset({ id: "HF-02", kind: "blender", tool: "blender", sourceId: "HF-01", takes: [take(1, "done", { file: "a.mp4", checks })], chosen: 1 });
  assert.deepEqual(cardModel(b, [la, b]).checks.notes.map((n) => n.label), ["Check 1 (blank)", "Check 2 (fixed)", "Check 3 (not applied)"]);
  const m = { ...b, takes: [take(1, "done", { file: "a.mp4", checks: [checks[0], checks[1], { ...checks[2], verdict: "matches" }] })] };
  assert.equal(cardModel(m, [la, m]).checks.notes[2].label, "Check 3 (matched)");
});

test("live jobs: a job whose shot was removed offers neither Run again nor Check again", () => {
  const m = jobsModel({ jobs: [
    job({ id: "a", status: "failed", tool: "blender", assetId: "HF-09" }),
    job({ id: "b", status: "interrupted", tool: "comfyui", assetId: "HF-10", jobRef: "p1" }),
    job({ id: "c", status: "failed", tool: "blender", assetId: "HF-11" }),
  ], log: null, retried: new Set(), gone: new Map([["a", "HF-09 was removed from the review."], ["b", "HF-10 was removed from the review."]]) });
  const by = Object.fromEntries(m.rows.map((r) => [r.id, r]));
  assert.equal(by.a.canRetry, false);
  assert.equal(by.a.retryNote, "HF-09 was removed from the review.");
  assert.equal(by.b.canCheck, false);
  assert.equal(by.b.canRetry, false);
  assert.equal(by.b.retryNote, "HF-10 was removed from the review.");
  assert.equal(by.c.canRetry, true);
  assert.equal(by.c.retryNote, null);
});

test("filmRow: Open script for a film at part 1 with a Part 1 state; part 2 still Open review", () => {
  const base = { dir: "S:\\x\\A", title: "A", number: null, waiting: null };
  const p = (a, b, c, d) => ({ 1: a, 2: b, 3: c, shorts: d });
  const row = filmRow({ ...base, parts: p("now", "none", "none", "none"), part1: "draft" }, []);
  assert.deepEqual(row.button, { label: "Open script", primary: true });
  assert.equal(filmRow({ ...base, parts: p("now", "none", "none", "none"), part1: null }, []).button, null);
  assert.equal(filmRow({ ...base, parts: p("done", "now", "none", "none"), part1: null }, []).button.label, "Open review");
});

// ---- a laptop sends graphics jobs to the desktop ----
import { MAKE_ON_DESKTOP } from "../js/labels.js";

test("laptop: a ComfyUI shot's first take reads Make on the desktop and is enabled; Higgsfield is unchanged", () => withDom(() => {
  assert.equal(MAKE_ON_DESKTOP, "Make on the desktop");
  const comfy = asset({ id: "HF-03", kind: "broll", tool: "comfyui" });
  let c = cardModel(comfy, [comfy], { role: "laptop" });
  assert.equal(c.canMakeFirst, true);
  assert.equal(c.onDesktop, MAKE_ON_DESKTOP);
  let el = card(c, { layout: "script" }, stubActions());
  const b = byText(el, MAKE_ON_DESKTOP);
  assert.ok(b);
  assert.ok(!b.disabled);
  assert.equal(byText(el, "Make first take"), undefined);
  // Set up on this laptop: the desktop behaviour.
  c = cardModel(comfy, [comfy], { role: "laptop", localTools: ["comfyui"] });
  assert.equal(c.canMakeFirst, true);
  assert.equal(c.onDesktop, null);
  assert.ok(byText(card(c, { layout: "script" }, stubActions()), "Make first take"));
  c = cardModel(comfy, [comfy], { role: "desktop" });
  assert.equal(c.canMakeFirst, true);
  assert.equal(c.onDesktop, null);
  const hf = asset({ id: "HF-04", kind: "broll", tool: "higgsfield" });
  c = cardModel(hf, [hf], { role: "laptop" });
  assert.equal(c.canMakeFirst, true);
  assert.equal(c.onDesktop, null);
}));

test("laptop: Redo, Make 3D and Animate are enabled for the desktop; Animate skips the i2v check", () => withDom(() => {
  const la = asset({ id: "HF-01", approved: true, takes: [take(1, "done", { file: "a.png" })], chosen: 1 });
  const b = asset({ id: "HF-02", kind: "blender", tool: "blender", sourceId: "HF-01", takes: [take(1, "done", { file: "a.mp4" })], chosen: 1 });
  const c = cardModel(b, [la, b], { role: "laptop" });
  assert.equal(c.canRedo, true);
  let el = card(c, { layout: "script" }, stubActions());
  assert.ok(byText(el, "Approve"));
  assert.ok(byText(el, "Redo…"));
  const lc = cardModel(la, [la], { role: "laptop", i2v: { ok: false } });
  assert.equal(lc.can3d, true);
  assert.equal(lc.canAnimate, true);
  assert.equal(lc.animateWhy, "Made on the desktop");
  assert.equal(lc.why3d, "Made on the desktop");
  el = card(lc, { layout: "script" }, stubActions());
  const an = byText(el, "Animate with ComfyUI");
  assert.ok(!an.disabled);
  assert.equal(an.attrs.title, "Made on the desktop");
  const m3 = byText(el, "Make 3D in Blender");
  assert.ok(!m3.disabled);
  assert.equal(m3.attrs.title, "Made on the desktop");
  // Set up here: Animate needs the local i2v check again.
  const loc = cardModel(la, [la], { role: "laptop", localTools: ["comfyui", "blender"], i2v: { ok: false } });
  assert.equal(loc.canAnimate, false);
  assert.equal(loc.animateWhy, MSG_I2V_SETUP);
  assert.equal(loc.can3d, true);
  assert.equal(loc.why3d, null);
}));

test("laptop: a Stable Audio item reads Make on the desktop and is enabled when ready; ElevenLabs is unchanged; reviewModel passes the role", () => {
  const m = audioModel({ score: null, sfx: [cue()] }, { sa: sa(), role: "laptop" }).sfx[0];
  assert.equal(m.generateLabel, MAKE_ON_DESKTOP);
  assert.equal(m.canGenerate, true);
  assert.equal(audioModel({ score: null, sfx: [cue({ prompt: "" })] }, { sa: sa(), role: "laptop" }).sfx[0].canGenerate, false);
  const l = audioModel({ score: null, sfx: [cue()] }, { sa: sa(), role: "laptop", localTools: ["stableaudio"] }).sfx[0];
  assert.equal(l.generateLabel, "Generate take · Free");
  const c = cue({ source: "elevenlabs" });
  const e = audioModel({ score: null, sfx: [{ ...c, est: { credits: 80, sig: nodeSig("sfx", c) } }] }, { sa: sa(), role: "laptop" }).sfx[0];
  assert.equal(e.generateLabel, "Generate take · about 80 credits");
  assert.equal(e.canGenerate, true);
  const comfy = asset({ id: "HF-03", kind: "broll", tool: "comfyui" });
  const rm = reviewModel({ film: { dir: DIR, title: "Skara Brae" }, state: { assets: [comfy], audio: { score: null, sfx: [cue()] } }, role: "laptop" });
  assert.equal(rm.cards[0].onDesktop, MAKE_ON_DESKTOP);
  assert.equal(rm.audio.sfx[0].generateLabel, MAKE_ON_DESKTOP);
  const rl = reviewModel({ film: { dir: DIR, title: "Skara Brae" }, state: { assets: [comfy], audio: { score: null, sfx: [cue()] } }, role: "laptop", localTools: ["comfyui", "stableaudio"] });
  assert.equal(rl.cards[0].onDesktop, null);
  assert.equal(rl.audio.sfx[0].generateLabel, "Generate take · Free");
});

test("jobRow: a desktop job made for a laptop names it and can't be retried or checked here", () => {
  const j = job({ id: "r1", tool: "comfyui", status: "failed", error: "boom", jobRef: "p1", from: "LAPTOP-JON", request: "LAPTOP-JON-j1" });
  const r = jobsModel({ jobs: [j], retried: new Set(), role: "desktop" }).rows[0];
  assert.equal(r.from, "from LAPTOP-JON");
  assert.equal(r.canRetry, false);
  assert.equal(r.retryNote, "Retry it from LAPTOP-JON");
  assert.equal(r.canCheck, false);
  assert.equal(jobsModel({ jobs: [job({ tool: "comfyui" })], retried: new Set() }).rows[0].from, null);
});

test("jobRow: a laptop graphics job waiting on the desktop can be withdrawn; Check only after an ambiguous failure", () => {
  const w = job({ id: "w", tool: "comfyui", status: "running", remote: "waiting", jobRef: "L-w" });
  assert.equal(jobsModel({ jobs: [w], retried: new Set(), role: "laptop" }).rows[0].canWithdraw, true);
  assert.equal(jobsModel({ jobs: [{ ...w, remote: "running" }], retried: new Set(), role: "laptop" }).rows[0].canWithdraw, false);
  assert.equal(jobsModel({ jobs: [{ ...w, status: "queued" }], retried: new Set(), role: "laptop" }).rows[0].canWithdraw, false);
  assert.equal(jobsModel({ jobs: [w], retried: new Set(), role: "desktop" }).rows[0].canWithdraw, false);
  const f = { ...w, status: "failed", error: "x", ambiguous: true };
  assert.equal(jobsModel({ jobs: [{ ...f, tool: "blender" }], retried: new Set(), role: "laptop" }).rows[0].canCheck, true);
  assert.equal(jobsModel({ jobs: [{ ...f, tool: "blender", ambiguous: false }], retried: new Set(), role: "laptop" }).rows[0].canCheck, false);
});

test("jobs view: the from tag and a Withdraw button", () => withDom(() => {
  const rows = (o) => jobsModel({ jobs: [job(o)], retried: new Set(), role: "laptop" });
  const acts = { check() {}, retry() {}, withdraw(id) { acts.got = id; } };
  const el = document.createElement("div");
  jobsRender(el, rows({ id: "w", tool: "comfyui", status: "running", remote: "waiting", jobRef: "L-w" }), acts);
  const b = byText(el, "Withdraw");
  assert.ok(b);
  for (const f of b.listeners.click) f({ currentTarget: b });
  assert.equal(acts.got, "w");
  const d = document.createElement("div");
  jobsRender(d, jobsModel({ jobs: [job({ tool: "comfyui", status: "failed", from: "LAPTOP-JON" })], retried: new Set(), role: "desktop" }), acts);
  assert.ok(byText(d, "from LAPTOP-JON") || JSON.stringify(d).includes("from LAPTOP-JON"));
}));
