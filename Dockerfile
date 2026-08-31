# syntax=docker/dockerfile:1
# Server image for the web app (apps/web) on a plain Docker host (VPS).
# Vercel ignores this file entirely; `output: "standalone"` in next.config.ts
# is what makes this image possible and is a no-op there.

FROM node:22-alpine AS builder
WORKDIR /repo

# Manifests first, so the dependency layer caches across source changes.
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/field/package.json apps/field/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/auth/package.json packages/auth/
COPY packages/notify/package.json packages/notify/
COPY packages/files/package.json packages/files/
COPY packages/docs/package.json packages/docs/

# Only the web workspace and its workspace dependencies. The field app is an
# Expo project; installing it would drag native tooling into a server image
# that never runs it. Its package.json is copied above only so the lockfile
# sync check can see every workspace.
RUN npm ci --workspace=@meridian/web --include-workspace-root

COPY apps/web apps/web
COPY packages packages

# ── Build-time identity ──────────────────────────────────────────────────────
# The marketing pages are statically rendered, so everything below is baked
# into HTML at BUILD time, not read at runtime: canonical URLs, JSON-LD, the
# company identity in the footer and the legal pages. Changing any of these
# means rebuilding the image, not restarting it.
#
# With no COMPANY_* values provided, the build only succeeds when
# ALLOW_PLACEHOLDER_IDENTITY=1, and the site shows placeholder identity —
# packages/core/src/company.ts is the guard and explains why.
ARG NEXT_PUBLIC_SITE_URL
ARG ALLOW_PLACEHOLDER_IDENTITY=
ARG COMPANY_LEGAL_NAME=
ARG COMPANY_TRADING_NAME=
ARG COMPANY_BRAND_NAME=
ARG COMPANY_LICENCE_NUMBER=
ARG COMPANY_LICENCE_ISSUER=
ARG COMPANY_LICENCE_EXPIRY=
ARG COMPANY_CR_NUMBER=
ARG COMPANY_TRN=
ARG COMPANY_PHONE=
ARG COMPANY_EMERGENCY_PHONE=
ARG COMPANY_WHATSAPP=
ARG COMPANY_EMAIL=
ARG COMPANY_ADDRESS_STREET=
ARG COMPANY_ADDRESS_CITY=
ARG COMPANY_ADDRESS_REGION=
ARG COMPANY_ADDRESS_COUNTRY=
ARG COMPANY_LAT=
ARG COMPANY_LNG=

ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    ALLOW_PLACEHOLDER_IDENTITY=$ALLOW_PLACEHOLDER_IDENTITY \
    COMPANY_LEGAL_NAME=$COMPANY_LEGAL_NAME \
    COMPANY_TRADING_NAME=$COMPANY_TRADING_NAME \
    COMPANY_BRAND_NAME=$COMPANY_BRAND_NAME \
    COMPANY_LICENCE_NUMBER=$COMPANY_LICENCE_NUMBER \
    COMPANY_LICENCE_ISSUER=$COMPANY_LICENCE_ISSUER \
    COMPANY_LICENCE_EXPIRY=$COMPANY_LICENCE_EXPIRY \
    COMPANY_CR_NUMBER=$COMPANY_CR_NUMBER \
    COMPANY_TRN=$COMPANY_TRN \
    COMPANY_PHONE=$COMPANY_PHONE \
    COMPANY_EMERGENCY_PHONE=$COMPANY_EMERGENCY_PHONE \
    COMPANY_WHATSAPP=$COMPANY_WHATSAPP \
    COMPANY_EMAIL=$COMPANY_EMAIL \
    COMPANY_ADDRESS_STREET=$COMPANY_ADDRESS_STREET \
    COMPANY_ADDRESS_CITY=$COMPANY_ADDRESS_CITY \
    COMPANY_ADDRESS_REGION=$COMPANY_ADDRESS_REGION \
    COMPANY_ADDRESS_COUNTRY=$COMPANY_ADDRESS_COUNTRY \
    COMPANY_LAT=$COMPANY_LAT \
    COMPANY_LNG=$COMPANY_LNG

RUN npm run build --workspace=@meridian/web

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0

RUN addgroup -S app && adduser -S app -G app \
    # The local file-store root. A named volume mounted here inherits this
    # ownership on first use, so the non-root server can write uploads.
    && mkdir -p /data/files && chown -R app:app /data/files

# Standalone output contains the traced node_modules and the workspace layout;
# static assets and /public are served by the same server and copied alongside.
COPY --from=builder --chown=app:app /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=app:app /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=app:app /repo/apps/web/public ./apps/web/public

USER app
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
