import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.mjs";
import { setToolPaths, tool } from "../js/toolpaths.js";
import { measure } from "../js/audio.js";

afterEach(() => setToolPaths({}));

test("defaults are the bare names", () => {
  assert.equal(tool("ffmpeg"), "ffmpeg");
  assert.equal(tool("ffprobe"), "ffprobe");
});

test("a full ffmpeg.exe path puts ffprobe in the same folder", () => {
  setToolPaths({ ffmpegPath: "D:\\Apps\\ffmpeg\\bin\\ffmpeg.exe" });
  assert.equal(tool("ffmpeg"), "D:\\Apps\\ffmpeg\\bin\\ffmpeg.exe");
  assert.equal(tool("ffprobe"), "D:\\Apps\\ffmpeg\\bin\\ffprobe.exe");
});

test("a bare name stays bare, and setToolPaths({}) restores defaults", () => {
  setToolPaths({ ffmpegPath: "ffmpeg" });
  assert.equal(tool("ffprobe"), "ffprobe");
  setToolPaths({ ffmpegPath: "D:\\x\\ffmpeg.exe" });
  setToolPaths({});
  assert.equal(tool("ffmpeg"), "ffmpeg");
  setToolPaths({ ffmpegPath: "  " });
  assert.equal(tool("ffmpeg"), "ffmpeg");
});

test("a runner spawns the configured ffmpeg", async () => {
  setToolPaths({ ffmpegPath: "D:\\Apps\\ffmpeg\\bin\\ffmpeg.exe" });
  const host = new FakeHost();
  host.files.set("S:\\a.wav", "x");
  const calls = [];
  host.spawnScript(async (cmd, args, o, p) => { calls.push(cmd); p.exit(0); });
  await measure(host, "S:\\a.wav").catch(() => {});
  assert.equal(calls[0], "D:\\Apps\\ffmpeg\\bin\\ffmpeg.exe");
});
