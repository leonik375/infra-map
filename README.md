# infra-map

A simple single-page, live topology dashboard for your small infrastructure. Declare your
servers, services, and their data-flow relations in one YAML file; the backend
actively probes each service (ICMP + TCP + HTTP) and the frontend renders a
map with coloured tiles, hoverable edges, and per-service check details.

Small, self-contained, no external dependencies at runtime beyond `ping`.

## Features

- **Declarative config** — one `services.yaml` describes regions, servers,
  services, URLs, and dependency edges. No code changes to add a node.
- **Active checks** — every 30 s the backend runs, per service:
  - `ICMP` — real `ping -c1` against the instance IP
  - `TCP` — asyncio `open_connection` to the URL host:port (or explicit `tcp:`)
  - `HTTP` — `GET version_url` / `health_url` / `http_url`, parses `version`
    from JSON into a chip on the tile
- **Grouped edges** — group edges (e.g. `app` / `internal` / `external`),
  toggle groups on/off from the topbar, state persists in localStorage.
  Groups are auto-inferred from region topology and can be overridden per edge.
- **Regional layout** — top strip for external providers, main row for
  geographic regions. Servers appear as boxes containing their services.
- **Cache-friendly** — server caches probe results for 25 s so many browser
  tabs don't multiply the outbound probe load.
- **Prefix-agnostic** — serve at `/` or under `/map/`, controlled purely by
  your reverse proxy.

## Quick start

```bash
git clone https://github.com/leonik375/infra-map.git
cd infra-map

python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

cp services.example.yaml services.yaml
$EDITOR services.yaml

.venv/bin/python -m app
```
## Config sketch

```yaml
poll_interval: 30
cache_ttl: 25

listen:
  host: 127.0.0.1
  port: 8088

edge_groups:
  app:      { label: "App" }
  internal: { label: "Internal" }
  external: { label: "External" }

regions:
  clients:
    label: "Mobile Apps"
    row: top                    # top strip (external providers / clients)
    services:
      app-prod:
        label: "Example App"
        env: prod
        depends_on:
          api-prod: "API"       # data-flow edge; group auto-inferred as "app"

  us-east:
    label: "US East"
    instances:
      prod:                     # a server; groups its services in a box
        kind: dedicated-server
        provider: ProviderX
        ip: 203.0.113.10
        services:
          api-prod:
            label: api
            env: prod
            version_url: https://api.example.com/version
            depends_on:
              db-prod: "reads/writes"
              stripe:  {label: "payments", group: external}   # explicit group override
```

See `services.example.yaml` for a fuller worked example.

### Per-service check declarations

Any subset of these unlocks the matching check:

| key                | probe run                                              |
| ------------------ | ------------------------------------------------------ |
| `version_url`      | `GET`, expects 2xx; parses `{version}` into tile chip  |
| `health_url`       | `GET`, expects 2xx                                     |
| `http_url`         | `GET`, `http_ok_statuses:` overrides the 2xx default   |
| `tcp: host:port`   | asyncio TCP connect                                    |
| *(any URL or IP)*  | ICMP against instance IP, else the URL host            |

`_overall_status()`: if any HTTP probe is defined, HTTP is the primary signal
(all-ok → up, some-ok → degraded, all-fail → down). Without HTTP, TCP alone
means up; ICMP alone means degraded. No probes defined → unknown.

### Edge groups

Each edge belongs to a group (used by the topbar toggle buttons). Groups are
auto-inferred:

- source region `clients` → **app**
- target region has `row: top` → **external**
- otherwise → **internal**

Override per edge with the dict form:

```yaml
depends_on:
  target-id: {label: "…", group: <group_id>}
```

Add new groups to `edge_groups:` and use them in overrides — the frontend
renders one toggle per declared group, in yaml order.

## Deployment

See [INSTALL.md](INSTALL.md) for:

- systemd unit setup
- nginx reverse proxy (root or subpath)
- ICMP capability note
- log/restart commands

## Layout

```
app/
  main.py       # FastAPI app, config loading, /api/config, /api/probe
  probes.py     # ICMP + TCP + HTTP probes, overall-status reduction
  __main__.py   # entrypoint that reads listen.host/port from config
static/
  index.html    # single-page shell + templates
  map.js        # rendering, SVG edges, filter toggles, refresh loop
  map.css       # dark theme
services.example.yaml
services.yaml   # (gitignored) your real config
requirements.txt
install/
  infra-map.service
INSTALL.md
```

