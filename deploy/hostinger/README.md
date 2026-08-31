# Hostinger VPS deployment

The web app runs on a Hostinger VPS as a three-container Compose stack —
`caddy` (TLS + reverse proxy), `web` (Next.js standalone image built from this
repo's `Dockerfile`), `cron` (busybox crond standing in for Vercel Cron). The
database stays on Neon; this deployment points at the same `meridian_app`
role the Vercel deployment uses.

## How a deploy happens

1. `deploy/hostinger/docker-compose.template.yml` has every real value as a
   `${...}` placeholder. Substitute them all (site host, database URL, cron
   secret, identity flag) — the result is never committed.
2. Post the substituted compose to the VPS through Hostinger's Docker Manager
   API (`POST /api/vps/v1/virtual-machines/{id}/docker` with `project_name`
   and `content`). Deploying the same project name replaces the stack.
3. The VPS builds the image straight from the public GitHub repo (`main`).
   To ship new code: push to `main`, then `POST .../docker/{name}/update`.

## DNS

One `A` record on the subdomain → the VPS IPv4, TTL as low as Hostinger
allows, proxying/CDN off. Caddy obtains and renews the Let's Encrypt
certificate on first request; the record must exist and resolve before the
stack starts, or the ACME challenge fails (it retries, so late DNS heals
itself within minutes).

## Firewall

Hostinger VPS firewalls default to dropping nothing until one is attached.
If a firewall is active on the VM it must accept TCP 80 and 443 (and 22 if
SSH access matters), then be **synced** — rule edits do not apply themselves.

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
