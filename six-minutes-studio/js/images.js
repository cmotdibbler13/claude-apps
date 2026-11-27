// Pictures for Claude: read image files from disk as typed Blobs for sample's `images` option.
const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

const baseName = (p) => String(p).replace(/\\/g, "/").split("/").pop();

export async function readImages(host, paths) {
  const blobs = [];
  for (const p of paths) {
    const name = baseName(p);
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    const type = TYPES[ext];
    if (!type) throw new Error(`Can't send ${name} to Claude: not a PNG, JPEG or WebP picture.`);
    blobs.push(new Blob([await host.fs.read(p)], { type }));
  }
  return blobs;
}

// True only where the runtime says pictures can be sent.
export async function canSendImages(host) {
  try {
    const limits = host?.claude?.limits;
    if (typeof limits !== "function") return false;
    return !!(await limits())?.images;
  } catch {
    return false;
  }
}
