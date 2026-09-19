# CET API + MySQL production stack

This Compose stack keeps MySQL on an internal Docker network. The API joins only
that private network and the Docker network already used by the 1Panel OpenResty
container; it has no published host port. OpenResty proxies same-origin `/api/`
to the private DNS alias `cet-word-api:3000`. Neither MySQL nor the API is
publicly reachable.

## Server preparation

Copy the entire repository deployment inputs to `/opt/cet-word-stack` on the
server (the Docker build context must include `package.json`, `pnpm-lock.yaml`,
`server/`, `database/`, and `project/deploy/docker/`). Then create the runtime
environment file without placing a real secret in shell history:

```bash
cd /opt/cet-word-stack
install -m 600 /dev/null server/.env
editor server/.env
```

Use `server.env.production.example` as the field list. `APP_ORIGIN` must be the
final HTTPS origin and `COOKIE_SECURE` must remain `true`. Do not start this as a
production login service on the current HTTP-only IP address.

Before starting Compose, discover the exact network name used by the existing
OpenResty container and put that name in `OPENRESTY_NETWORK`; do not guess it:

```bash
docker inspect openresty --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{"\\n"}}{{end}}'
```

This is necessary because an OpenResty container's `127.0.0.1` is its own
loopback, not the host's loopback.

## Start, migrate, and initialize

From this directory, use the Compose file explicitly:

```bash
docker compose -f project/deploy/docker/compose.yaml --env-file server/.env up -d mysql
docker compose -f project/deploy/docker/compose.yaml --env-file server/.env --profile maintenance run --rm migrate
docker compose -f project/deploy/docker/compose.yaml --env-file server/.env up -d api
docker compose -f project/deploy/docker/compose.yaml ps
```

Run the one-account initializer only from an attached API container so the
password prompt stays hidden and is never passed as a command argument:

```bash
docker compose -f project/deploy/docker/compose.yaml --env-file server/.env exec api node server/scripts/create-user.ts --email you@example.com --username "Your name"
```

After the OpenResty `/api/` change below has been reloaded, check the live
same-origin paths. The expected health/ready/auth-me response statuses are
`200`, `200`, and `401` respectively. If migration fails, inspect
`schema_migrations` and the actual schema before retrying; do not remove the
Docker volume.

For a nonstandard runtime-env location, set `CET_WORD_ENV_FILE` to its absolute
path for the command; Compose otherwise reads `server/.env` from the repository
root. This override exists for validation and automation, not for putting
secrets into a command line.

## OpenResty and static release

Back up `/opt/1panel/www/conf.d/cet-word-web.conf`, add the reviewed contents of
`../1panel/openresty.conf.example` to the site server block, then run `nginx -t`
inside the OpenResty container before reloading it. Its upstream is
`cet-word-api:3000`, which resolves only after the API is running on the shared
external Docker network. Upload the complete `dist/` contents only after the API
checks succeed.

The current public IP is HTTP only. HTTPS, DNS, and a certificate remain a
required external prerequisite before the Secure session cookie can be accepted
by browsers, so this repository change deliberately does not claim a live login.
