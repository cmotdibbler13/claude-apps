// Library file helpers. Rule for Jon's shared B-roll library: never overwrite, never delete.
import { catalogueArray } from "./library.js";

const pad = (n) => String(n).padStart(2, "0");

function split(path) {
  const s = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const dot = path.lastIndexOf(".");
  const i = dot > s + 1 ? dot : path.length;
  return { stem: path.slice(0, i), ext: path.slice(i) };
}

// <name>_<YYYY-MM-DD-HHmm><ext>, from local time.
export function stampName(path, now) {
  const d = new Date(now);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const { stem, ext } = split(path);
  return `${stem}_${stamp}${ext}`;
}

async function freeName(host, path, now) {
  const first = stampName(path, now);
  if (!(await host.fs.exists(first))) return first;
  const { stem, ext } = split(first);
  for (let n = 2; ; n++) {
    const p = `${stem}_${n}${ext}`;
    if (!(await host.fs.exists(p))) return p;
  }
}

// Write <path>.tmp, then rename over the target. Strings are UTF-8; bytes are written as given.
export async function writeSafely(host, path, data) {
  const tmp = `${path}.tmp`;
  await host.fs.write(tmp, data);
  await host.fs.rename(tmp, path);
}

// Copy the file aside under a stamped name (returns it); null when the source is missing.
export async function copyAside(host, path, now) {
  if (!(await host.fs.exists(path))) return null;
  const to = await freeName(host, path, now);
  await host.fs.write(to, await host.fs.read(path));
  return to;
}

// Move the file aside under a stamped name (returns it); null when the source is missing.
export async function moveAside(host, path, now) {
  if (!(await host.fs.exists(path))) return null;
  const to = await freeName(host, path, now);
  await host.fs.rename(path, to);
  return to;
}

export async function readCatalogue(host, root) {
  const dir = `${String(root).replace(/[\\/]+$/, "")}\\B-roll library`;
  const paths = { dir, json: `${dir}\\broll_catalogue.json`, md: `${dir}\\broll_catalogue.md`, thumbs: `${dir}\\thumbs`, sheets: `${dir}\\contact_sheets`, clips: `${dir}\\clips` };
  let text;
  try { text = await host.fs.read(paths.json, "utf8"); } catch (e) {
    throw new Error(`Couldn't read ${paths.json}: ${e?.message ?? e}`);
  }
  let doc;
  try { doc = JSON.parse(String(text).replace(/^﻿/, "")); } catch (e) {
    throw new Error(`${paths.json} isn't valid JSON: ${e?.message ?? e}`);
  }
  const { key, entries } = catalogueArray(doc);
  let md = "";
  if (await host.fs.exists(paths.md)) md = String(await host.fs.read(paths.md, "utf8")).replace(/^﻿/, "");
  return { doc, key, entries, md, paths };
}
