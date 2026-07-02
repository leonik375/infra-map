"use strict";

const stageEl = document.querySelector(".stage");
const regionsEl = document.getElementById("regions");
const svgEl = document.getElementById("edges");
const regionTpl = document.getElementById("region-template");
const serverTpl = document.getElementById("server-template");
const nodeTpl = document.getElementById("node-template");
const lastUpdatedEl = document.getElementById("last-updated");
const countdownEl = document.getElementById("countdown");
const refreshBtn = document.getElementById("refresh-now");
const detailsEl = document.getElementById("details");
const detailsBodyEl = detailsEl.querySelector(".details-body");
const detailsCloseBtn = detailsEl.querySelector(".details-close");
const edgeFiltersEl = document.getElementById("edge-filters");

const SVG_NS = "http://www.w3.org/2000/svg";

/* -------- palettes (code owns all visuals) -------- */

// Rotated by region declaration order. Extend or reshuffle here; no config change needed.
const REGION_PALETTE = [
  "#2b4a5e", // slate blue
  "#7a5a2f", // amber-brown
  "#2c4f39", // moss green
  "#5a2f2f", // rust red
  "#5c4a2b", // ochre
  "#4a3468", // violet
];

const ENV_STYLES = {
  "staging":  { fg: "#c8a2ff", bg: "rgba(157, 78, 221, 0.14)", border: "rgba(157, 78, 221, 0.4)" },
  "prod-ru":  { fg: "#ff8a80", bg: "rgba(248, 81, 73, 0.12)",  border: "rgba(248, 81, 73, 0.35)" },
  "prod-eu":  { fg: "#7ee787", bg: "rgba(63, 185, 80, 0.12)",  border: "rgba(63, 185, 80, 0.35)" },
  "shared":   { fg: "#f0c674", bg: "rgba(210, 153, 34, 0.12)", border: "rgba(210, 153, 34, 0.35)" },
  "external": { fg: "#b1bac4", bg: "rgba(139, 148, 158, 0.14)", border: "rgba(139, 148, 158, 0.4)" },
};

const CHECK_LABELS = { icmp: "ICMP", tcp: "TCP", version: "VER", health: "HLTH", http: "HTTP" };

/* -------- state -------- */

let cfg = null;
let servicesById = new Map();
let latestResults = null;
let pollInterval = 30;
let nextCheckAt = 0;
let refreshing = false;
let selectedNodeId = null;
let visibleGroups = new Set();

const HIDDEN_GROUPS_KEY = "infra-map:hidden-groups";

/* -------- load & render -------- */

async function loadConfig() {
  const res = await fetch("api/config");
  cfg = await res.json();
  pollInterval = cfg.poll_interval || 30;
  servicesById = new Map(Object.entries(cfg.services));
  initEdgeFilters();
  renderRegions();
}

function initEdgeFilters() {
  const groups = cfg.edge_groups || [];
  let hidden;
  try { hidden = new Set(JSON.parse(localStorage.getItem(HIDDEN_GROUPS_KEY) || "[]")); }
  catch (_) { hidden = new Set(); }
  visibleGroups = new Set(groups.map((g) => g.id).filter((id) => !hidden.has(id)));

  edgeFiltersEl.innerHTML = "";
  for (const g of groups) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "edge-filter-btn";
    btn.dataset.group = g.id;
    btn.textContent = g.label;
    btn.classList.toggle("on", visibleGroups.has(g.id));
    btn.addEventListener("click", () => toggleGroup(g.id, btn));
    edgeFiltersEl.appendChild(btn);
  }
}

function toggleGroup(id, btn) {
  if (visibleGroups.has(id)) visibleGroups.delete(id);
  else visibleGroups.add(id);
  btn.classList.toggle("on", visibleGroups.has(id));
  const allIds = (cfg.edge_groups || []).map((g) => g.id);
  const hidden = allIds.filter((x) => !visibleGroups.has(x));
  try { localStorage.setItem(HIDDEN_GROUPS_KEY, JSON.stringify(hidden)); } catch (_) {}
  drawEdges();
}

function renderRegions() {
  regionsEl.innerHTML = "";

  // Split regions into rows.
  const topRegions = cfg.regions.filter((r) => r.row === "top");
  const mainRegions = cfg.regions.filter((r) => r.row !== "top");

  const rowTop = document.createElement("div");
  rowTop.className = "region-row-top";
  rowTop.style.gridTemplateColumns = topRegions.map(() => "1fr").join(" ");

  const rowMain = document.createElement("div");
  rowMain.className = "region-row-main";
  rowMain.style.gridTemplateColumns = mainRegions.map(() => "1fr").join(" ");

  cfg.regions.forEach((region, idx) => {
    const el = renderRegion(region, idx);
    if (region.row === "top") rowTop.appendChild(el);
    else rowMain.appendChild(el);
  });

  if (topRegions.length) regionsEl.appendChild(rowTop);
  regionsEl.appendChild(rowMain);
}

function renderRegion(region, idx) {
  const section = regionTpl.content.firstElementChild.cloneNode(true);
  section.dataset.regionId = region.id;
  section.style.setProperty("--region-color", REGION_PALETTE[idx % REGION_PALETTE.length]);
  if (region.row === "top") section.classList.add("layout-horizontal");
  section.querySelector(".region-label").textContent = region.label;

  const body = section.querySelector(".region-body");
  for (const inst of region.instances) body.appendChild(renderInstance(inst));
  for (const svc of region.services) body.appendChild(renderNode(svc));
  return section;
}

function renderInstance(inst) {
  const block = serverTpl.content.firstElementChild.cloneNode(true);
  block.dataset.serverId = inst.id;
  block.querySelector(".server-label").textContent = inst.id;
  block.querySelector(".server-ip").textContent = [inst.provider, inst.ip].filter(Boolean).join(" · ");
  block.querySelector(".server-kind").textContent = inst.kind || "";
  const inner = block.querySelector(".server-body");
  for (const svc of inst.services) inner.appendChild(renderNode(svc));
  return block;
}

function renderNode(svc) {
  const node = nodeTpl.content.firstElementChild.cloneNode(true);
  node.dataset.serviceId = svc.id;
  node.querySelector(".node-label").textContent = svc.label;
  node.querySelector(".node-host").textContent = displayHost(svc);

  const envChip = node.querySelector(".env-chip");
  if (svc.env) {
    envChip.textContent = svc.env;
    envChip.dataset.env = svc.env;
    envChip.hidden = false;
    const st = ENV_STYLES[svc.env];
    if (st) {
      envChip.style.setProperty("--env-color", st.fg);
      envChip.style.setProperty("--env-bg", st.bg);
      envChip.style.setProperty("--env-border", st.border);
    }
  }

  node.addEventListener("click", (e) => { e.stopPropagation(); selectNode(svc.id); });
  node.addEventListener("mouseenter", () => highlightConnected(svc.id, true));
  node.addEventListener("mouseleave", () => highlightConnected(svc.id, false));
  return node;
}

function displayHost(svc) {
  const url = svc.version_url || svc.health_url || svc.http_url;
  if (url) {
    try {
      const u = new URL(url);
      return u.host;
    } catch (_) {}
  }
  return svc.tcp || svc.ip || "";
}

/* -------- refresh loop -------- */

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const res = await fetch("api/probe", { cache: "no-store" });
    const payload = await res.json();
    latestResults = payload.results;
    applyResults();
    drawEdges();
    if (selectedNodeId) renderDetails(selectedNodeId);
    const dt = new Date(payload.ts * 1000);
    const suffix = payload.cached ? ` (cached ${payload.age_s}s)` : "";
    lastUpdatedEl.textContent = `updated ${formatTime(dt)}${suffix}`;
  } catch (e) {
    lastUpdatedEl.textContent = `error: ${e.message || e}`;
  } finally {
    refreshing = false;
    nextCheckAt = Date.now() + pollInterval * 1000;
  }
}

function applyResults() {
  for (const [svcId, svc] of Object.entries(latestResults)) {
    const node = regionsEl.querySelector(`.node[data-service-id="${svcId}"]`);
    if (!node) continue;
    node.dataset.status = svc.overall || "unknown";

    const chip = node.querySelector(".version-chip");
    let version = null;
    for (const k of ["version", "health", "http"]) {
      if (svc.checks[k] && svc.checks[k].version) {
        version = svc.checks[k].version;
        break;
      }
    }
    if (version) { chip.textContent = `v${version}`; chip.hidden = false; }
    else chip.hidden = true;
  }
}

/* -------- SVG edges -------- */

function drawEdges() {
  for (const el of svgEl.querySelectorAll(".edge, .edge-hit, .edge-label")) el.remove();

  const stageRect = svgEl.getBoundingClientRect();
  svgEl.setAttribute("viewBox", `0 0 ${stageRect.width} ${stageRect.height}`);

  for (const edge of cfg.edges) {
    if (edge.group && !visibleGroups.has(edge.group)) continue;
    const from = regionsEl.querySelector(`.node[data-service-id="${edge.from}"]`);
    const to = regionsEl.querySelector(`.node[data-service-id="${edge.to}"]`);
    if (!from || !to) continue;

    const fromRect = from.getBoundingClientRect();
    const toRect = to.getBoundingClientRect();

    const fromCx = fromRect.left + fromRect.width / 2 - stageRect.left;
    const toCx = toRect.left + toRect.width / 2 - stageRect.left;
    const goingRight = toCx > fromCx;

    const x1 = (goingRight ? fromRect.right : fromRect.left) - stageRect.left;
    const y1 = fromRect.top + fromRect.height / 2 - stageRect.top;
    const x2 = (goingRight ? toRect.left : toRect.right) - stageRect.left;
    const y2 = toRect.top + toRect.height / 2 - stageRect.top;

    const dx = Math.abs(x2 - x1);
    const handle = Math.max(40, dx * 0.4);
    const cx1 = x1 + (goingRight ? handle : -handle);
    const cx2 = x2 + (goingRight ? -handle : handle);
    const d = `M ${x1},${y1} C ${cx1},${y1} ${cx2},${y2} ${x2},${y2}`;

    const status = latestResults?.[edge.from]?.overall || "unknown";

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", "edge");
    path.setAttribute("d", d);
    path.dataset.status = status;
    path.dataset.from = edge.from;
    path.dataset.to = edge.to;
    path.setAttribute("marker-end", `url(#arr-${status})`);
    svgEl.appendChild(path);

    const hit = document.createElementNS(SVG_NS, "path");
    hit.setAttribute("class", "edge-hit");
    hit.setAttribute("d", d);

    const title = document.createElementNS(SVG_NS, "title");
    const fromLabel = servicesById.get(edge.from)?.label || edge.from;
    const toLabel = servicesById.get(edge.to)?.label || edge.to;
    title.textContent = `${fromLabel} → ${toLabel}${edge.label ? " · " + edge.label : ""}`;
    hit.appendChild(title);

    hit.addEventListener("mouseenter", () => path.classList.add("hi"));
    hit.addEventListener("mouseleave", () => path.classList.remove("hi"));

    svgEl.appendChild(hit);
  }
}

function highlightConnected(nodeId, on) {
  const paths = svgEl.querySelectorAll(".edge");
  const nodes = regionsEl.querySelectorAll(".node");

  if (!on) {
    paths.forEach((p) => { p.classList.remove("hi"); p.classList.remove("dim"); });
    nodes.forEach((n) => n.classList.remove("dimmed"));
    return;
  }

  const connected = new Set([nodeId]);
  paths.forEach((p) => {
    if (p.dataset.from === nodeId || p.dataset.to === nodeId) {
      p.classList.add("hi");
      connected.add(p.dataset.from);
      connected.add(p.dataset.to);
    } else {
      p.classList.add("dim");
    }
  });
  nodes.forEach((n) => {
    if (!connected.has(n.dataset.serviceId)) n.classList.add("dimmed");
  });
}

/* -------- details panel -------- */

function selectNode(svcId) {
  if (selectedNodeId === svcId) { closeDetails(); return; }
  selectedNodeId = svcId;
  for (const n of regionsEl.querySelectorAll(".node")) {
    n.classList.toggle("selected", n.dataset.serviceId === svcId);
  }
  renderDetails(svcId);
  detailsEl.classList.remove("hidden");
}

function closeDetails() {
  selectedNodeId = null;
  for (const n of regionsEl.querySelectorAll(".node.selected")) n.classList.remove("selected");
  detailsEl.classList.add("hidden");
}

function renderDetails(svcId) {
  const svc = servicesById.get(svcId);
  const result = latestResults?.[svcId];
  if (!svc) return;

  const overall = result?.overall || "unknown";
  const parts = [];
  parts.push(`<h2>${escapeHtml(svc.label)}</h2>`);
  parts.push(`<div class="details-sub">${escapeHtml(displayHost(svc))}</div>`);
  parts.push(`<div class="details-status ${overall}">${overall}</div>`);

  if (result?.checks) {
    for (const [k, v] of Object.entries(result.checks)) {
      const status = v.ok ? "ok" : "fail";
      const label = v.ok ? "OK" : "FAIL";
      const bits = [];
      if (v.rtt_ms != null) bits.push(`<span class="rtt">${v.rtt_ms} ms</span>`);
      if (v.status) bits.push(`HTTP ${v.status}`);
      if (v.version) bits.push(`<span class="ver">v${escapeHtml(v.version)}</span>`);
      if (v.error) bits.push(`<span class="err">${escapeHtml(v.error)}</span>`);
      if (v.body_preview) bits.push(`<span class="err">${escapeHtml(v.body_preview)}</span>`);
      parts.push(`
        <div class="check-row">
          <span class="k">${CHECK_LABELS[k] || k}</span>
          <span class="s ${status}">${label}</span>
          <span class="d">${bits.join(" · ")}</span>
        </div>
      `);
    }
  } else {
    parts.push(`<div class="details-sub">no result yet</div>`);
  }

  detailsBodyEl.innerHTML = parts.join("");
}

detailsCloseBtn.addEventListener("click", closeDetails);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetails(); });

/* -------- utilities -------- */

function formatTime(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function tickCountdown() {
  const remaining = Math.max(0, Math.round((nextCheckAt - Date.now()) / 1000));
  countdownEl.textContent = remaining;
  if (remaining === 0 && !refreshing) refresh();
}

refreshBtn.addEventListener("click", () => { nextCheckAt = Date.now(); });
window.addEventListener("resize", () => { if (latestResults) drawEdges(); });

(async function main() {
  await loadConfig();
  nextCheckAt = Date.now();
  setInterval(tickCountdown, 1000);
  tickCountdown();
})();
