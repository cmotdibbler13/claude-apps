// A clip's audio: the line's stretch of the joined voiceover, cut and padded to whole seconds (as MP3: Higgsfield
// stores audio as MP3, and Wan 2.7 lip-synced the MP3 in the trial), and a
// signature (length + hash) of that cut so a later join can tell whether the line's audio changed.

// -ss/-to trim the INPUT: as output options -to would also cut off the apad silence.
export const clipAudioArgs = ({ wav, start, end, seconds, out }) =>
  ["-y", "-ss", String(start), "-to", String(end), "-i", wav, "-af", `apad=whole_dur=${seconds}`, "-ar", "48000", "-c:a", "libmp3lame", "-b:a", "192k", clipAudioFile(out)];

export const clipAudioFile = (out) => `${out}_audio.mp3`;

export async function audioSigOf(host, file, lengthS) {
  const bytes = await host.fs.read(file);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { lengthS: Math.round(lengthS * 100) / 100, hash };
}
