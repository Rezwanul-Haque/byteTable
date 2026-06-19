//! Shared kernel: the only cross-slice surface (errors, engine abstraction).
//!
//! Slices must never reach into each other's internals — anything reused
//! between slices lives here.

pub mod document;
pub mod engine;
pub mod error;
pub mod keyvalue;
