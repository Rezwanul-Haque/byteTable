//! Where prompts go (M44 Task A7) and whether a workspace may use the
//! assistant at all (Task E1). Mirrors the prototype's `BT_AI.hostOf`,
//! `BT_AI.dest` and `BT_AI.stateFor` — the renderer keeps a copy of the same
//! rules for display, but the copy that refuses calls is this one.

use serde::Serialize;

use crate::features::settings::domain::AiSettings;

/// Default endpoints for the two named runtimes.
pub const OLLAMA_URL: &str = "http://localhost:11434";
pub const LMSTUDIO_URL: &str = "http://localhost:1234/v1";

pub const ANTHROPIC_HOST: &str = "api.anthropic.com";
pub const ANTHROPIC_BASE: &str = "https://api.anthropic.com/v1";

/// The hosted model used when the user has not named one.
pub const ANTHROPIC_DEFAULT_MODEL: &str = "claude-sonnet-5-5";
pub const OPENAI_DEFAULT_MODEL: &str = "gpt-4.1-mini";

/// What a URL says about its host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostOf {
    /// `name[:port]`, lowercased — what the UI prints.
    pub host: String,
    /// The bare host name (`[::1]` keeps its brackets).
    pub name: String,
    /// The host is this machine: `localhost`, `127.x` or `[::1]`.
    pub loopback: bool,
    /// The URL is a full `http://` / `https://` URL with a host.
    pub ok: bool,
}

/// Parse a URL just far enough to name its host.
///
/// Local means loopback **by the URL alone** — never by which runtime was
/// picked — so an Ollama endpoint edited to point at a LAN box is remote. A
/// LAN address is not local: ByteTable can't tell a server on your network
/// from a public one.
pub fn host_of(url: &str) -> HostOf {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    let (has_http, rest) = match lower.find("://") {
        Some(at) if is_scheme(&lower[..at]) => {
            let scheme = &lower[..at];
            (scheme == "http" || scheme == "https", &trimmed[at + 3..])
        }
        _ => (false, trimmed),
    };
    let name: String = if rest.starts_with('[') {
        match rest.find(']') {
            Some(end) => rest[..=end].to_string(),
            None => String::new(),
        }
    } else {
        rest.chars()
            .take_while(|c| !matches!(c, '/' | ':' | '?' | '#') && !c.is_whitespace())
            .collect()
    };
    if name.is_empty() {
        return HostOf {
            host: String::new(),
            name: String::new(),
            loopback: false,
            ok: false,
        };
    }
    let name = name.to_ascii_lowercase();
    let after = &rest[name.len()..];
    let port: String = after
        .strip_prefix(':')
        .map(|p| p.chars().take_while(|c| c.is_ascii_digit()).collect())
        .unwrap_or_default();
    let host = if port.is_empty() {
        name.clone()
    } else {
        format!("{name}:{port}")
    };
    // `127.x` only as an IPv4 literal: `127.example.com` is a DNS name like any other.
    let loopback = name == "localhost"
        || name == "[::1]"
        || (name.starts_with("127.") && name.chars().all(|c| c.is_ascii_digit() || c == '.'));
    HostOf {
        host,
        name,
        loopback,
        ok: has_http,
    }
}

fn is_scheme(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// Which wire protocol a destination speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    Ollama,
    /// `/models` + `/chat/completions` — LM Studio, a custom URL, OpenAI.
    OpenAi,
    Anthropic,
}

/// Where prompts go under the current settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dest {
    /// The host is this machine (accent); anything else is amber.
    pub local: bool,
    pub host: String,
    /// "Ollama", "LM Studio", "your endpoint", "Anthropic", "OpenAI-compatible".
    pub via: String,
    pub model: String,
    pub custom: bool,
    /// The endpoint is fully set up: a full URL, and a model where one is
    /// required. A call to a destination that is not ready is refused.
    pub ready: bool,
    #[serde(skip)]
    pub kind: ProviderKind,
    #[serde(skip)]
    pub base_url: String,
    /// The keychain account holding this destination's key, when it uses one.
    #[serde(skip)]
    pub key_account: Option<&'static str>,
}

/// Keychain accounts under the `bytetable.assistant` service.
pub const KEY_ACCOUNTS: [&str; 3] = ["anthropic", "openai", "custom"];

pub fn dest(s: &AiSettings) -> Dest {
    if s.ai_provider != "key" && s.ai_runtime == "custom" {
        let h = host_of(&s.ai_custom_url);
        let model = s.ai_custom_model.trim();
        return Dest {
            local: h.loopback,
            host: if h.host.is_empty() {
                "no URL set".into()
            } else {
                h.host
            },
            via: "your endpoint".into(),
            model: if model.is_empty() {
                "model not set".into()
            } else {
                model.into()
            },
            custom: true,
            ready: h.ok && !model.is_empty(),
            kind: ProviderKind::OpenAi,
            base_url: s.ai_custom_url.trim().to_string(),
            key_account: s.ai_custom_key.then_some("custom"),
        };
    }
    if s.ai_provider != "key" {
        let ollama = s.ai_runtime != "lmstudio";
        let url = if ollama {
            &s.ai_ollama_url
        } else {
            &s.ai_lm_url
        };
        let h = host_of(url);
        let model = if ollama {
            s.ai_local_model.trim()
        } else {
            s.ai_lm_model.trim()
        };
        return Dest {
            local: h.loopback,
            host: if h.host.is_empty() {
                "no URL set".into()
            } else {
                h.host
            },
            via: if ollama { "Ollama" } else { "LM Studio" }.into(),
            // LM Studio may leave the model empty: the first loaded one is used.
            model: if model.is_empty() && !ollama {
                "loaded model".into()
            } else {
                model.into()
            },
            custom: false,
            ready: h.ok && (!ollama || !model.is_empty()),
            kind: if ollama {
                ProviderKind::Ollama
            } else {
                ProviderKind::OpenAi
            },
            base_url: url.trim().to_string(),
            key_account: None,
        };
    }
    let anth = s.ai_vendor != "openai";
    let model = s.ai_key_model.trim();
    if !anth {
        // OpenAI-compatible: OpenAI by default, any compatible service when
        // its base URL is edited. Same URL rule as everywhere else.
        let h = host_of(&s.ai_key_url);
        return Dest {
            local: h.loopback,
            host: if h.host.is_empty() {
                "no URL set".into()
            } else {
                h.host
            },
            via: "OpenAI-compatible".into(),
            model: if model.is_empty() {
                OPENAI_DEFAULT_MODEL.into()
            } else {
                model.into()
            },
            custom: false,
            ready: h.ok,
            kind: ProviderKind::OpenAi,
            base_url: s.ai_key_url.trim().to_string(),
            key_account: Some("openai"),
        };
    }
    Dest {
        local: false,
        host: ANTHROPIC_HOST.into(),
        via: "Anthropic".into(),
        model: if model.is_empty() {
            ANTHROPIC_DEFAULT_MODEL.into()
        } else {
            model.into()
        },
        custom: false,
        ready: true,
        kind: ProviderKind::Anthropic,
        base_url: ANTHROPIC_BASE.into(),
        key_account: Some("anthropic"),
    }
}

/// Whether a workspace may use the assistant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AiState {
    Off,
    Locked,
    On,
}

/// The production lock: a production connection is locked until the user
/// allows it by name (`aiAllowed`, keyed by saved-connection id).
///
/// HOOK (read-only-connection lock, ships separately): when it lands, take the
/// handle's read-only flag here and return `Locked` for it as well — every
/// caller already routes through this one function.
pub fn state_for(s: &AiSettings, production: bool, connection_id: Option<&str>) -> AiState {
    if !enabled_for(s, connection_id) {
        return AiState::Off;
    }
    let allowed = connection_id
        .and_then(|id| s.ai_allowed.get(id))
        .copied()
        .unwrap_or(false);
    if production && !allowed {
        return AiState::Locked;
    }
    AiState::On
}

/// Whether the user turned the assistant on for this connection. No
/// connection (no workspace) is always off.
pub fn enabled_for(s: &AiSettings, connection_id: Option<&str>) -> bool {
    connection_id
        .and_then(|id| s.ai_enabled_for.get(id))
        .copied()
        .unwrap_or(false)
}

/// Row data is never available on production, allowed or not.
pub fn rows_allowed(production: bool) -> bool {
    !production
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(url: &str) -> (String, bool, bool) {
        let r = host_of(url);
        (r.host, r.loopback, r.ok)
    }

    #[test]
    fn loopback_names_are_local() {
        assert_eq!(
            h("http://localhost:11434"),
            ("localhost:11434".into(), true, true)
        );
        assert_eq!(
            h("http://127.0.0.1:1234/v1"),
            ("127.0.0.1:1234".into(), true, true)
        );
        assert_eq!(h("HTTP://LocalHost"), ("localhost".into(), true, true));
    }

    #[test]
    fn ipv6_loopback_is_local() {
        assert_eq!(h("http://[::1]:8080/v1"), ("[::1]:8080".into(), true, true));
        assert!(!h("http://[fe80::1]:8080").1);
    }

    #[test]
    fn lan_ip_is_not_local() {
        assert_eq!(
            h("http://192.168.1.20:11434"),
            ("192.168.1.20:11434".into(), false, true)
        );
    }

    #[test]
    fn public_host_is_not_local() {
        assert_eq!(
            h("https://gateway.example/v1"),
            ("gateway.example".into(), false, true)
        );
    }

    #[test]
    fn missing_scheme_is_not_a_full_url() {
        assert_eq!(
            h("localhost:11434"),
            ("localhost:11434".into(), true, false)
        );
        assert!(!h("ftp://localhost").2);
    }

    #[test]
    fn empty_is_nothing() {
        assert_eq!(h(""), (String::new(), false, false));
        assert_eq!(h("   "), (String::new(), false, false));
        assert_eq!(h("http://"), (String::new(), false, false));
    }

    #[test]
    fn localhost_lookalikes_are_not_local() {
        assert!(!host_of("http://localhost.evil.example").loopback);
        assert!(!host_of("http://127.example.com").loopback);
    }

    #[test]
    fn an_edited_ollama_url_on_another_host_is_remote() {
        let s = AiSettings {
            ai_ollama_url: "http://10.0.0.5:11434".into(),
            ..AiSettings::default()
        };
        let d = dest(&s);
        assert!(!d.local);
        assert_eq!(d.host, "10.0.0.5:11434");
        assert!(d.ready);
        assert_eq!(d.via, "Ollama");
        assert!(dest(&AiSettings::default()).local);
    }

    #[test]
    fn ready_needs_a_full_url_and_a_custom_model() {
        let mut s = AiSettings {
            ai_runtime: "custom".into(),
            ..AiSettings::default()
        };
        assert!(!dest(&s).ready, "custom without a model");
        s.ai_custom_model = "sqlcoder".into();
        assert!(dest(&s).ready);
        s.ai_custom_url = "localhost:8080/v1".into();
        assert!(!dest(&s).ready, "no scheme");
        s.ai_runtime = "ollama".into();
        s.ai_ollama_url = String::new();
        let d = dest(&s);
        assert!(!d.ready);
        assert_eq!(d.host, "no URL set");
    }

    #[test]
    fn key_provider_always_leaves_the_machine() {
        let s = AiSettings {
            ai_provider: "key".into(),
            ..AiSettings::default()
        };
        let d = dest(&s);
        assert!(!d.local);
        assert_eq!(d.host, ANTHROPIC_HOST);
        assert_eq!(d.key_account, Some("anthropic"));
    }

    #[test]
    fn the_openai_compatible_provider_follows_its_base_url() {
        let mut s = AiSettings {
            ai_provider: "key".into(),
            ai_vendor: "openai".into(),
            ..AiSettings::default()
        };
        let d = dest(&s);
        assert_eq!((d.host.as_str(), d.ready), ("api.openai.com", true));
        s.ai_key_url = "https://api.groq.com/openai/v1".into();
        let d = dest(&s);
        assert_eq!(d.host, "api.groq.com");
        assert_eq!(d.base_url, "https://api.groq.com/openai/v1");
        assert!(!d.local);
        assert_eq!(d.key_account, Some("openai"));
        s.ai_key_url = "api.groq.com".into();
        assert!(!dest(&s).ready, "not a full URL");
    }

    #[test]
    fn production_locks_until_allowed_by_id() {
        let mut s = AiSettings::default();
        assert_eq!(state_for(&s, false, Some("a")), AiState::Off);
        // On is per connection: "a" and "p1" switched on, "b" never was.
        s.ai_enabled_for.insert("a".into(), true);
        s.ai_enabled_for.insert("p1".into(), true);
        assert_eq!(state_for(&s, false, Some("b")), AiState::Off);
        assert_eq!(state_for(&s, false, None), AiState::Off, "no workspace");
        s.ai_allowed.clear();
        assert_eq!(state_for(&s, false, Some("a")), AiState::On);
        assert_eq!(state_for(&s, true, Some("a")), AiState::Locked);
        assert_eq!(state_for(&s, true, None), AiState::Off, "never switched on");
        assert_eq!(state_for(&s, true, Some("p1")), AiState::Locked);
        s.ai_allowed.insert("a".into(), true);
        assert_eq!(state_for(&s, true, Some("a")), AiState::On);
        assert_eq!(
            state_for(&s, true, Some("b")),
            AiState::Off,
            "on is per connection"
        );
        assert!(!rows_allowed(true));
    }
}
