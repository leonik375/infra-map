import asyncio
import time
from pathlib import Path

import httpx
import yaml
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .probes import probe_service

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BASE_DIR / "services.yaml"
STATIC_DIR = BASE_DIR / "static"

with open(CONFIG_PATH) as f:
    CONFIG = yaml.safe_load(f)

CACHE_TTL: float = float(CONFIG.get("cache_ttl", 25))
POLL_INTERVAL: int = int(CONFIG.get("poll_interval", 30))

_listen = CONFIG.get("listen") or {}
LISTEN_HOST: str = str(_listen.get("host", "127.0.0.1"))
LISTEN_PORT: int = int(_listen.get("port", 8088))

app = FastAPI(title="Infrastructure Map", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

_cache: dict = {"ts": 0.0, "data": None}
_lock = asyncio.Lock()


# ---------- Config traversal ----------

def _iter_service_records():
    """
    Walk the nested regions → instances → services structure and yield tuples of
    (region_id, instance_id_or_None, service_id, service_body).
    """
    for region_id, region in (CONFIG.get("regions") or {}).items():
        for inst_id, inst in (region.get("instances") or {}).items():
            for svc_id, svc in (inst.get("services") or {}).items():
                yield region_id, inst_id, svc_id, svc
        for svc_id, svc in (region.get("services") or {}).items():
            yield region_id, None, svc_id, svc


def _build_probe_targets() -> list[dict]:
    """
    Flatten the config into the input format expected by probes.probe_service.
    Inherits `ip` from the parent instance.
    """
    targets = []
    for region_id, inst_id, svc_id, svc in _iter_service_records():
        ip = None
        if inst_id:
            inst = CONFIG["regions"][region_id]["instances"][inst_id]
            ip = inst.get("ip")
        targets.append({
            "id": svc_id,
            "ip": ip,
            "version_url": svc.get("version_url"),
            "health_url": svc.get("health_url"),
            "http_url": svc.get("http_url"),
            "http_ok_statuses": svc.get("http_ok_statuses"),
            "tcp": svc.get("tcp"),
        })
    return targets


def _declared_checks(svc: dict, has_ip: bool) -> list[str]:
    """What check types the frontend should render pending badges for."""
    out = []
    # ICMP is possible whenever an IP is available OR a URL/tcp yields a host.
    if has_ip or svc.get("version_url") or svc.get("health_url") or svc.get("http_url") or svc.get("tcp"):
        out.append("icmp")
    if svc.get("tcp") or svc.get("version_url") or svc.get("health_url") or svc.get("http_url"):
        out.append("tcp")
    if svc.get("version_url"):
        out.append("version")
    if svc.get("health_url"):
        out.append("health")
    if svc.get("http_url"):
        out.append("http")
    return out


PROBE_TARGETS = _build_probe_targets()


# ---------- Public API ----------

@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/config")
async def get_config():
    """
    Emit both a nested `topology` (for rendering the layout) and a flat `services`
    map (for edge lookups and result attribution).
    """
    regions_out = []
    services_flat = {}

    for region_id, region in (CONFIG.get("regions") or {}).items():
        r = {
            "id": region_id,
            "label": region.get("label", region_id),
            "row": region.get("row", "main"),
            "instances": [],
            "services": [],  # loose
        }

        for inst_id, inst in (region.get("instances") or {}).items():
            i = {
                "id": inst_id,
                "kind": inst.get("kind"),
                "provider": inst.get("provider"),
                "ip": inst.get("ip"),
                "services": [],
            }
            for svc_id, svc in (inst.get("services") or {}).items():
                node = _service_node(svc_id, svc, region_id, inst_id, inst.get("ip"))
                i["services"].append(node)
                services_flat[svc_id] = node
            r["instances"].append(i)

        for svc_id, svc in (region.get("services") or {}).items():
            node = _service_node(svc_id, svc, region_id, None, None)
            r["services"].append(node)
            services_flat[svc_id] = node

        regions_out.append(r)

    return {
        "poll_interval": POLL_INTERVAL,
        "regions": regions_out,
        "services": services_flat,
        "edge_groups": _collect_edge_groups(),
        "edges": _collect_edges(),
    }


def _collect_edge_groups() -> list[dict]:
    """Emit the declared edge_groups as an ordered list preserving yaml order."""
    groups = CONFIG.get("edge_groups") or {}
    out = []
    for gid, g in groups.items():
        out.append({"id": gid, "label": (g or {}).get("label", gid)})
    return out


def _service_region_map() -> dict[str, tuple[str, bool]]:
    """svc_id -> (region_id, is_top_row). Used to infer edge groups."""
    m: dict[str, tuple[str, bool]] = {}
    for region_id, region in (CONFIG.get("regions") or {}).items():
        is_top = region.get("row") == "top"
        for inst in (region.get("instances") or {}).values():
            for svc_id in (inst.get("services") or {}):
                m[svc_id] = (region_id, is_top)
        for svc_id in (region.get("services") or {}):
            m[svc_id] = (region_id, is_top)
    return m


def _infer_edge_group(from_id: str, to_id: str, svc_regions: dict) -> str:
    from_region = svc_regions.get(from_id, (None, False))[0]
    to_is_top = svc_regions.get(to_id, (None, False))[1]
    if from_region == "clients":
        return "app"
    if to_is_top:
        return "external"
    return "internal"


def _collect_edges() -> list[dict]:
    """
    Walk the nested config and gather every service's `depends_on` into a flat
    edge list. Supports two forms:
      depends_on:
        target-id: "label"       # dict — mapping of target to edge label
      depends_on:
        - target-id              # list — no label
    Also merges top-level `edges:` if present (for backwards compatibility).
    """
    svc_regions = _service_region_map()
    edges: list[dict] = []

    def _emit(from_id: str, to_id: str, label: str, group: str | None):
        edges.append({
            "from": from_id,
            "to": to_id,
            "label": label,
            "group": group or _infer_edge_group(from_id, to_id, svc_regions),
        })

    for raw in CONFIG.get("edges", []) or []:
        _emit(raw["from"], raw["to"], raw.get("label", ""), raw.get("group"))

    for _, _, svc_id, svc in _iter_service_records():
        dep = svc.get("depends_on")
        if not dep:
            continue
        if isinstance(dep, dict):
            for target, val in dep.items():
                if isinstance(val, dict):
                    _emit(svc_id, target, val.get("label", ""), val.get("group"))
                else:
                    _emit(svc_id, target, val or "", None)
        elif isinstance(dep, list):
            for target in dep:
                _emit(svc_id, target, "", None)
    return edges


def _service_node(svc_id: str, svc: dict, region_id: str, inst_id: str | None, inst_ip: str | None) -> dict:
    return {
        "id": svc_id,
        "label": svc.get("label", svc_id),
        "env": svc.get("env"),
        "region": region_id,
        "instance": inst_id,
        "ip": inst_ip,
        "version_url": svc.get("version_url"),
        "health_url": svc.get("health_url"),
        "http_url": svc.get("http_url"),
        "tcp": svc.get("tcp"),
        "checks": _declared_checks(svc, bool(inst_ip)),
    }


# ---------- Probing ----------

async def _run_probes() -> dict:
    async with httpx.AsyncClient(
        headers={"User-Agent": "infra-map/1.0"},
        verify=True,
    ) as client:
        results = await asyncio.gather(*[probe_service(client, t) for t in PROBE_TARGETS])
    return {r["id"]: r for r in results}


@app.get("/api/probe")
async def probe():
    now = time.time()
    if _cache["data"] is not None and now - _cache["ts"] < CACHE_TTL:
        return {
            "cached": True,
            "age_s": round(now - _cache["ts"], 1),
            "ts": _cache["ts"],
            "results": _cache["data"],
        }
    async with _lock:
        now = time.time()
        if _cache["data"] is not None and now - _cache["ts"] < CACHE_TTL:
            return {
                "cached": True,
                "age_s": round(now - _cache["ts"], 1),
                "ts": _cache["ts"],
                "results": _cache["data"],
            }
        data = await _run_probes()
        _cache["data"] = data
        _cache["ts"] = time.time()
        return {
            "cached": False,
            "age_s": 0,
            "ts": _cache["ts"],
            "results": data,
        }
