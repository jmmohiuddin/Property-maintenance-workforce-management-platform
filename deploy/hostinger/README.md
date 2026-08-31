# Hostinger VPS deployment

**As deployed (2026-08-31):** `https://sats.phoyev.com` on the shared VPS
`voltix-prod` (1942134, 200.234.43.179). That VPS already runs two production
stacks behind ONE Caddy that owns ports 80/443, so this deployment does NOT
run its own Caddy — it joins the existing one, exactly the way Meraki PMS
does (the pattern is documented inside
`/opt/voltix/infra/production/Caddyfile` itself).

The live shape:

- `/opt/meridian-sats/docker-compose.yml` — two services: `web`
  (image `meridian-sats:prod`, container name `meridian-sats`, joined to the
  external `voltix-prod_voltix` network, host-debug port `127.0.0.1:3200`)
  and `cron` (busybox crond, 13 schedules mirroring `apps/web/vercel.json`).
- `/opt/meridian-sats/.env` — runtime secrets, `chmod 600`, never committed.
- One site block appended to the shared Caddyfile:
  `sats.phoyev.com { reverse_proxy meridian-sats:3000 }` — Caddy resolves the
  container name over the shared network and terminates TLS.
- The image is **built off-box** (`docker build --platform linux/amd64`,
  build args from the Dockerfile) and shipped with
  `docker save | gzip | ssh root@VPS "gunzip | docker load"`. The VPS never
  spends CPU building; the two production stacks never feel a deploy. On
  Apple Silicon the `--platform linux/amd64` flag is NOT optional — an arm64
  image dies on the VPS with `exec format error`.

## Shipping new code

```
docker build --platform linux/amd64 \
  --build-arg NEXT_PUBLIC_SITE_URL=https://sats.phoyev.com \
  --build-arg ALLOW_PLACEHOLDER_IDENTITY=1 \
  -t meridian-sats:prod-amd64 .
docker save meridian-sats:prod-amd64 | gzip | \
  ssh root@200.234.43.179 "gunzip | docker load \
    && docker tag meridian-sats:prod-amd64 meridian-sats:prod \
    && cd /opt/meridian-sats && docker compose up -d web \
    && docker image prune -f"
```

Remember the database: new migrations must be applied to Neon (in filename
order, then ALL `packages/db/sql/*.sql` files in the README's order, then
`verify-rls.sql` must pass) **before** shipping code that expects them.

## Touching the shared Caddy

The Caddyfile belongs to the voltix stack and fronts every site on the box.
Any edit follows the same discipline used to add this site: back the file up,
append, `caddy validate --config /etc/caddy/Caddyfile` inside the container,
and only then `caddy reload`. A reload with an invalid config is refused by
Caddy, but validate-first means never finding that out in production.

## DNS

`sats` is one `A` record → 200.234.43.179 (TTL 300), added via the DNS API
with `"overwrite": false` — the flag that appends instead of replacing, on a
zone that also carries five other production hostnames.

## The template file

`docker-compose.template.yml` in this directory describes the ORIGINAL
standalone design (own Caddy, build-from-git on the VPS). It remains correct
for a dedicated VPS with free ports 80/443; it is NOT what runs on
`voltix-prod`, and deploying it there would collide with the existing Caddy.

## Things that are true and easy to forget

- `NEXT_PUBLIC_SITE_URL` and the whole company identity are **build args**:
  they are baked into static HTML. Changing them is a rebuild
  (`.../docker/{name}/update` after changing the compose build args), not a
  restart.
- Until real `COMPANY_*` values are supplied, the build requires
  `ALLOW_PLACEHOLDER_IDENTITY=1` and the site shows placeholder identity.
  That flag exists for exactly this staging situation; unset it the moment
  real identity is available, and the build itself will then enforce that
  the identity is complete (see `packages/core/src/company.ts`).
- Uploads land in the `files_data` volume (`FILES_LOCAL_ROOT=/data/files`).
  No ClamAV is configured, so scans are recorded as `skipped` and labelled
  that way in the UI — honest, and reversible by adding a clamav service and
  `CLAMAV_HOST` later (it wants ~1.3 GB RAM, so check the VM has headroom).
- The cron container's crontab mirrors `apps/web/vercel.json`. A schedule
  changed there without changing the template here silently diverges the two
  deployments.
- Two deployments (Vercel + VPS) serve the same site with different
  canonical URLs. Fine for staging; before real launch, pick one canonical
  home and de-index or redirect the other.
