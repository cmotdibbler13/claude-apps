// Memoryless Claude calls: instructions plus one task's data, JSON back, validated.
export class ClaudeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ClaudeError";
    this.code = code;
  }
}

const CODE_MAP = { refused: "refusal", invalid_json: "bad_json" };

// signal (AbortSignal) cancels the call; cache: false stops the runtime replaying an earlier answer.
export async function askJson(host, { instructions, data, tier = "default", validate, images, signal, cache }) {
  if (!host?.claude) throw new ClaudeError("unavailable", "Claude is not available in this view.");
  const input = `${instructions}\n\nDATA (JSON):\n${JSON.stringify(data ?? null)}\n\nAnswer with JSON only.`;
  let out;
  try {
    const opts = { tier };
    if (images?.length) opts.images = images;
    if (signal) opts.signal = signal;
    if (cache !== undefined) opts.cache = cache;
    out = await host.claude.json(input, opts);
  } catch (e) {
    const raw = e?.code ?? "upstream_error";
    throw new ClaudeError(CODE_MAP[raw] ?? raw, e?.message ?? String(e));
  }
  if (validate) {
    try {
      validate(out);
    } catch (e) {
      throw new ClaudeError("invalid", e?.message ?? String(e));
    }
  }
  return out;
}
