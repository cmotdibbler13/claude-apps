// A clip's audio: the line's stretch of the joined voiceover, cut and padded to whole seconds, and a
// signature (length + hash) of that cut so a later join can tell whether the line's audio changed.

export const clipAudioArgs = ({ wav, start, end, seconds, out }) =>
  ["-y", "-i", wav, "-ss", String(start), "-to", String(end), "-af", `apad=whole_dur=${seconds}`, "-ar", "48000", `${out}_audio.wav`];

export async function audioSigOf(host, file, lengthS) {
  const bytes = await host.fs.read(file);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { lengthS: Math.round(lengthS * 100) / 100, hash };
}
