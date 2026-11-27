// Pacing marks: pauses (‖) Jon sets after a word or after a line, tied to the word and its occurrence so they survive a new transcription,
// and the pauses file that voiceover_join.py --pauses reads. Pure: no store or host access.

import { askJson } from "./claude.js";

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
  if (after !== "end" && word == null) return line;
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
  return made != null && made !== (sig ?? null) ? "take-changed" : "ok";
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
      if (m.key === "end") { file.after[id] = Math.max(file.after[id] ?? 0, add); continue; }
      const w = words.find((x) => norm(x.word) === norm(m.word) && x.nth === m.nth);
      const next = words[w.i + 1];
      if (!next) { file.after[id] = Math.max(file.after[id] ?? 0, add); continue; }
      const at = toUnpaused((w.end + next.start) / 2 - (sentence?.start ?? 0), applied?.[id]);
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
      .filter((m) => {
        const made = m.take ?? pacing.lines[id].take ?? null;
        return m.key === "end" || made == null || made === (takeSigs?.[id] ?? null);
      })
      .map((m) => [m.key, m.size])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (marks.length) out.push([id, marks]);
  }
  return JSON.stringify(out);
}

export const PLACE_INSTRUCTIONS = `You place pauses in a voiceover for a Six Minutes On... documentary film (calm, precise, British English).
Jon has written a note on some lines of his script. For each line you get its id, its text, its words (i is the word's index, word is the word), his note, and the text of the line before and after (null at the ends).

For each line, answer one of two things:
- pauses: [{"after": index, "size": "short" | "medium" | "long"}]. "after" is the index i of the word the pause follows, or "end" for the gap after the whole line. Use pauses only where the note asks for them. Prefer "end" for "after this line". Short is 0.3 s, medium 0.6 s, long 1.0 s; choose medium unless the note says otherwise.
- reply: a short sentence in plain British English, when the note is about delivery or wording rather than a pause, for example "This sounds like a delivery change: tick Re-record".

Reply with JSON only: a list with one item per line, {"id": "...", "pauses": [...]} or {"id": "...", "reply": "..."}.`;

export function notesToPlace(pacing) {
  return Object.entries(pacing?.lines || {})
    .filter(([, l]) => String(l?.note ?? "").trim() && (l.noteAt ?? 0) > (l.placedAt ?? 0))
    .map(([id]) => id);
}

export async function placeFromNotes(host, store, { transcript, lineScript, takeSigs = {} } = {}) {
  const pacing = store.state?.mix?.pacing;
  const ids = notesToPlace(pacing);
  if (!ids.length) return { placed: [], replies: [] };
  const script = lineScript?.lines || [];
  const data = ids.map((id) => {
    const at = script.findIndex((l) => l.id === id);
    return {
      id,
      text: script[at]?.text ?? "",
      words: lineWords(transcript, id).map((w) => ({ i: w.i, word: w.word })),
      note: pacing.lines[id].note,
      before: at > 0 ? script[at - 1].text : null,
      after: at >= 0 && at < script.length - 1 ? script[at + 1].text : null,
    };
  });
  const wordsOf = Object.fromEntries(ids.map((id) => [id, lineWords(transcript, id)]));
  const out = await askJson(host, {
    instructions: PLACE_INSTRUCTIONS,
    data,
    tier: "quick",
    validate: (a) => {
      if (!Array.isArray(a)) throw new Error("The answer must be a list.");
      for (const it of a) {
        if (!it || !ids.includes(it.id)) throw new Error(`Unknown line ${it?.id}.`);
        const hasPauses = Array.isArray(it.pauses) && it.pauses.length > 0;
        const hasReply = typeof it.reply === "string" && it.reply.trim() !== "";
        if (!hasPauses && !hasReply) throw new Error(`Line ${it.id} has neither pauses nor a reply.`);
        for (const p of hasPauses ? it.pauses : []) {
          if (!Object.hasOwn(PAUSE_S, p?.size)) throw new Error(`Line ${it.id}: size ${p?.size} is not short, medium or long.`);
          const ok = p.after === "end" || (Number.isInteger(p.after) && p.after >= 0 && p.after < wordsOf[it.id].length);
          if (!ok) throw new Error(`Line ${it.id}: after ${p.after} is not a word index or "end".`);
        }
      }
    },
  });
  const placed = [];
  const replies = [];
  const now = host.now();
  await store.update((s) => {
    const lines = s.mix.pacing.lines;
    for (const it of out) {
      let line = lines[it.id];
      if (Array.isArray(it.pauses) && it.pauses.length) {
        line = { ...line, pauses: (line.pauses || []).filter((m) => m.by !== "claude") };
        for (const p of it.pauses) {
          const w = p.after === "end" ? null : wordsOf[it.id][p.after];
          const key = p.after === "end" || isLast(wordsOf[it.id], w.word, w.nth) ? "end" : keyOf(w.word, w.nth);
          if (line.pauses.some((m) => m.key === key && m.by === "jon")) continue; // Jon's mark stays as it is
          line = addMark(line, {
            after: p.after === "end" ? "end" : true, word: w?.word, nth: w?.nth,
            size: p.size, by: "claude", take: takeSigs[it.id], words: wordsOf[it.id],
          });
        }
        line.reply = null;
        placed.push(it.id);
      } else {
        line = { ...line, reply: it.reply };
        replies.push(it.id);
      }
      line.placedAt = now;
      lines[it.id] = line;
    }
    // A line Claude left out is done with this note too; say so.
    for (const id of ids) {
      if (out.some((it) => it.id === id)) continue;
      lines[id].placedAt = now;
      lines[id].reply = "Claude didn't place a pause for this note. Click the word to place one.";
    }
  });
  if (placed.length) await store.log(`Pauses placed for ${placed.join(", ")}`);
  return { placed, replies };
}
