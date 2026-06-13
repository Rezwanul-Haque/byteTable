//! Domain model for the schema map. Pure value objects; the only outward
//! dependency is `serde`.
//!
//! As in the saved_queries and connections slices, the plain `serde` derives
//! below double as the wire/persisted representation (camelCase fields) so the
//! renderer's TS literals match exactly.

use serde::{Deserialize, Serialize};

/// Position of one table card in the ER diagram, in diagram coordinates.
///
/// `table` is the table name (unique within a schema), used as the key the
/// renderer matches a card to. `x`/`y` are absolute positions in the diagram's
/// own coordinate space (before zoom/pan are applied at render time).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePosition {
    pub table: String,
    pub x: f64,
    pub y: f64,
}

/// A user-dragged offset for one FK edge's midpoint waypoint.
///
/// `id` opaquely identifies an FK edge; the renderer owns the id scheme (e.g.
/// `"childTable.col->refTable"`). The backend never parses it — it is just the
/// key an offset is stored under.
///
/// `dx`/`dy` are a *relative* offset applied to the edge's computed midpoint, so
/// the edge keeps its bend when the two connected cards move. Storing the
/// offset (not an absolute waypoint) is what lets a dragged edge stay sensible
/// after a layout reflow.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeWaypoint {
    pub id: String,
    pub dx: f64,
    pub dy: f64,
}

/// The full saved layout for one (connectionId, schema): every table card's
/// position, every user-dragged FK edge offset, and the zoom level.
///
/// Design choices:
///
/// - `positions` / `edges` are `Vec`s keyed by `table` / `id` rather than maps.
///   A `Vec` serializes to a clean JSON array, round-trips order, and the
///   renderer already iterates these; a map keyed by name would gain nothing
///   here. Lookups are by the embedded key field.
/// - `zoom` is `Option<f64>`: present once the user has zoomed, absent (and
///   omitted from the wire) otherwise, so the renderer can fall back to its
///   default zoom. Pan is intentionally **omitted** — pan is cheap to recompute
///   (centre on the cards) and persisting it tends to reopen the diagram
///   scrolled off-screen if the card set changed; if a future milestone wants
///   sticky pan it can add an `Option<(f64, f64)>` field without breaking the
///   wire (a new optional field).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapLayout {
    #[serde(default)]
    pub positions: Vec<NodePosition>,
    #[serde(default)]
    pub edges: Vec<EdgeWaypoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zoom: Option<f64>,
}

/// The export format the renderer chose. Lowercase on the wire to match the
/// app's enum convention (see `AppError::kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Png,
    Svg,
}

/// What `diagram_export` writes and how `data` is encoded.
///
/// - `format: "svg"` → `data` is the SVG document text, written verbatim.
/// - `format: "png"` → `data` is **base64-encoded** PNG bytes. Base64 is used
///   (rather than a raw `Vec<u8>`, which serde would send as a JSON number
///   array) because a rasterized diagram can be hundreds of KB; a number array
///   roughly decuples that over IPC, whereas base64 is ~1.33×. The command
///   decodes the base64 before writing.
///
/// `path` is the user-chosen destination from the native save dialog. Because
/// the user explicitly picked it, no extra scope restriction applies (the
/// save dialog *is* the consent).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPayload {
    pub path: String,
    pub format: ExportFormat,
    pub data: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> MapLayout {
        MapLayout {
            positions: vec![
                NodePosition {
                    table: "users".into(),
                    x: 10.0,
                    y: 20.5,
                },
                NodePosition {
                    table: "orders".into(),
                    x: 300.0,
                    y: -40.0,
                },
            ],
            edges: vec![EdgeWaypoint {
                id: "orders.user_id->users".into(),
                dx: 12.0,
                dy: -8.0,
            }],
            zoom: Some(1.5),
        }
    }

    #[test]
    fn wire_format_is_camel_case() {
        let json = serde_json::to_value(sample()).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "positions": [
                    { "table": "users", "x": 10.0, "y": 20.5 },
                    { "table": "orders", "x": 300.0, "y": -40.0 },
                ],
                "edges": [
                    { "id": "orders.user_id->users", "dx": 12.0, "dy": -8.0 },
                ],
                "zoom": 1.5,
            })
        );
    }

    #[test]
    fn zoom_is_omitted_from_the_wire_when_absent() {
        let layout = MapLayout {
            zoom: None,
            ..sample()
        };
        let json = serde_json::to_value(layout).expect("serialize");
        assert!(json.get("zoom").is_none());
    }

    #[test]
    fn empty_layout_round_trips_with_arrays_present() {
        let json = serde_json::to_value(MapLayout::default()).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "positions": [],
                "edges": [],
            })
        );
    }

    #[test]
    fn missing_arrays_default_to_empty_on_deserialize() {
        // A future / partial payload that carries only zoom must still parse.
        let layout: MapLayout = serde_json::from_value(serde_json::json!({ "zoom": 2.0 }))
            .expect("deserialize partial");
        assert!(layout.positions.is_empty());
        assert!(layout.edges.is_empty());
        assert_eq!(layout.zoom, Some(2.0));
    }

    #[test]
    fn serde_round_trip_preserves_all_fields() {
        let layout = sample();
        let json = serde_json::to_string(&layout).expect("serialize");
        let back: MapLayout = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, layout);
    }

    #[test]
    fn export_payload_wire_shape_is_camel_case_with_lowercase_format() {
        let svg = ExportPayload {
            path: "/tmp/diagram.svg".into(),
            format: ExportFormat::Svg,
            data: "<svg/>".into(),
        };
        assert_eq!(
            serde_json::to_value(&svg).expect("serialize"),
            serde_json::json!({
                "path": "/tmp/diagram.svg",
                "format": "svg",
                "data": "<svg/>",
            })
        );

        let png = ExportPayload {
            path: "/tmp/diagram.png".into(),
            format: ExportFormat::Png,
            data: "AAAA".into(),
        };
        assert_eq!(
            serde_json::to_value(&png).expect("serialize")["format"],
            "png"
        );

        // Round-trips from a renderer-shaped literal.
        let back: ExportPayload = serde_json::from_value(serde_json::json!({
            "path": "/tmp/x.png",
            "format": "png",
            "data": "Zm9v",
        }))
        .expect("deserialize");
        assert_eq!(back.format, ExportFormat::Png);
        assert_eq!(back.data, "Zm9v");
    }
}
