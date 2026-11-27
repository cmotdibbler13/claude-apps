// Part 1 Claude calls: the clips, the lists, and one clip redone with a note.
// The instruction strings are the documentary-explainer-script skill's rules (skills/documentary-explainer-script/SKILL.md
// at the repo root), adapted for Studio: Studio numbers the sections and clips, does the timing maths, counts the words,
// builds the line script and lays out the reading script, so none of that is asked of Claude. Update these with the skill.
import { askJson, ClaudeError } from "./claude.js";
import { sameWords, clipList } from "./part1script.js";

export const BRIEF_TOO_BIG = "The brief is too long for Studio to send (<n> characters, <max> at most).";
const DEFAULT_MAX_CHARS = 400000;

// ---------- shared rule blocks ----------

const WHO = `You write the narrated script for one film in Jon Cowan's YouTube series "Six minutes on…" (a dark, documentary-style motion-graphics explainer; each film's full title is "Six minutes on… <Topic>"). Jon records the narration himself, in his own voice, line by line.
Studio numbers the sections and clips, works out the timings and word counts, builds the recording script and lays out the reading script from your answer. So never number sections or clips, never write timings, and never put brackets, clip numbers or headings in the text fields.`;

const INPUTS = `DATA gives you:
- brief: the research brief, the only source of facts. Read all of it, including the caveats, the myths section and the source list; the caveats decide what the narration may state as fact.
- reference: one of Jon's finished reading scripts. Use it for format and tone only: how clips, cues, readouts and delivery notes look and how the narration sounds. Never take its facts, wording, sections, graphics or shots into this film.
- pronunciations: Jon's approved pronunciations (free text, usually one Name = "say" per line), or null.
- setup: topic, prefix, episode, runtimeTarget and voice.
- previousError (only on a second try): why your last answer was refused. Fix exactly that and keep the rest.`;

const NARRATION = `Writing the narration:
- Length: about 825–925 words in 26–29 clips of 5–50 words each, in about seven sections, unless the setup's runtimeTarget says otherwise (then scale it: roughly 140 words per minute of runtime). "Six minutes on…" films should land close to six minutes.
- Cold open (section 1): a vivid present-day hook, then the stakes, then a short punchy line into the title card ("It began with a shipwreck." / "And it took a smell to build it."). The ending bookends the opening image.
- Style: plain spoken British English, short sentences, concrete numbers and dates, one idea per sentence. Let a few lines land on their own ("The word was his.").
- Quotes: only short, well-sourced lines, with the speaker named in the narration and in the cue.
- Never quote song lyrics or poems; mention them only.
- Each clip is one paragraph of narration with one visual cue.`;

const ACCURACY = `Accuracy rules:
- State as fact only what the brief supports with a good source.
- Hedge anything the brief marks as contested, modelled, unverified or folklore ("Many believed…", "That figure is modelled…"), or leave it out (the build notes say so).
- Prefer the brief's own recommended framings and figures.
- Use real years, never "this year" or "last year", so the film doesn't date.
- Visual cues must never label a generic image as a specific real thing.`;

const CUES = `Visual cues (the cue field, written without the [brackets]), in the house style:
- readouts in bold, e.g. Readout: **25 OCT 1859** with a sub-line;
- line art drawing on in amber;
- MAP moves, and the film's other reusable graphics (name one or two in key.graphics, built once and used throughout: the Shipping Forecast had MAP of the sea areas; the Sewers had MAP of the Thames and EGG, a sewer cross-section);
- quote cards in Inter Light with amber attribution;
- small source notes and text cards;
- Higgsfield b-roll shots named HF-01, HF-02 and so on (two digits, numbered in order of first use; a shot may be reused in later clips). B-roll is illustrative only: never caption it as a real place, ship or object.
- On-screen text is Inter only, with no italics anywhere.
- The last clip of section 1 ends its cue with the title card: a small amber SIX MINUTES ON… label above the title, an amber rule and a sub-line.
- The last clip of the film ends its cue with the end card, always: a small amber label SIX MINUTES ON… above the topic title in caps; an amber rule and a subtitle; A film by Jon Cowan · **youtube.com/@SixMinuteson** · **sixminuteson.com** · **@sixminuteson** on X and Bluesky; small credits: sources, archive with licences, photo credits, map data and music.
- delivery: an optional short note on how to read the clip ("slower", "let it land"), written without asterisks, or null. It is in the script only, never on screen.`;

const SPOKEN = `The spoken field (what Jon reads aloud, used for the recording script and captions):
- Exactly the narration's words, in the same order, with normal spellings. Change only how numbers are written.
- Numbers and years spelled out as words: "eighteen fifty-nine", "twenty twenty-five", "four point seven billion pounds", "eighty-six percent", "the eighteen fifties", "the nineteenth century".
- No respellings for the voice (St Austell, not Saint Ostul; baton, not batten) and no spacing of initialisms (TUC, not T U C; MPs, not M Ps).
- So the two always match, in the narration use digits only for numbers, with only £, $ and % as symbols; write units and other words in full in both ("12 kilometres", not "12km"; "4.7 billion", not "4.7bn").
- Studio refuses a clip whose narration and spoken differ in any word other than numbers.`;

const PRONOUNCE = `The pronunciations field of each clip: for every name in that clip's spoken text that is in Jon's approved pronunciations, or that is hard to say and should be tested, give {"name": the name exactly as written in spoken, "say": how to say it, e.g. "Saint Ostul"}. Use the approved "say" where there is one. An empty list when there are none.`;

const CLIP_SHAPE = `{"narration": string, "spoken": string, "cue": string, "delivery": string or null, "pronunciations": [{"name": string, "say": string}]}`;

// ---------- instructions ----------

export const CLIPS_INSTRUCTIONS = `${WHO}

${INPUTS}
- note and current (only when Jon asks for a revision): his note on the whole script and the current draft. Revise the current draft by the note and keep what the note doesn't ask to change.

${NARRATION}

${ACCURACY}

${CUES}

${SPOKEN}

${PRONOUNCE}

The other fields:
- title: the film's title for the reading script heading, in the reference script's style, for this topic.
- buildLine: one line naming the pipeline and the b-roll source, like the reference script's Build line, without the "Build:" label.
- key.graphics: the reusable graphics, each {"name": as written in the cues, e.g. "MAP", "what": what it shows}. key.extra: one more sentence for the key paragraph, or null.
- sections: about seven, each {"name": the section name (no number), "clips": [...]}.

Reply with JSON only: {"title": string, "buildLine": string, "key": {"graphics": [{"name": string, "what": string}], "extra": string or null}, "sections": [{"name": string, "clips": [${CLIP_SHAPE}]}]}.`;

export const LISTS_INSTRUCTIONS = `You write the lists that go after the script of one film in Jon Cowan's YouTube series "Six minutes on…": the Higgsfield shot list, the sound-effects list, the music line, archive and rights, and the notes for the build. British English, plain.

DATA gives you:
- brief: the research brief, the only source of facts.
- setup: topic, prefix, episode, runtimeTarget and voice.
- clips: the finished script, every clip with its number n, its section name, narration, spoken text, cue, delivery note and pronunciations. Refer to clips by n.
- previousError (only on a second try): why your last answer was refused. Fix exactly that and keep the rest.

Higgsfield shot list (shots): one row for every HF-nn named in the cues, with id exactly as in the cues ("HF-01", two digits, each id once), usedIn the numbers of the clips whose cues use it, and a prompt.
- Every prompt: 16:9, 1080p, 5–8 s, slow moves; graded navy #0a1b30 and amber #e3a64a; illustrative only, never a real named place, ship or object.
- Name the period for any vessel or vehicle ("no modern ships"), and rule out modern street furniture, road markings and cars in period scenes.
- Say "low-rise European city, no skyscrapers" for a British skyline.
- Say "a single man" when one figure will do, because extra figures vanish mid-shot.
- Spell out the direction of physical motion ("water flows down into the drain").
- For an underground or night shot, ask for it dark and low-key.
- For a held opening shot, ask for 15 s and "one single continuous unbroken shot, no cuts": the video model can hide a jump cut inside a clip.

Sound effects (sfx): each {"cue": a short name, "clip": the clip number, "idea": a prompt idea}. Keep them few and in the background. Jon approves this list before any sound effect is made.

Music (music): one line describing the score, or null.

Archive and rights (archive), when archive images are proposed, else []: each {"item", "licence", "credit"}. Public-domain pre-1900 engravings and cartoons are the safe choice; name the licence of each scan; press photos need permission (say so in licence); give the map data source and credit.

Notes for the build (notes), each a list of short strings, [] when there is nothing:
- corrections: corrections to the brief, and every place where the brief corrects popular accounts;
- myths: myths kept out or hedged;
- softer: softer-sourced lines Jon may cut (name the clip);
- conflicts: conflicting figures and every date conflict;
- timeSensitive: fast-changing facts (companies, finances, policy) to re-check on publish day;
- leftOut: material left out on purpose, suggested as a Short or an optional clip, with its text;
- filmYourself: ways Jon could film things himself;
- pronunciationTests: the tricky names for Jon to confirm, each as Name = "say";
- cutOrder: which clips or lines to cut first if the film runs long, by clip number, most cuttable first.

Reply with JSON only: {"shots": [{"id": "HF-01", "usedIn": [numbers], "prompt": string}], "sfx": [{"cue": string, "clip": number, "idea": string}], "music": string or null, "archive": [{"item": string, "licence": string, "credit": string}], "notes": {"corrections": [strings], "myths": [strings], "softer": [strings], "conflicts": [strings], "timeSensitive": [strings], "leftOut": [strings], "filmYourself": [strings], "pronunciationTests": [strings], "cutOrder": [strings]}}.`;

export const CLIP_INSTRUCTIONS = `${WHO}

You rewrite one clip of a finished script by Jon's note. Only that clip changes.

DATA gives you:
- brief: the research brief, the only source of facts.
- setup: topic, prefix, episode, runtimeTarget and voice.
- clips: the whole current script as context, every clip with its number n and section name. Do not repeat what the other clips say; keep the joins with the clips before and after smooth.
- n: the number of the clip to rewrite. note: Jon's note for it. Follow the note; keep the clip's length near its current length unless the note says otherwise, and keep any HF-nn shots, title card or end card its cue carries unless the note asks to change them.
- pronunciations: the approved pronunciations already in the script, [{name, say}].
- previousError (only on a second try): why your last answer was refused. Fix exactly that and keep the rest.

${NARRATION}

${ACCURACY}

${CUES}

${SPOKEN}

${PRONOUNCE}

Reply with JSON only: ${CLIP_SHAPE}.`;

// ---------- checks ----------

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const two = (n) => String(n).padStart(2, "0");
const NOTE_KEYS = ["corrections", "myths", "softer", "conflicts", "timeSensitive", "leftOut", "filmYourself", "pronunciationTests", "cutOrder"];

function checkClip(c, n) {
  const at = `Clip ${two(n)}`;
  if (!isObj(c)) throw new Error(`${at}: not an object.`);
  if (!isStr(c.narration) || !c.narration.trim()) throw new Error(`${at}: narration is missing.`);
  if (!isStr(c.spoken) || !c.spoken.trim()) throw new Error(`${at}: spoken is missing.`);
  if (!isStr(c.cue)) throw new Error(`${at}: cue must be a string.`);
  if (c.delivery !== null && !isStr(c.delivery)) throw new Error(`${at}: delivery must be a string or null.`);
  if (!Array.isArray(c.pronunciations) || !c.pronunciations.every((p) => isObj(p) && isStr(p.name) && isStr(p.say))) {
    throw new Error(`${at}: pronunciations must be a list of {name, say} strings.`);
  }
  const same = sameWords(c.narration, c.spoken);
  if (!same.ok) throw new Error(`${at}: ${same.diff}`);
}

function checkClips(v) {
  if (!isObj(v)) throw new Error("The answer is not an object.");
  if (!isStr(v.title) || !v.title.trim()) throw new Error("title is missing.");
  if (!isStr(v.buildLine)) throw new Error("buildLine must be a string.");
  if (!isObj(v.key) || !Array.isArray(v.key.graphics) || !v.key.graphics.every((g) => isObj(g) && isStr(g.name) && isStr(g.what))) {
    throw new Error("key.graphics must be a list of {name, what} strings.");
  }
  if (v.key.extra != null && !isStr(v.key.extra)) throw new Error("key.extra must be a string or null.");
  if (!Array.isArray(v.sections) || !v.sections.length) throw new Error("sections is missing or empty.");
  v.sections.forEach((s, i) => {
    if (!isObj(s) || !isStr(s.name) || !s.name.trim()) throw new Error(`Section ${i + 1} has no name.`);
    if (!Array.isArray(s.clips) || !s.clips.length) throw new Error(`Section ${i + 1} has no clips.`);
  });
  for (const { n, clip } of clipList(v)) checkClip(clip, n);
}

function checkLists(v, count) {
  const exists = (n) => Number.isInteger(n) && n >= 1 && n <= count;
  if (!isObj(v)) throw new Error("The answer is not an object.");
  if (!Array.isArray(v.shots)) throw new Error("shots must be a list.");
  const ids = new Set();
  for (const s of v.shots) {
    if (!isObj(s) || !isStr(s.id) || !/^HF-\d{2}$/.test(s.id)) throw new Error(`Shot id ${s?.id} must look like HF-01.`);
    if (ids.has(s.id)) throw new Error(`Shot ${s.id} is listed twice.`);
    ids.add(s.id);
    if (!Array.isArray(s.usedIn)) throw new Error(`Shot ${s.id}: usedIn must be a list of clip numbers.`);
    const bad = s.usedIn.find((n) => !exists(n));
    if (bad !== undefined) throw new Error(`Shot ${s.id} is used in clip ${bad}, which doesn't exist (1–${count}).`);
    if (!isStr(s.prompt) || !s.prompt.trim()) throw new Error(`Shot ${s.id} has no prompt.`);
  }
  if (!Array.isArray(v.sfx)) throw new Error("sfx must be a list.");
  for (const s of v.sfx) {
    if (!isObj(s) || !isStr(s.cue) || !isStr(s.idea)) throw new Error("Each sound effect needs a cue and an idea.");
    if (!exists(s.clip)) throw new Error(`Sound effect "${s.cue}" is in clip ${s.clip}, which doesn't exist (1–${count}).`);
  }
  if (v.music !== null && !isStr(v.music)) throw new Error("music must be a string or null.");
  if (!Array.isArray(v.archive) || !v.archive.every((a) => isObj(a) && isStr(a.item) && isStr(a.licence) && isStr(a.credit))) {
    throw new Error("archive must be a list of {item, licence, credit} strings.");
  }
  if (!isObj(v.notes)) throw new Error("notes is missing.");
  for (const k of NOTE_KEYS) {
    if (!Array.isArray(v.notes[k]) || !v.notes[k].every(isStr)) throw new Error(`notes.${k} must be a list of strings.`);
  }
}

// ---------- calls ----------

async function checkSize(host, brief) {
  let max = DEFAULT_MAX_CHARS;
  try {
    const lim = await host?.claude?.limits?.();
    if (typeof lim?.maxInputChars === "number" && Number.isFinite(lim.maxInputChars)) max = lim.maxInputChars;
  } catch { /* no limits reported: use the default */ }
  const n = String(brief ?? "").length;
  if (n > max) throw new ClaudeError("too_big", BRIEF_TOO_BIG.replace("<n>", String(n)).replace("<max>", String(max)));
}

// One retry when the answer fails the checks: the error goes back to Claude and the cache is skipped.
async function withRetry(call) {
  try {
    return await call({}, undefined);
  } catch (e) {
    if (!(e instanceof ClaudeError) || e.code !== "invalid") throw e;
    return call({ previousError: e.message }, false);
  }
}

const ask = (host, instructions, data, validate) =>
  withRetry((extra, cache) => askJson(host, { instructions, data: { ...data, ...extra }, tier: "default", validate, cache }));

const numbered = (script) => clipList(script).map(({ n, section, clip }) => ({ n, section: section?.name ?? "", ...clip }));

export async function writeClips(host, { brief, reference, pronunciations, setup, note, current }) {
  await checkSize(host, brief);
  const data = { brief, reference: reference ?? null, pronunciations: pronunciations ?? null, setup };
  if (note !== undefined || current !== undefined) Object.assign(data, { note: note ?? null, current: current ?? null });
  const r = await ask(host, CLIPS_INSTRUCTIONS, data, checkClips);
  return { title: r.title, buildLine: r.buildLine, key: r.key, sections: r.sections };
}

export async function writeLists(host, { brief, setup, sections }) {
  await checkSize(host, brief);
  const clips = numbered({ sections });
  const r = await ask(host, LISTS_INSTRUCTIONS, { brief, setup, clips }, (v) => checkLists(v, clips.length));
  return { shots: r.shots, sfx: r.sfx, music: r.music, archive: r.archive, notes: r.notes };
}

export async function redoClip(host, { brief, setup, script, n, note }) {
  await checkSize(host, brief);
  const clips = numbered(script);
  if (!clips.some((c) => c.n === n)) throw new ClaudeError("invalid", `Clip ${two(n)} is not in the script.`);
  const data = { brief, setup, clips, n, note, pronunciations: script?.pronunciations ?? [] };
  const r = await ask(host, CLIP_INSTRUCTIONS, data, (v) => checkClip(v, n));
  return { narration: r.narration, spoken: r.spoken, cue: r.cue, delivery: r.delivery, pronunciations: r.pronunciations };
}
