// A "Choose presenter photos…" button: a plain picture chooser (Studio has no native file dialog), handing
// the picked files on as { name, bytes } for savePresenterPhotos.
export function photoPicker(label, onFiles, { ghost = true } = {}) {
  const input = document.createElement("input");
  input.type = "file"; input.accept = "image/png,image/jpeg,image/webp"; input.multiple = true; input.hidden = true;
  const b = document.createElement("button");
  b.type = "button"; b.className = ghost ? "btn ghost" : "btn"; b.textContent = label;
  b.onclick = () => input.click();
  input.onchange = async () => {
    const picked = [...(input.files ?? [])];
    input.value = "";
    if (!picked.length) return;
    const files = await Promise.all(picked.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    await onFiles(files);
  };
  const span = document.createElement("span");
  span.append(b, input);
  return span;
}
