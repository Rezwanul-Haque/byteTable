//! Vertical slices. One module per user-facing capability; each slice owns
//! its domain, application, ports, infrastructure, and command layers.

pub mod browse;
pub mod connections;
pub mod introspection;
pub mod preferences;
pub mod saved_queries;
pub mod structure;
