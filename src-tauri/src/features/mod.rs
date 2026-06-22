//! Vertical slices. One module per user-facing capability; each slice owns
//! its domain, application, ports, infrastructure, and command layers.

pub mod browse;
pub mod cassandra;
pub mod connections;
pub mod dynamo;
pub mod export;
pub mod generate;
pub mod insights;
pub mod introspection;
pub mod keyvalue;
pub mod mongo;
pub mod mutate;
pub mod preferences;
pub mod saved_queries;
pub mod schema_map;
pub mod settings;
pub mod structure;
