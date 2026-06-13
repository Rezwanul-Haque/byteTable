//! Vertical slices. One module per user-facing capability; each slice owns
//! its domain, application, ports, infrastructure, and command layers.

pub mod browse;
pub mod connections;
pub mod insights;
pub mod introspection;
pub mod keyvalue;
pub mod mutate;
pub mod preferences;
pub mod saved_queries;
pub mod schema_map;
pub mod structure;
