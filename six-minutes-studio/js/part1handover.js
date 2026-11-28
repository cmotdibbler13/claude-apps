// Approve Part 1: the handover text, the decisions Jon gave and the pronunciations file's growth. Pure text helpers.
const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const two = (n) => String(n).padStart(2, "0");

export const NEXT_STEP = (prefix) =>
  `Record every line in Autocue Studio (Load script → ${prefix}_line_script.txt). Then open this film's Review in Studio for Part 2.`;

// Each note Jon gave, in his words, then the approval and the episode.
export function decisionsFrom(drafts = [], setup = {}) {
  const out = [];
  for (const d of drafts) {
    if (!d?.note) continue;
    const m = /^Clip (\d+) redone/.exec(String(d.why ?? ""));
    out.push(m ? `Clip ${two(m[1])}: "${d.note}"` : `Revise: "${d.note}"`);
  }
  const last = drafts.at(-1);
  if (last) out.push(`Draft ${last.n} approved`);
  out.push(`Episode ${setup.episode}`);
  return out;
}

// New full text for the pronunciations file, or null when every entry is already there as the identical line.
export function appendPronunciations(text, topic, list = []) {
  const have = new Set(String(text ?? "").split(/\r\n|\n|\r/).map((l) => l.trim()));
  const lines = [];
  for (const p of list) {
    if (!p?.name) continue;
    const line = `${p.name} = "${p.say}"`;
    if (have.has(line) || lines.includes(line)) continue;
    lines.push(line);
  }
  if (!lines.length) return null;
  const block = [`## ${topic}`, "", ...lines, ""].join("\n");
  const base = text == null ? "" : String(text).replace(/\s+$/, "");
  return base ? `${base}\n\n${block}` : block;
}

export function renderPart1Handover(f) {
  const bullets = (xs, none) => (xs?.length ? xs.map((x) => `- ${x}`) : [`- ${none}`]);
  const out = [];
  out.push(`# Part 1 handover — Six minutes on… ${f.topic}`, "", `Episode: ${f.episode}`, "");
  out.push("## Project", "", `- Film: ${f.topic}`, `- File prefix: ${f.prefix}`, `- Film folder: ${f.dir}`, `- Project root: ${f.root}`);
  if (f.approvedAt != null) out.push(`- Approved: ${new Date(f.approvedAt).toISOString()}`);
  out.push("");
  out.push("## Voice", "", "- Own voice (Autocue Studio)", `- Recordings folder: ${f.recordings}`, "");
  out.push("## To-camera lines", "", ...bullets((f.picks ?? []).map((p) => `${p.id}: ${p.text}`), "None."), "");
  out.push("## His decisions", "", ...bullets(f.decisions, "None recorded."), "");
  out.push("## Approved pronunciations", "", ...bullets((f.pronunciations ?? []).map((p) => `${p.name} = "${p.say}"`), "None."), "");
  out.push("## Sound-effects list", "");
  if (f.sfx?.length) {
    out.push("| Cue | Clip | Prompt idea |", "|---|---|---|", ...f.sfx.map((s) => `| ${cell(s.cue)} | ${two(s.clip)} | ${cell(s.idea)} |`));
  } else out.push("- None.");
  out.push("");
  out.push("## File index", "");
  // Line scripts before the brief: Part 2 takes the first .txt path containing "line".
  out.push(`- Reading script: \`${f.files.script}\``);
  out.push(`- Line script (film folder): \`${f.files.lineScript}\``);
  if (f.files.autocueCopy) out.push(`- Line script (Autocue Studio folder): \`${f.files.autocueCopy}\``);
  out.push(`- Brief: \`${f.brief}\``);
  out.push("");
  out.push("## Open items", "", ...bullets(f.openItems, "None."), "");
  out.push("## Next step", "", NEXT_STEP(f.prefix), "");
  return out.join("\n");
}
