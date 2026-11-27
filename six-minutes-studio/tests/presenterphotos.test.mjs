import { test } from "node:test";
import assert from "node:assert/strict";
import { savePresenterPhotos, PHOTO_DIR } from "../js/presenterphotos.js";
import { FakeHost } from "./fake-host.mjs";

const ROOT = "S:\\Youtube video ideas";
const SET = `${ROOT}\\.studio-settings.json`;
const pic = (name) => ({ name, bytes: new Uint8Array([1, 2, 3]) });
const setup = async (settings) => {
  const h = new FakeHost();
  await h.fs.mkdir(ROOT);
  if (settings !== undefined) await h.fs.write(SET, typeof settings === "string" ? settings : JSON.stringify(settings));
  return h;
};

test("copies the pictures into Presenter photos and lists them, keeping other settings", async () => {
  const h = await setup({ autocueDir: "C:\\a", presenter: { photos: ["old.jpg"], other: 1 } });
  const paths = await savePresenterPhotos(h, ROOT, [pic("me.jpg"), pic("blazer.PNG")]);
  assert.deepEqual(paths, [`${ROOT}\\${PHOTO_DIR}\\me.jpg`, `${ROOT}\\${PHOTO_DIR}\\blazer.PNG`]);
  for (const p of paths) assert.ok(await h.fs.exists(p));
  const s = JSON.parse(await h.fs.read(SET, "utf8"));
  assert.deepEqual(s.presenter, { photos: paths, other: 1 });
  assert.equal(s.autocueDir, "C:\\a");
});

test("no settings file yet: makes one", async () => {
  const h = await setup();
  const paths = await savePresenterPhotos(h, ROOT, [pic("me.webp")]);
  assert.deepEqual(JSON.parse(await h.fs.read(SET, "utf8")), { presenter: { photos: paths } });
});

test("never overwrites a picture already there", async () => {
  const h = await setup({});
  await h.fs.mkdir(`${ROOT}\\${PHOTO_DIR}`);
  await h.fs.write(`${ROOT}\\${PHOTO_DIR}\\me.jpg`, "first");
  const [p] = await savePresenterPhotos(h, ROOT, [pic("me.jpg")]);
  assert.equal(p, `${ROOT}\\${PHOTO_DIR}\\me_2.jpg`);
  assert.equal(await h.fs.read(`${ROOT}\\${PHOTO_DIR}\\me.jpg`, "utf8"), "first");
});

test("refusals: none, more than two, not a picture, unreadable settings (left untouched)", async () => {
  const h = await setup({});
  await assert.rejects(savePresenterPhotos(h, ROOT, []), /one or two/);
  await assert.rejects(savePresenterPhotos(h, ROOT, [pic("a.jpg"), pic("b.jpg"), pic("c.jpg")]), /one or two/);
  await assert.rejects(savePresenterPhotos(h, ROOT, [pic("a.heic")]), /PNG, JPEG or WebP/);
  const bad = await setup("{ not json");
  await assert.rejects(savePresenterPhotos(bad, ROOT, [pic("a.jpg")]), /Couldn't read \.studio-settings\.json/);
  assert.equal(await bad.fs.read(SET, "utf8"), "{ not json");
  assert.equal(await bad.fs.exists(`${ROOT}\\${PHOTO_DIR}\\a.jpg`), false);
});
