// Small DOM helpers. Text always goes in as text nodes or textContent, never as markup.
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "disabled" || k === "hidden") el[k] = !!v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export const btn = (label, onclick, { ghost = false, disabled = false, cls = "" } = {}) =>
  h("button", { type: "button", class: `btn${ghost ? " ghost" : ""}${cls ? " " + cls : ""}`, disabled, onclick }, label);

export const basename = (p) => String(p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";

// An <img> or <video> whose blob URL arrives later from preview(file); failures show as text.
export function mediaEl(file, video, preview, label) {
  const wrap = h("div", { class: "media" });
  const show = (url) => {
    const m = video
      ? h("video", { muted: true, loop: true, playsinline: true, controls: true, preload: "metadata", "aria-label": label })
      : h("img", { alt: label });
    if (video) m.muted = true;
    m.src = url;
    wrap.replaceChildren(m);
  };
  const p = preview(file);
  if (p && typeof p.then === "function") {
    wrap.append(h("span", { class: "ph", text: "Loading preview…" }));
    p.then(show, (e) => wrap.replaceChildren(h("span", { class: "ph err", text: `Preview unavailable: ${e?.message ?? e}` })));
  } else if (p) show(p);
  return wrap;
}

export const TOOL_LABEL = { higgsfield: "Higgsfield", blender: "Blender", comfyui: "ComfyUI" };
export const toolLabel = (t) => TOOL_LABEL[t] ?? (t ? t[0].toUpperCase() + t.slice(1) : "");
