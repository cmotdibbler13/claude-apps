// Boot: host, install gate, routing.
import { makeHost } from "./host.js";
import { mountProbe } from "./ui/probe.js";

const $ = (id) => document.getElementById(id);

function showView(name) {
  for (const s of document.querySelectorAll("main > section[data-view]")) s.hidden = s.dataset.view !== name;
  for (const b of document.querySelectorAll("#nav button")) b.setAttribute("aria-selected", String(b.dataset.view === name));
}

function drawIcon() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#091a2e"; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = "#d5a867"; g.lineWidth = 8; g.strokeRect(24, 24, 208, 208);
  g.fillStyle = "#d5a867"; g.font = "300 120px Inter, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText("6", 128, 136);
  return c.toDataURL("image/png");
}

async function boot() {
  $("nav").onclick = (e) => { const v = e.target.closest("button")?.dataset.view; if (v) showView(v); };
  const host = await makeHost().catch(() => null);
  if (!host) {
    for (const s of document.querySelectorAll("main > section[data-view]")) s.hidden = true;
    $("nav").hidden = true;
    $("gate").hidden = false;
    const desktop = await window.claude?.use("desktop").catch(() => null);
    if ((await desktop?.install?.state()) === "available") {
      $("gate-msg").textContent = "Install this page as an app, then allow full access when asked.";
      $("install").hidden = false;
      $("install").onclick = () => desktop.install.request().catch(() => {});
    } else {
      $("gate-msg").textContent = "This page works only in its desktop app, which can be installed from the Claude desktop app.";
    }
    return;
  }
  const desktop = await window.claude.use("desktop");
  desktop.app?.dock?.setIcon(drawIcon()).catch(() => {});
  mountProbe(host, $("run-probe"), $("probe-results"));
}

boot();
