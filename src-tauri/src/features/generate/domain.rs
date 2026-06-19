//! Pure wire/value types for the generate slice (M16). No Tauri, no I/O.
use serde::{Deserialize, Serialize};

/// The target size the user picks. The number is the *base* row count for
/// entity tables; lookup/junction tables scale relative to it (see planner).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GenerateSize {
    #[serde(rename = "1k")]
    OneK,
    #[serde(rename = "10k")]
    TenK,
    #[serde(rename = "100k")]
    HundredK,
    #[serde(rename = "1m")]
    OneM,
}

impl GenerateSize {
    pub fn base_rows(self) -> u64 {
        match self {
            GenerateSize::OneK => 1_000,
            GenerateSize::TenK => 10_000,
            GenerateSize::HundredK => 100_000,
            GenerateSize::OneM => 1_000_000,
        }
    }
}

/// How a table is treated for row-count scaling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TableRole {
    /// Enum-like reference table — small fixed count.
    Lookup,
    /// Pure FK-join table — scales with parents.
    Junction,
    /// Normal entity — gets the chosen base count.
    Entity,
}

/// The plan for one column: which generator, and whether it is written at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnPlan {
    pub name: String,
    /// Human label of the chosen generator (e.g. "email", "foreign key",
    /// "auto-increment (omitted)"), shown in the preview.
    pub generator: String,
    /// True when the column is left out of the INSERT (auto-increment PK, or a
    /// nullable column with a DEFAULT we let fire).
    pub omit: bool,
    /// True when this FK column is filled in a second UPDATE pass (cycle/self-ref).
    pub deferred: bool,
    /// A preview warning for this column (unsatisfiable type, CHECK constraint…).
    pub note: Option<String>,
}

/// The plan for one table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePlan {
    pub table: String,
    pub role: TableRole,
    pub row_count: u64,
    pub columns: Vec<ColumnPlan>,
}

/// The full generation plan, in insertion order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GeneratePlan {
    pub schema: String,
    pub order: Vec<TablePlan>,
    /// Schema-level warnings (e.g. a NOT NULL FK inside a cycle).
    pub warnings: Vec<String>,
}

/// Per-table outcome of a run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableResult {
    pub table: String,
    pub inserted: u64,
    /// Set when the table failed partway (the message); `inserted` reflects
    /// committed chunks (append semantics).
    pub error: Option<String>,
}

/// The outcome of a whole run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSummary {
    pub tables: Vec<TableResult>,
    pub total_inserted: u64,
    pub cancelled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_size_maps_to_base_rows() {
        assert_eq!(GenerateSize::OneK.base_rows(), 1_000);
        assert_eq!(GenerateSize::TenK.base_rows(), 10_000);
        assert_eq!(GenerateSize::HundredK.base_rows(), 100_000);
        assert_eq!(GenerateSize::OneM.base_rows(), 1_000_000);
    }

    #[test]
    fn generate_size_wire_shape_is_the_label() {
        let json = serde_json::to_string(&GenerateSize::OneM).unwrap();
        assert_eq!(json, "\"1m\"");
        let back: GenerateSize = serde_json::from_str("\"100k\"").unwrap();
        assert_eq!(back, GenerateSize::HundredK);
    }
}
