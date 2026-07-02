import asyncio
import re
import time
from typing import Any
from urllib.parse import urlparse

import httpx

PING_RE = re.compile(r"time[=<]([\d.]+)\s*ms")


async def icmp_ping(host: str, timeout: float = 2.0) -> dict[str, Any]:
    try:
        proc = await asyncio.create_subprocess_exec(
            "ping", "-c", "1", "-W", str(int(max(1, timeout))), host,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        return {"ok": False, "error": "ping-binary-missing", "rtt_ms": None}

    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout + 2)
    except asyncio.TimeoutError:
        proc.kill()
        return {"ok": False, "error": "timeout", "rtt_ms": None}

    text = stdout.decode(errors="replace")
    m = PING_RE.search(text)
    if proc.returncode == 0 and m:
        return {"ok": True, "rtt_ms": float(m.group(1))}
    return {"ok": False, "error": "unreachable", "rtt_ms": None}


async def tcp_connect(host: str, port: int, timeout: float = 3.0) -> dict[str, Any]:
    start = time.perf_counter()
    try:
        fut = asyncio.open_connection(host, port)
        reader, writer = await asyncio.wait_for(fut, timeout=timeout)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return {"ok": True, "rtt_ms": round((time.perf_counter() - start) * 1000, 1)}
    except asyncio.TimeoutError:
        return {"ok": False, "error": "timeout", "rtt_ms": None}
    except OSError as e:
        return {"ok": False, "error": e.strerror or str(e) or "connect-failed", "rtt_ms": None}


async def http_probe(
    client: httpx.AsyncClient,
    url: str,
    timeout: float = 5.0,
    ok_statuses: list[int] | None = None,
) -> dict[str, Any]:
    start = time.perf_counter()
    try:
        r = await client.get(url, timeout=timeout, follow_redirects=False)
    except httpx.TimeoutException:
        return {"ok": False, "error": "timeout", "rtt_ms": None}
    except httpx.HTTPError as e:
        return {"ok": False, "error": type(e).__name__, "rtt_ms": None}

    rtt = round((time.perf_counter() - start) * 1000, 1)
    ok = r.status_code in ok_statuses if ok_statuses else 200 <= r.status_code < 300

    version = None
    body_preview = None
    try:
        data = r.json()
        if isinstance(data, dict):
            version = data.get("version") or data.get("app_version")
    except Exception:
        if r.text:
            body_preview = r.text[:120]

    return {
        "ok": ok,
        "status": r.status_code,
        "rtt_ms": rtt,
        "version": version,
        "body_preview": body_preview,
    }


def _parse_url(url: str) -> tuple[str | None, int | None]:
    """Return (host, port) from a URL, defaulting port to 443/80 by scheme."""
    p = urlparse(url)
    host = p.hostname
    port = p.port or (443 if p.scheme == "https" else 80 if p.scheme == "http" else None)
    return host, port


def _parse_tcp(spec: str) -> tuple[str, int]:
    """Parse 'host:port' string."""
    host, port = spec.rsplit(":", 1)
    return host, int(port)


def _derive_probe_endpoints(svc: dict) -> tuple[str | None, tuple[str, int] | None]:
    """
    Given a probe target, decide what to ICMP-ping and what to TCP-connect to.

    ICMP: prefer svc['ip'] (instance IP); fall back to the host of the first URL/tcp.
    TCP:  from svc['tcp'] if set, else derived from the first available URL.
    """
    urls = [svc.get(k) for k in ("version_url", "health_url", "http_url")]
    urls = [u for u in urls if u]

    first_url_host, first_url_port = (None, None)
    if urls:
        first_url_host, first_url_port = _parse_url(urls[0])

    icmp_host = svc.get("ip") or first_url_host
    if not icmp_host and svc.get("tcp"):
        icmp_host = _parse_tcp(svc["tcp"])[0]

    tcp_target = None
    if svc.get("tcp"):
        tcp_target = _parse_tcp(svc["tcp"])
    elif first_url_host and first_url_port:
        tcp_target = (first_url_host, first_url_port)

    return icmp_host, tcp_target


async def probe_service(client: httpx.AsyncClient, svc: dict) -> dict[str, Any]:
    tasks: dict[str, Any] = {}

    icmp_host, tcp_target = _derive_probe_endpoints(svc)
    if icmp_host:
        tasks["icmp"] = icmp_ping(icmp_host)
    if tcp_target:
        tasks["tcp"] = tcp_connect(*tcp_target)

    if svc.get("version_url"):
        tasks["version"] = http_probe(client, svc["version_url"])
    if svc.get("health_url"):
        tasks["health"] = http_probe(client, svc["health_url"])
    if svc.get("http_url"):
        tasks["http"] = http_probe(
            client, svc["http_url"], ok_statuses=svc.get("http_ok_statuses"),
        )

    keys = list(tasks.keys())
    results = await asyncio.gather(*tasks.values(), return_exceptions=True)

    checks: dict[str, Any] = {}
    for k, r in zip(keys, results):
        if isinstance(r, Exception):
            checks[k] = {"ok": False, "error": type(r).__name__}
        else:
            checks[k] = r

    return {
        "id": svc["id"],
        "overall": _overall_status(checks),
        "checks": checks,
    }


def _overall_status(checks: dict) -> str:
    """
    Reduce per-tile checks into: up | degraded | down | unknown.

    Rules:
      - If an HTTP probe (version/health/http) is defined, it is the primary signal.
      - TCP alone counts as "up" for services without HTTP probes.
      - HTTP down but TCP up => degraded (port open, app broken).
    """
    if not checks:
        return "unknown"

    http_keys = [k for k in ("version", "health", "http") if k in checks]
    tcp = checks.get("tcp")
    icmp = checks.get("icmp")

    if http_keys:
        oks = [checks[k].get("ok") for k in http_keys]
        if all(oks):
            return "up"
        if any(oks):
            return "degraded"
        if tcp and tcp.get("ok"):
            return "degraded"
        return "down"

    if tcp and tcp.get("ok"):
        return "up"
    if icmp and icmp.get("ok"):
        return "degraded"
    return "down"
