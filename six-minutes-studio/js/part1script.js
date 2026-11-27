// The Part 1 script: its shape, word and number checks, timing and warnings.
// Later tasks add the line script builder and the reading script to this file.
//
// Script shape:
// { title, buildLine, key: {graphics:[{name, what}], extra},
//   sections: [{name, clips: [{narration, spoken, cue, delivery|null, pronunciations:[{name, say}]}]}],
//   pronunciations: [{name, say}], shots: [{id, usedIn:number[], prompt}], sfx: [{cue, clip, idea}],
//   music: string|null, archive: [{item, licence, credit}],
//   notes: {corrections, myths, softer, conflicts, timeSensitive, leftOut, filmYourself, pronunciationTests, cutOrder} }

export const SPEECH_S_PER_WORD = 0.40;
export const CLIP_GAP_S = 0.6;
export const SECTION_GAP_S = 1.2;
export const FINISH_FACTOR = 0.965;
export const CLIP_RANGE = [26, 29];
export const WORD_RANGE = [825, 925];
export const CLIP_WORD_RANGE = [5, 50];
export const SECTION_RANGE = [6, 8];

// ---------- clips ----------

export function clipList(script) {
  const out = [];
  let n = 0;
  (script?.sections ?? []).forEach((section, sectionIndex) => {
    for (const clip of section?.clips ?? []) out.push({ n: ++n, section, sectionIndex, clip });
  });
  return out;
}

// ---------- words ----------

export function words(text) {
  const out = [];
  const spaced = String(text ?? "").toLowerCase().replace(/[-‐-―]/g, " ");
  for (const raw of spaced.split(/\s+/)) {
    let t = raw.replace(/[‘’]/g, "'").replace(/[^\p{L}\p{N}'.,]/gu, "");
    t = t.replace(/(?<!\d)[.,]|[.,](?!\d)/g, ""); // keep . and , only between digits
    t = t.replace(/^'+|'+$/g, "");
    if (t) out.push(t);
  }
  return out;
}

const UNITS = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen";
const TENS = "twenty thirty forty fifty sixty seventy eighty ninety";
const BIG = "hundred thousand million billion trillion";
const ORDINALS = "first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth thirtieth fortieth fiftieth sixtieth seventieth eightieth ninetieth hundredth thousandth millionth";
const DECADES = "tens twenties thirties forties fifties sixties seventies eighties nineties";
const OTHER = "point oh and a percent per cent pounds pound pence dollars dollar euros degrees";

export const NUMBER_WORDS = new Set([UNITS, TENS, BIG, ORDINALS, DECADES, OTHER].join(" ").split(" "));

const hasDigit = (t) => /\d/.test(t);
const comparable = (text) => words(text).filter((t) => !hasDigit(t) && !NUMBER_WORDS.has(t));

export function sameWords(narration, spoken) {
  const a = comparable(narration);
  const b = comparable(spoken);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return { ok: false, diff: `${a[i] ?? "(nothing)"} vs ${b[i] ?? "(nothing)"}` };
  }
  return { ok: true, diff: null };
}

// ---------- numbers and times ----------

export function mmss(s) {
  const total = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);

export function scriptStats(script, settings = {}) {
  const titleHoldS = num(settings?.titleHoldS, 6);
  const endCardS = num(settings?.endCardS, 12);
  const clips = clipList(script);
  const clipWords = clips.map((c) => words(c.clip?.narration).length);
  const spoken = clips.map((c) => words(c.clip?.spoken).length);
  const sections = script?.sections ?? [];

  let t = 0;
  let seenClip = false;
  const sectionTimes = [];
  sections.forEach((section, si) => {
    const cs = section?.clips ?? [];
    if (si > 0 && seenClip) t += SECTION_GAP_S; // replaces the clip gap
    const startS = t;
    let endS = t;
    cs.forEach((clip, ci) => {
      if (ci > 0) t += CLIP_GAP_S;
      t += words(clip?.spoken).length * SPEECH_S_PER_WORD;
      endS = t;
      seenClip = true;
    });
    sectionTimes.push({ startS, endS });
    if (si === 0) t += titleHoldS;
  });
  t += endCardS;

  const rawS = t;
  return {
    clips: clips.length,
    sections: sections.length,
    words: clipWords.reduce((a, b) => a + b, 0),
    spokenWords: spoken.reduce((a, b) => a + b, 0),
    rawS,
    expectedS: rawS * FINISH_FACTOR,
    sectionTimes,
    clipWords,
  };
}

// ---------- warnings ----------

function parseTarget(target) {
  const m = String(target ?? "").match(/(\d+):(\d{2})\s*[–—-]\s*(\d+):(\d{2})/);
  if (!m) return null;
  return [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])];
}

export function scriptWarnings(stats, runtimeTarget) {
  const out = [];
  if (stats.clips < CLIP_RANGE[0] || stats.clips > CLIP_RANGE[1]) out.push(`Clips: ${stats.clips} (aim for 26–29).`);
  if (stats.words < WORD_RANGE[0] || stats.words > WORD_RANGE[1]) out.push(`Words: ${stats.words} (aim for 825–925).`);
  (stats.clipWords ?? []).forEach((w, i) => {
    if (w < CLIP_WORD_RANGE[0] || w > CLIP_WORD_RANGE[1]) {
      out.push(`Clip ${String(i + 1).padStart(2, "0")} is ${w} words (5–50).`);
    }
  });
  if (stats.sections < SECTION_RANGE[0] || stats.sections > SECTION_RANGE[1]) out.push(`Sections: ${stats.sections} (aim for 6–8).`);
  const range = parseTarget(runtimeTarget);
  if (range && (stats.rawS < range[0] || stats.rawS > range[1])) {
    out.push(`Estimated ${mmss(stats.rawS)}, outside ${String(runtimeTarget).trim()}.`);
  }
  return out;
}
