import { test } from "node:test";
import assert from "node:assert/strict";
import { presenceState } from "../js/linkstate.js";

const jobs = [
  { id: "a", lane: "gpu", status: "running" },
  { id: "b", lane: "gpu", status: "queued", from: "LAPTOP", request: "LAPTOP-b" },
  { id: "c", lane: "gpu", status: "done" },
  { id: "d", lane: "connector", status: "running" },
];

test("desktop: gpu jobs queued or running, the worker's waiting count, paused, tool states", () => {
  const s = presenceState({ role: "desktop", jobs, settings: { laptopJobs: "paused" }, counts: { waiting: 2, running: 1 }, tools: { comfyui: "ready", stableaudio: null } });
  assert.deepEqual(s, { paused: true, running: 2, waiting: 2, tools: { comfyui: "ready", stableaudio: null } });
});

test("desktop without a worker counts no waiting; not paused by default", () => {
  const s = presenceState({ role: "desktop", jobs: [], settings: { laptopJobs: "on" }, counts: null, tools: {} });
  assert.deepEqual(s, { paused: false, running: 0, waiting: 0, tools: {} });
});

test("laptop: its own remote waiting and running jobs", () => {
  const list = [
    { id: "a", status: "running", remote: "waiting" },
    { id: "b", status: "running", remote: "running" },
    { id: "c", status: "running", remote: "running" },
    { id: "d", status: "done", remote: "running" },
    { id: "e", status: "running" },
  ];
  assert.deepEqual(presenceState({ role: "laptop", jobs: list, settings: {}, counts: null, tools: {} }),
    { paused: false, running: 2, waiting: 1, tools: {} });
});
