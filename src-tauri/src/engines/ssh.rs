//! SSH tunnel infrastructure (M12 Task 3).
//!
//! Given an [`SshConfig`] (bastion host/port/user + auth method), the target
//! database `host:port`, and any SSH secret (key passphrase or password), open
//! a **local-forward tunnel**: bind a `127.0.0.1:<ephemeral>` TCP listener,
//! and for every accepted local connection open an SSH `direct-tcpip` channel
//! to the target and pump bytes both ways. The sqlx adapter then connects to
//! the local endpoint as if it were the database — see the Postgres/MySQL
//! connectors, which build their `connect_options` with the tunnel's local
//! `host`/`port` override.
//!
//! ## Driver choice — russh (not ssh2)
//!
//! `russh` is a pure-Rust, async-native SSH client. It needs no system
//! `libssh2`/OpenSSL (matching the project's deliberate `tls-rustls` choice
//! for sqlx), drives I/O on the tokio runtime already in the tree, and
//! cross-compiles cleanly for the release profile. `ssh2` (libssh2 bindings)
//! is synchronous and pulls a C dependency; it would force a blocking-thread
//! bridge and a system library. russh fits the codebase.
//!
//! ## Lifecycle
//!
//! [`SshTunnel`] owns the russh session handle and the accept-loop task. The
//! connector stores it inside the [`EngineConnection`](crate::shared::engine::EngineConnection)
//! so the tunnel lives exactly as long as the database connection. Dropping
//! the tunnel aborts the accept loop and disconnects the SSH session; the
//! [`ConnectionManager`](crate::features::connections::application::ConnectionManager)
//! drops the connection (and thus the tunnel) on `close` / `close_all`.
//!
//! ## Host-key policy
//!
//! This is a local-first desktop client; we accept the bastion's host key on
//! first use (the russh `Handler::check_server_key` returns `true`). A
//! known-hosts TOFU store is a future hardening item, documented here so it is
//! a conscious decision, not an oversight — the threat model already trusts the
//! operator-typed bastion details.

use std::sync::Arc;

use russh::client::{self, Handle};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::shared::engine::{ConnectSecret, ConnectionParams, SshAuth, SshConfig};
use crate::shared::error::AppError;

/// The database password from a transient [`ConnectSecret`], for the sqlx
/// `connect_options`. Shared by the Postgres and MySQL connectors.
pub fn db_password(secret: Option<&ConnectSecret>) -> Option<&str> {
    secret.and_then(ConnectSecret::password)
}

/// Open the SSH tunnel for `params` when it carries an [`SshConfig`], returning
/// the live tunnel (or `None` for a direct connection). Shared by the Postgres
/// and MySQL connectors: open the tunnel first, then build `connect_options`
/// with [`tunnel_override`] so the driver connects to the local endpoint. The
/// SSH secret (key passphrase / bastion password) comes from the transient
/// [`ConnectSecret`]'s `ssh` arm.
pub async fn open_tunnel_if_needed(
    params: &ConnectionParams,
    secret: Option<&ConnectSecret>,
) -> Result<Option<SshTunnel>, AppError> {
    let Some(ssh) = params.ssh() else {
        return Ok(None);
    };
    let (target_host, target_port) = match params {
        ConnectionParams::Mysql { host, port, .. }
        | ConnectionParams::Postgres { host, port, .. }
        | ConnectionParams::Mssql { host, port, .. }
        | ConnectionParams::Redis { host, port, .. } => (host.as_str(), *port),
        // SQLite (local file), DynamoDB (HTTPS to AWS), MongoDB (no bastion in
        // M18), and Cassandra (no bastion in M19) never tunnel; `params.ssh()`
        // already returned None above.
        ConnectionParams::Sqlite { .. }
        | ConnectionParams::Dynamodb { .. }
        | ConnectionParams::Mongodb { .. }
        | ConnectionParams::Cassandra { .. } => return Ok(None),
    };
    let ssh_secret = secret.and_then(ConnectSecret::ssh);
    let tunnel = SshTunnel::open(ssh, target_host, target_port, ssh_secret).await?;
    Ok(Some(tunnel))
}

/// The local `(host, port)` override the driver should use when a tunnel is
/// open, or `(None, None)` for a direct connection.
pub fn tunnel_override(tunnel: &Option<SshTunnel>) -> (Option<&str>, Option<u16>) {
    match tunnel {
        Some(t) => (Some(t.local_host()), Some(t.local_port())),
        None => (None, None),
    }
}

/// The russh client handler. Accepts the bastion host key on first use (see
/// the module note on the host-key policy).
struct TunnelHandler;

impl client::Handler for TunnelHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// A live local-forward SSH tunnel. While alive, `local_addr()` accepts TCP
/// connections and forwards them through the bastion to the target database.
/// Dropping it tears the tunnel down (aborts the accept loop, disconnects the
/// SSH session).
pub struct SshTunnel {
    local_host: String,
    local_port: u16,
    accept_task: JoinHandle<()>,
    // Kept alive so the SSH session stays up for the tunnel's lifetime. The
    // accept loop holds a clone; this one anchors it to the struct's lifetime.
    _session: Arc<Handle<TunnelHandler>>,
}

impl SshTunnel {
    /// The local loopback host the driver should connect to (`127.0.0.1`).
    pub fn local_host(&self) -> &str {
        &self.local_host
    }

    /// The ephemeral local port the listener bound to.
    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    /// Open a tunnel: authenticate to `ssh` (using `secret` for the key
    /// passphrase / password when the method needs one), then start a local
    /// listener that forwards to `target_host:target_port` through the bastion.
    ///
    /// Errors are §5 human sentences (bad auth, unreachable bastion, …).
    pub async fn open(
        ssh: &SshConfig,
        target_host: &str,
        target_port: u16,
        secret: Option<&str>,
    ) -> Result<Self, AppError> {
        let config = Arc::new(client::Config::default());

        let mut session = client::connect(config, (ssh.host.as_str(), ssh.port), TunnelHandler)
            .await
            .map_err(|e| {
                AppError::Database(format!(
                    "Could not reach the SSH bastion {}:{} ({e}).",
                    ssh.host, ssh.port
                ))
            })?;

        authenticate(&mut session, ssh, secret).await?;

        let session = Arc::new(session);

        // Bind an ephemeral loopback port for the driver to connect to.
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| AppError::Io(format!("Could not open a local tunnel endpoint ({e}).")))?;
        let local_addr = listener
            .local_addr()
            .map_err(|e| AppError::Io(format!("Could not read the local tunnel address ({e}).")))?;

        let accept_session = Arc::clone(&session);
        let fwd_host = target_host.to_string();
        let fwd_port = target_port;
        let originator = local_addr.ip().to_string();
        let accept_task = tokio::spawn(async move {
            loop {
                let (mut inbound, peer) = match listener.accept().await {
                    Ok(pair) => pair,
                    // Listener closed (tunnel dropped) or a transient accept
                    // error — end the loop; the session drop tears the rest down.
                    Err(_) => break,
                };
                let session = Arc::clone(&accept_session);
                let fwd_host = fwd_host.clone();
                let originator = originator.clone();
                let originator_port = u32::from(peer.port());
                tokio::spawn(async move {
                    let channel = match session
                        .channel_open_direct_tcpip(
                            fwd_host,
                            u32::from(fwd_port),
                            originator,
                            originator_port,
                        )
                        .await
                    {
                        Ok(channel) => channel,
                        // Could not open the forward channel for this conn —
                        // drop it; the driver sees a connection reset and the
                        // adapter maps it to a §5 connect error.
                        Err(_) => return,
                    };
                    let mut stream = channel.into_stream();
                    // Pump bytes both ways until either side closes.
                    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut stream).await;
                });
            }
        });

        Ok(Self {
            local_host: local_addr.ip().to_string(),
            local_port: local_addr.port(),
            accept_task,
            _session: session,
        })
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        // Stop accepting new local connections. The russh session disconnects
        // when its last `Arc` drops with this struct.
        self.accept_task.abort();
    }
}

/// Authenticate `session` to the bastion per `ssh.auth`, mapping every failure
/// to a §5 sentence. `secret` carries the key passphrase (key auth) or the
/// password (password auth); agent auth needs no secret.
async fn authenticate(
    session: &mut Handle<TunnelHandler>,
    ssh: &SshConfig,
    secret: Option<&str>,
) -> Result<(), AppError> {
    let bad_auth = |detail: String| {
        AppError::Database(format!(
            "SSH authentication to {}@{} failed: {detail}",
            ssh.user, ssh.host
        ))
    };

    match &ssh.auth {
        SshAuth::Password => {
            let password = secret.ok_or_else(|| {
                bad_auth("no SSH password was provided (it is stored in the keychain).".into())
            })?;
            let result = session
                .authenticate_password(&ssh.user, password)
                .await
                .map_err(|e| bad_auth(format!("{e}")))?;
            if !result.success() {
                return Err(bad_auth("the server rejected the password.".into()));
            }
        }
        SshAuth::Key { key_path } => {
            let key = load_secret_key(expand_tilde(key_path), secret).map_err(|e| {
                bad_auth(format!(
                    "the private key {key_path} could not be loaded ({e})."
                ))
            })?;
            let result = session
                .authenticate_publickey(&ssh.user, PrivateKeyWithHashAlg::new(Arc::new(key), None))
                .await
                .map_err(|e| bad_auth(format!("{e}")))?;
            if !result.success() {
                return Err(bad_auth("the server rejected the private key.".into()));
            }
        }
        SshAuth::Agent => {
            authenticate_agent(session, ssh, &bad_auth).await?;
        }
    }
    Ok(())
}

/// Try every identity the local ssh-agent offers, in order, until one is
/// accepted. The ssh-agent socket comes from `SSH_AUTH_SOCK`.
///
/// Unix only: `AgentClient::connect_env` (which reads `SSH_AUTH_SOCK`) does not
/// exist on Windows in russh, so the Windows build gets the stub below that
/// returns a §5 error pointing the user at key/password auth.
#[cfg(unix)]
async fn authenticate_agent(
    session: &mut Handle<TunnelHandler>,
    ssh: &SshConfig,
    bad_auth: &impl Fn(String) -> AppError,
) -> Result<(), AppError> {
    use russh::keys::agent::client::AgentClient;

    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|e| bad_auth(format!("no ssh-agent is available ({e}).")))?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| bad_auth(format!("the ssh-agent returned no identities ({e}).")))?;
    if identities.is_empty() {
        return Err(bad_auth("the ssh-agent holds no keys.".into()));
    }
    for identity in identities {
        let public_key = identity.public_key().into_owned();
        let result = session
            .authenticate_publickey_with(&ssh.user, public_key, None, &mut agent)
            .await
            .map_err(|e| bad_auth(format!("{e}")))?;
        if result.success() {
            return Ok(());
        }
    }
    Err(bad_auth(
        "no ssh-agent key was accepted by the server.".into(),
    ))
}

/// Windows stub: russh's `AgentClient::connect_env` (`SSH_AUTH_SOCK`) is
/// unix-only, so ssh-agent auth is unavailable here. Surface a clear §5 error.
#[cfg(not(unix))]
async fn authenticate_agent(
    _session: &Handle<TunnelHandler>,
    _ssh: &SshConfig,
    bad_auth: &impl Fn(String) -> AppError,
) -> Result<(), AppError> {
    Err(bad_auth(
        "SSH agent authentication isn't supported on Windows — use a private key or password instead."
            .into(),
    ))
}

/// Expand a leading `~/` to the user's home directory for a key path; leave
/// every other path untouched. Best-effort — if `HOME` is unset the original
/// path is returned and `load_secret_key` surfaces the real "not found" error.
fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        // `HOME` on unix; `USERPROFILE` is the Windows equivalent.
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
        if let Some(home) = home {
            // Join with a literal `/` rather than `Path::join` (which uses the
            // OS separator — `\` on Windows, breaking the SSH-style path). A
            // forward slash is accepted by the filesystem on every platform.
            let mut out = home.to_string_lossy().into_owned();
            if !out.ends_with('/') && !out.ends_with('\\') {
                out.push('/');
            }
            out.push_str(rest);
            return out;
        }
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_tilde_handles_home_and_absolute_paths() {
        std::env::set_var("HOME", "/home/test");
        assert_eq!(
            expand_tilde("~/.ssh/id_ed25519"),
            "/home/test/.ssh/id_ed25519"
        );
        // Absolute and relative paths are untouched.
        assert_eq!(expand_tilde("/tmp/key"), "/tmp/key");
        assert_eq!(expand_tilde("relative/key"), "relative/key");
        // A bare "~" (no slash) is not expanded.
        assert_eq!(expand_tilde("~weird"), "~weird");
    }
}
