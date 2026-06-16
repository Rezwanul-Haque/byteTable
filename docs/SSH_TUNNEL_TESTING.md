# SSH-tunnel testing (bastion rig)

How to exercise ByteTable's **SSH tunnel** feature locally: a Docker rig with an
SSH **bastion** in front of a MySQL, a PostgreSQL, and a Redis that are
**not reachable from the host** — the only way in is through the bastion, so a
successful connection proves the tunnel works end to end.

Files:

- `test-fixtures/docker-compose.tunnel.yml` — the rig (bastion + 3 DBs).
- `test-fixtures/seed/seed-redis.sh` — Redis seeder (takes `BT_REDIS_CONTAINER`).
- `Makefile` targets `tunnel-up` / `tunnel-down`.

## Quick start

```bash
make tunnel-up      # start bastion + MySQL/Postgres/Redis behind it, seed Redis
make tunnel-down    # stop + wipe the rig
```

`tunnel-up` runs the rig under its **own** Compose project (`bytetable-tunnel`),
so it never touches the directly-exposed databases from `make db-up`. MySQL and
Postgres auto-seed from `test-fixtures/seed/*.sql` on first init; Redis is seeded
afterward via `BT_REDIS_CONTAINER=bt-redis-tunnel ./seed/seed-redis.sh`.

## Connect from ByteTable

In **New connection**, fill the **SSH tunnel** tab (identical for all three) and
the **General** tab. The General-tab host/port are resolved **from the bastion's
network**, so use the Compose **service name** — _not_ `localhost`.

SSH tunnel tab: Host `127.0.0.1` · Port `2222` · User `tunnel` · Auth
**password** · Password `tunnel`.

| Engine     | Host       | Port | Database  | User       | Password    |
| ---------- | ---------- | ---- | --------- | ---------- | ----------- |
| MySQL      | `mysql`    | 3306 | byteshop  | root       | bytetable   |
| PostgreSQL | `postgres` | 5432 | byteshop  | postgres   | bytetable   |
| Redis      | `redis`    | 6379 | db 0      | —          | bytetable   |

## How the tunnel works

1. ByteTable opens an SSH connection to the **bastion** (`127.0.0.1:2222`) and
   authenticates as `tunnel`.
2. It then opens a **local port forward**: it binds an ephemeral port on
   `127.0.0.1`, and asks the bastion (via an SSH `direct-tcpip` channel) to relay
   that to the **General-tab host:port** — e.g. `mysql:3306` — resolved on the
   bastion's Docker network.
3. The database driver (sqlx / rusqlite-style) connects to the local forwarded
   port. All traffic rides the encrypted SSH channel; the DB never needs a
   host-exposed port.

The app supports three SSH auth methods (`SshConfig` in
`src-tauri/src/engines/ssh.rs`): **password**, **key** (a private-key path, with
an optional passphrase), and **agent** (`SSH_AUTH_SOCK`, Unix only). The rig uses
password auth for simplicity.

> Note on protocol direction: **MySQL's server speaks first** (it sends the
> greeting before the client says anything), unlike Postgres/Redis where the
> client speaks first. A tunnel that only relays after the client sends data will
> hang on MySQL's handshake — the rig is a good regression test for that.

## The bastion

A minimal Alpine container running OpenSSH `sshd`:

```yaml
command: >
  sh -c "apk add --no-cache openssh >/dev/null &&
         ssh-keygen -A &&
         adduser -D tunnel && echo 'tunnel:tunnel' | chpasswd &&
         exec /usr/sbin/sshd -D -e -o AllowTcpForwarding=yes -o PasswordAuthentication=yes -o GatewayPorts=no"
```

Why it's written exactly this way (these are real traps that broke it):

- **`-o AllowTcpForwarding=yes` on the command line, not in `sshd_config`.** sshd
  honors the **first** occurrence of a keyword, and Alpine's default config
  already sets `AllowTcpForwarding no`. Appending `yes` to the file does nothing;
  a command-line `-o` is authoritative. Without it, sshd **refuses** the forward
  ("refused local port forward" in the bastion log) and the client sees an EOF
  mid-handshake.
- **The whole `sshd` invocation is on one line.** In a YAML folded scalar,
  more-indented continuation lines keep their newlines. In `sh -c "..."` a newline
  ends a command — so `exec /usr/sbin/sshd -D -e` on its own line would run sshd
  with the `-o` flags stranded as separate (never-executed) commands.
- **`exec`** makes sshd PID 1 so the container stops cleanly.

The DB services declare **no `ports:`** on purpose — that's what forces traffic
through the bastion.

MySQL note: there is **no official Alpine MySQL image**, so the rig uses
`mysql:8` (Postgres and Redis use `-alpine`). It also runs with
`--max-connect-errors=100000`: behind a bastion every connection shares the
bastion's IP, and MySQL's default `max_connect_errors=100` will **block that
host** after a handful of aborted/probed TCP connections — which surfaces as
"Lost connection … reading initial communication packet."

## Verify the tunnel without the app

Self-contained (a throwaway container does the SSH forward + a query):

```bash
docker run --rm --network bytetable-tunnel_tunnel-net alpine sh -c '
  apk add --no-cache openssh-client sshpass postgresql-client mysql-client >/dev/null 2>&1
  sshpass -p tunnel ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ExitOnForwardFailure=yes -fN \
    -L 15432:postgres:5432 -L 13306:mysql:3306 tunnel@bastion
  for p in 15432 13306; do for i in $(seq 1 10); do nc -z 127.0.0.1 $p && break; sleep 1; done; done
  echo "postgres:"; PGPASSWORD=bytetable psql -h127.0.0.1 -p15432 -U postgres -d byteshop -tc "select now();"
  echo "mysql:";    mysql -h127.0.0.1 -P13306 -uroot -pbytetable -e "select version();"
'
```

A Postgres row back means forwarding works. The Alpine `mysql` client may error
on `caching_sha2_password` (its plugin `.so` is absent) — that's a **client**
limitation, not the tunnel; ByteTable's sqlx client handles that auth.

Or a real local forward from your machine (closest to what the app does):

```bash
ssh -p 2222 -L 13306:mysql:3306 -L 15432:postgres:5432 tunnel@127.0.0.1   # password: tunnel
# then point any client at 127.0.0.1:13306 (MySQL) / 127.0.0.1:15432 (Postgres)
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "expected to read 4 bytes, got 0 at EOF" / "lost connection reading initial packet" | Bastion refusing forwards (AllowTcpForwarding) **or** MySQL host-blocked. `make tunnel-down && make tunnel-up` rebuilds the bastion with the fix; the high `max-connect-errors` prevents blocking. |
| "refused local port forward" in `docker logs bt-bastion` | `AllowTcpForwarding` not effective — must be the `-o` command-line flag (see above). |
| "Host is blocked" / repeated handshake EOF on MySQL | Too many aborted connects from the bastion IP. Clear it: `docker exec bt-mysql-tunnel mysql -uroot -pbytetable -e "TRUNCATE TABLE performance_schema.host_cache;"`. |
| Connection refused on the forwarded port | The DB isn't ready yet, or you used `localhost` in the General tab instead of the service name (`mysql`/`postgres`/`redis`). |
| Conflicts with `make db-up` containers | The rig uses a separate Compose project (`-p bytetable-tunnel`); always start/stop it via `make tunnel-up` / `make tunnel-down`. |
```
