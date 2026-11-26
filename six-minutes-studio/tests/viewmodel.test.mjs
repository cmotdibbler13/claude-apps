import { test } from "node:test";
import assert from "node:assert/strict";
import { filmRow, filmsModel } from "../js/ui/films.js";
import { activeCount, jobsModel } from "../js/ui/jobs.js";
import { summarize, cardModel, reviewModel, scriptCandidates } from "../js/ui/review.js";

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
