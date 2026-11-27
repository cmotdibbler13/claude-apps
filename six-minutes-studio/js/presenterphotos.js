// "Choose presenter photos": copy the pictures Jon picks into <root>\Presenter photos\ and list them in
// .studio-settings.json (presenter.photos). Nothing is overwritten: a picture with the same name gets _2, _3…
import { join } from "./paths.js";

export const PHOTO_DIR = "Presenter photos";
const OK_EXT = /\.(png|jpe?g|webp)$/i;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

async function freeName(host, dir, name) {
  const m = /^(.*?)(\.[^.]*)?$/.exec(name);
  for (let i = 1; ; i++) {
    const p = join(dir, i === 1 ? name : `${m[1]}_${i}${m[2] ?? ""}`);
    if (!(await host.fs.exists(p))) return p;
  }
}

// files: [{ name, bytes: Uint8Array }]. Returns the saved paths.
export async function savePresenterPhotos(host, root, files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 2) throw new Error("Choose one or two pictures of you.");
  for (const f of files) if (!OK_EXT.test(String(f?.name ?? ""))) throw new Error(`${f?.name ?? "That file"} isn't a PNG, JPEG or WebP picture.`);
  const file = join(root, ".studio-settings.json");
  // Read the settings first: a file Studio can't read is never replaced.
  let settings = {};
  if (await host.fs.exists(file)) {
    try { settings = JSON.parse(await host.fs.read(file, "utf8")); } catch { settings = null; }
    if (!isObj(settings)) throw new Error("Couldn't read .studio-settings.json, so it was left as it is. Fix it, then try again.");
  }
  const dir = join(root, PHOTO_DIR);
  await host.fs.mkdir(dir);
  const paths = [];
  for (const f of files) {
    const p = await freeName(host, dir, String(f.name).replace(/[\\/:*?"<>|]/g, "_"));
    await host.fs.write(p, f.bytes);
    paths.push(p);
  }
  settings.presenter = { ...(isObj(settings.presenter) ? settings.presenter : {}), photos: paths };
  await host.fs.write(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return paths;
}
