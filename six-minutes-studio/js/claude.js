// Memoryless Claude calls: instructions plus one task's data, JSON back, validated.
export class ClaudeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ClaudeError";
    this.code = code;
  }
}

const CODE_MAP = { refused: "refusal", invalid_json: "bad_json" };

export async function askJson(host, { instructions, data, tier = "default", validate }) {
  if (!host?.claude) throw new ClaudeError("unavailable", "Claude is not available in this view.");
  const input = `${instructions}\n\nDATA (JSON):\n${JSON.stringify(data ?? null)}\n\nAnswer with JSON only.`;
  let out;
  try {
    out = await host.claude.json(input, { tier });
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
