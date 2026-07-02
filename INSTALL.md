# infra-map — install

## What it is
FastAPI service that polls a set of services declared in `services.yaml` and renders a live topology dashboard at `http://<host>:8088/`.

Checks per tile:
- **ICMP** — real `ping -c1`
- **TCP** — asyncio connect to the service port
- **HTTP** — `GET version_url` / `health_url` / `http_url`, parses `version` field into the tile chip

Browser polls `/api/probe` every **30 s**; server caches results for **25 s**.

## First-time setup

```bash
# copy the example config and edit it to describe your topology
cp services.example.yaml services.yaml
$EDITOR services.yaml
```

## Run locally (dev)

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m app
```

Open http://127.0.0.1:8088/ (or whatever `listen.host:port` you set in `services.yaml`).

For hot-reload during development you can still use uvicorn directly:

```bash
.venv/bin/uvicorn app.main:app --reload
```

`--reload` overrides the config's listen block; use `--host`/`--port` to match if needed.

## Install as a systemd service

```bash
# 1. create user + dir
sudo useradd --system --home-dir /opt/infra-map --shell /usr/sbin/nologin infra-map
sudo mkdir -p /opt/infra-map
sudo chown infra-map:infra-map /opt/infra-map

# 2. copy the repo contents to /opt/infra-map
sudo -u infra-map rsync -a /path/to/infra-map/ /opt/infra-map/

# 3. venv + deps
sudo -u infra-map python3 -m venv /opt/infra-map/venv
sudo -u infra-map /opt/infra-map/venv/bin/pip install -r /opt/infra-map/requirements.txt

# 4. install systemd unit
sudo cp /opt/infra-map/install/infra-map.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now infra-map
sudo systemctl status infra-map
```

## Verify

```bash
curl -s http://127.0.0.1:8088/api/probe  | jq '.results | keys'
curl -s http://127.0.0.1:8088/api/config | jq '.edge_groups'
```

## Reverse proxy (nginx example)

The service binds `127.0.0.1:8088` — front it with nginx (or your reverse proxy of choice).

### At the site root — `https://map.example.com/`

```nginx
server {
    server_name map.example.com;

    location / {
        proxy_pass http://127.0.0.1:8088;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    listen 443 ssl;
    # ... TLS bits
}
```

### Under a subpath — `https://example.com/map/`

The frontend uses relative URLs, so no app-side config is needed — just strip the prefix in nginx (trailing slashes on both sides):

```nginx
server {
    server_name example.com;

    location = /map { return 301 /map/; }   # /map → /map/ (so relative asset URLs resolve correctly)

    location /map/ {
        proxy_pass http://127.0.0.1:8088/;  # trailing "/" strips the /map/ prefix
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    listen 443 ssl;
}
```

Put it behind basic auth or an IP allow-list if you don't want it public.

## ICMP note

Debian/Ubuntu ship `/bin/ping` with `cap_net_raw+ep` file capabilities, so ICMP works for the unprivileged `infra-map` user out of the box. Confirm:

```bash
getcap /bin/ping
# should print:  /bin/ping cap_net_raw=ep
```

If your distro doesn't set it:

```bash
sudo setcap cap_net_raw+ep /bin/ping
```

If ICMP still refuses, TCP + HTTP checks still work and the ICMP row will just show FAIL — overall tile status uses HTTP as the primary signal.

## Editing the topology

Change `services.yaml` and restart:

```bash
sudo systemctl restart infra-map
```

## Logs

```bash
sudo journalctl -u infra-map -f
```
