// Pacing marks: pauses (‖) Jon sets after a word or after a line, tied to the word and its occurrence so they survive a new transcription,
// and the pauses file that voiceover_join.py --pauses reads. Pure: no store or host access.

export const PAUSE_S = { short: 0.3, medium: 0.6, long: 1.0 };
const RANK = { short: 1, medium: 2, long: 3 };
const ms = (n) => Math.round(n * 1000) / 1000;

export const norm = (word) => String(word ?? "").toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

// The words of one line with their position and which occurrence of that word they are.
export function lineWords(transcript, id) {
  const seen = {};
  return (transcript?.words || []).filter((w) => w.sentence === id).map((w, i) => {
    const n = norm(w.word);
    seen[n] = (seen[n] || 0) + 1;
    return { word: w.word, start: w.start, end: w.end, i, nth: seen[n] };
  });
}

export const takeSig = (row) => {
  if (!row?.file) return null;
  const base = String(row.file).split(/[\\/]/).pop();
  return `${base}|${row.takeS}`;
};

const keyOf = (word, nth) => `${norm(word)}#${nth}`;
const isLast = (words, word, nth) => {
  const last = words?.[words.length - 1];
  return !!last && norm(last.word) === norm(word) && last.nth === nth;
};

function put(pauses, mark) {
  const old = pauses.find((p) => p.key === mark.key);
  if (!old) return [...pauses, mark];
  const merged = {
    ...mark,
    size: (RANK[old.size] || 0) >= (RANK[mark.size] || 0) ? old.size : mark.size,
    by: old.by === "jon" || mark.by === "jon" ? "jon" : mark.by,
  };
  return pauses.map((p) => (p.key === mark.key ? merged : p));
}

// `after`: "end" for the gap after the line, otherwise any truthy value for "after this word".
// Pass `words` (lineWords) so a mark after the last word becomes the gap mark.
export function addMark(line, { after, word, nth, size = "medium", by, take, words } = {}) {
  const l = line || {};
  const end = after === "end" || (word != null && isLast(words, word, nth));
  const mark = end
    ? { key: "end", word: null, nth: null, size, by, take: take ?? l.take ?? null }
    : { key: keyOf(word, nth), word, nth, size, by, take: take ?? l.take ?? null };
  return { ...l, pauses: put(l.pauses || [], mark) };
}

export const setSize = (line, key, size) =>
  ({ ...line, pauses: (line.pauses || []).map((p) => (p.key === key ? { ...p, size } : p)) });

export const removeMark = (line, key) => ({ ...line, pauses: (line.pauses || []).filter((p) => p.key !== key) });

// Move a mark one word earlier (dir -1) or later (dir 1). Moving onto the last word makes it the gap mark.
export function moveMark(line, key, dir, words) {
  const mark = (line.pauses || []).find((p) => p.key === key);
  if (!mark || !words?.length) return line;
  const at = key === "end" ? words.length - 1 : words.findIndex((w) => keyOf(w.word, w.nth) === key);
  const to = at + dir;
  if (at < 0 || to < 0 || to > words.length - 1) return line;
  const w = words[to];
  const rest = removeMark(line, key);
  return addMark(rest, { after: true, word: w.word, nth: w.nth, size: mark.size, by: mark.by, take: mark.take, words });
}

export function markState(mark, words, line, sig) {
  if (mark.key === "end") return "ok";
  const found = (words || []).some((w) => norm(w.word) === norm(mark.word) && w.nth === mark.nth);
  if (!found) return "not-found";
  const made = mark.take ?? line?.take ?? null;
  return made !== (sig ?? null) ? "take-changed" : "ok";
}

// Position in the audio as it is now (pauses included) to the line's own audio without pauses.
export function toUnpaused(posPaused, applied) {
  let shift = 0;
  let pos = posPaused;
  for (const a of [...(applied || [])].sort((x, y) => x.at_s - y.at_s)) {
    const start = a.at_s + shift;
    if (pos <= start) break;
    pos -= Math.min(a.add_s, pos - start);
    shift += a.add_s;
  }
  return ms(pos);
}

export function buildPauses(pacing, transcript, applied, takeSigs) {
  const file = { inside: {}, after: {} };
  const skipped = [];
  for (const [id, line] of Object.entries(pacing?.lines || {})) {
    const words = lineWords(transcript, id);
    const sentence = (transcript?.sentences || []).find((s) => s.sentence === id);
    for (const m of line.pauses || []) {
      const state = markState(m, words, line, takeSigs?.[id]);
      if (state !== "ok") { skipped.push({ id, key: m.key, reason: state }); continue; }
      const add = PAUSE_S[m.size] ?? PAUSE_S.medium;
      if (m.key === "end") { file.after[id] = add; continue; }
      const w = words.find((x) => norm(x.word) === norm(m.word) && x.nth === m.nth);
      const next = words[w.i + 1];
      const mid = next ? (w.end + next.start) / 2 : w.end;
      const at = toUnpaused(mid - (sentence?.start ?? 0), applied?.[id]);
      (file.inside[id] ||= []).push({ at_s: at, add_s: add });
    }
    if (file.inside[id]) file.inside[id].sort((a, b) => a.at_s - b.at_s);
  }
  return { file, skipped };
}

// What would be sent, as a stable string, so Studio can tell the marks changed since the last join.
export function marksSig(pacing, takeSigs) {
  const out = [];
  for (const id of Object.keys(pacing?.lines || {}).sort()) {
    const marks = (pacing.lines[id].pauses || [])
      .filter((m) => m.key === "end" || (m.take ?? pacing.lines[id].take ?? null) === (takeSigs?.[id] ?? null))
      .map((m) => [m.key, m.size])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (marks.length) out.push([id, marks]);
  }
  return JSON.stringify(out);
}
