# ADR-0008 — SSH local-forward tunnels via russh, and a five-level TLS mode

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-13 (first commit that shipped the feature)
- **Area:** Connections
- **Related:** ADR-0003, ADR-0004, ADR-0041, ADR-0046, ADR-0047, `docs/M12-mysql-postgres-ssh-tls.md`, `docs/SSH_TUNNEL_TESTING.md`

## Context

Production databases usually sit behind a bastion and/or require TLS. M12 added
MySQL and PostgreSQL and asked for SSH tunnels (key, password and ssh-agent
auth) and granular TLS modes threaded to the drivers. It also required
tunnel-status indicators. The work shipped as `0a12290` (backend), `c763dac`
(renderer) and `877f93b` (M12 merge), all on 2026-06-13. It initially replaced a
boolean `tls` flag.

## Decision

**SSH tunnel (`src-tauri/src/engines/ssh.rs`)**

- `SshConfig { host, port, user, auth: SshAuth }` lives on the server
  `ConnectionParams` variants. `SshAuth` is `Key { key_path } | Password | Agent`.
  The passphrase or password is a keychain secret under `{id}:ssh` (ADR-0004).
- `SshTunnel::open` connects to the bastion with `russh`, authenticates, binds
  `127.0.0.1:0`, and for each accepted local socket opens a `direct-tcpip`
  channel to the target `host:port`. It then runs `copy_bidirectional`.
  Dropping the tunnel aborts the accept loop and disconnects the session.
- Connectors call `open_tunnel_if_needed(params, secret)` first and then point
  the driver at `tunnel_override(&tunnel)`. The tunnel is stored inside the
  engine connection, so it lives exactly as long as the connection.
- Engines that can tunnel: MySQL, Postgres, SQL Server, ClickHouse, Typesense,
  Redis. Engines that cannot: SQLite (local file), DynamoDB (HTTPS to AWS),
  MongoDB and Cassandra ("no bastion in M18/M19").
- **Host-key policy: accept on first use.** `check_server_key` returns `true`.
  The module records this as "a conscious decision, not an oversight". A
  known-hosts TOFU store is listed as future hardening.
- The renderer shows a tunnel lock in the sidebar header and status bar
  (`connectionIsTunneled`, `tunnelTitle` in `src/features/connections/api.ts`).
  The connect modal has a "General / SSH tunnel" tab pair
  (`NewConnectionModal.tsx`). The settings connect timeout covers the whole
  attempt, tunnel included.

**TLS (`TlsMode` in `src-tauri/src/shared/ports/sql/params.rs`)**

- The modes are `disable | prefer (default) | require | verify-ca | verify-full`
  on the wire in kebab-case, following libpq `sslmode`. A custom `Deserialize`
  migrates old `tls: bool` (`true` → `prefer`, `false` → `disable`).
- Each adapter maps the mode to its driver:
  - Postgres and MySQL: `ssl_mode_from_token` → `PgSslMode` / `MySqlSslMode`.
  - SQL Server: `apply_encryption` → tiberius `EncryptionLevel`. `trust_cert`
    is used except for the verify modes.
  - MongoDB: `tls_for`. There is no "prefer", so `disable`/`prefer` mean no
    TLS, and `require` allows invalid certificates.
  - Redis: `ConnectionAddr::TcpTls`; `prefer`/`require` set `insecure: true`.
  - ClickHouse and Typesense: a `Protocol` HTTP/HTTPS choice.
  - Cassandra: connects in plaintext for `disable`/`prefer`. `require` and the
    verify modes are refused with `AppError::Unsupported` instead of being
    silently downgraded (`engines/cassandra/mod.rs`).
- The stack is pure-Rust everywhere: sqlx `tls-rustls`, tiberius `rustls`,
  redis rustls, reqwest `rustls-tls`, and russh. One rustls 0.23 is shared
  (`src-tauri/Cargo.toml`).

**Test rig:** `make tunnel-up` / `tunnel-down` start
`test-fixtures/docker-compose.tunnel.yml`. MySQL, Postgres and Redis there are
reachable only through a bastion on `127.0.0.1:2222` (`docs/SSH_TUNNEL_TESTING.md`).

## Alternatives considered

- **`ssh2` (libssh2 bindings).** Rejected in `ssh.rs` and Cargo.toml. It is
  synchronous, which would require a blocking-thread bridge, and it pulls in a
  C dependency (libssh2/OpenSSL). russh is async on the existing tokio runtime
  and cross-compiles cleanly.
- **Shelling out to the system `ssh -L`.** Not recorded. Inferred: it depends on
  an installed client and is awkward to run on Windows.
- **Strict host-key checking now.** Deferred (see above). The stated reason is
  that "the threat model already trusts the operator-typed bastion details".
- **A boolean TLS toggle.** This was the M12 Task 1/2 shape. It was replaced
  because it could not express verification levels.

## Consequences

- **Positive:** a tunnelled connection looks like a local one to every driver. There
  is no system SSH or OpenSSL dependency. Saved connections from before M12
  still load.
- **Negative / trade-offs:** bastion host keys are not verified, so a MITM on
  the bastion hop goes undetected. Over a tunnel, `verify-full` checks the
  certificate against the real host while the socket is loopback. The Redis
  adapter notes that `verify-*` over a tunnel fails, so only
  `prefer`/`require` work there. `prefer`/`require` on Redis, SQL Server and
  MongoDB skip certificate validation. There is no custom CA or client
  certificate field. Only one hop is supported (no jump chains).
- **Follow-ups:** a known-hosts TOFU store (named in `ssh.rs`), tunnels for
  MongoDB and Cassandra, and native-protocol TLS for Cassandra (the Cargo.toml
  note says it arrives "with a later M19 subtask").
