// Credits left in the paid accounts Studio uses, for the top bar and the tray. Reading a balance is free.
// Runway isn't here: its connector has no balance tool.
const n = (v) => Math.round(Number(v)).toLocaleString("en-GB");
const obj = (r) => { if (typeof r === "string") { try { return JSON.parse(r); } catch { return null; } } return r ?? null; };

export async function readCredits(host) {
  if (!host?.mcp) return null;
  const ask = async (s, t) => { try { return obj(await host.mcp.call(s, t, {})); } catch { return null; } };
  const [hf, el] = await Promise.all([ask("Higgsfield", "balance"), ask("ElevenLabs", "account_get_usage")]);
  return {
    higgsfield: Number.isFinite(Number(hf?.credits)) ? { credits: Number(hf.credits) } : null,
    elevenlabs: Number.isFinite(Number(el?.character_limit)) ? {
      left: Math.max(0, Number(el.character_limit) - (Number(el.character_count) || 0)),
      limit: Number(el.character_limit),
      resetAt: el.next_character_count_reset_unix ? Number(el.next_character_count_reset_unix) * 1000 : null,
    } : null,
  };
}

export function creditsLine(c) {
  if (!c) return null;
  const hf = c.higgsfield ? n(c.higgsfield.credits) : "–";
  const el = c.elevenlabs ? `${n(c.elevenlabs.left)} of ${n(c.elevenlabs.limit)}` : "–";
  return `Higgsfield ${hf} · ElevenLabs ${el}`;
}

export function creditsTitle(c) {
  if (!c) return "";
  const reset = c.elevenlabs?.resetAt ? `, renews ${new Date(c.elevenlabs.resetAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "";
  return `Credits left. Higgsfield: credits. ElevenLabs: characters this month${reset}. Runway: check runwayml.com (no balance in its connector).`;
}

export function makeCredits(host) {
  let now = null, busy = null;
  const fns = new Set();
  return {
    refresh() {
      if (busy) return busy;
      busy = readCredits(host).then((c) => { now = c; busy = null; for (const f of fns) try { f(c); } catch { /* ignore */ } return c; },
        () => { busy = null; return now; });
      return busy;
    },
    get: () => now,
    line: () => creditsLine(now),
    title: () => creditsTitle(now),
    onChange(f) { fns.add(f); return () => fns.delete(f); },
  };
}
