//! Infrastructure adapters for the schema-map slice: the JSON layout store and
//! the export-write helper (decode base64 / pass SVG text, then write the file).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::shared::error::AppError;

use super::domain::{ExportFormat, ExportPayload, MapLayout};
use super::ports::MapLayoutRepository;
use super::render::svg_to_png;

/// On-disk separator joining `connectionId` and `schema` into one map key. A
/// NUL byte can appear in neither a `SavedConnection` id (a UUID) nor a schema
/// name, so it is an unambiguous join.
const KEY_SEP: char = '\0';

/// Stores all per-(connection, schema) layouts as one pretty-printed JSON
/// object at a fixed path (`<app_config_dir>/map_layouts.json` in production;
/// any path in tests). The JSON is a flat object keyed by
/// `"connectionId\0schema"` → `MapLayout`. A flat keyed map (vs. nested
/// `{connId: {schema: …}}`) keeps read-modify-write trivial and the wire shape
/// boring; the NUL join is unambiguous (see `KEY_SEP`).
///
/// Map layouts are user data, so the corrupt-file policy follows
/// connections / saved_queries, not preferences:
///
/// - Missing file → empty map (`get` returns `None`). First launch is not an
///   error.
/// - Corrupt file → **error**, not silent reset. Silently wiping a user's
///   diagram arrangements on a parse error would be data loss. The error names
///   the file; the file is never overwritten until it parses again or the user
///   removes it.
/// - Saves are atomic: write a sibling temp file, then rename over the target,
///   so a crash mid-write never leaves a truncated store.
/// - An internal mutex serializes read-modify-write cycles so concurrent async
///   commands cannot interleave two saves.
pub struct JsonFileMapLayoutRepository {
    path: PathBuf,
    /// Guards the whole read-modify-write cycle of `save`.
    write_lock: Mutex<()>,
}

impl JsonFileMapLayoutRepository {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            write_lock: Mutex::new(()),
        }
    }

    /// Take the write lock, mapping poison to a graceful `AppError` instead of
    /// panicking — same policy as the connections / saved_queries adapters: one
    /// earlier crash must not start a panic cascade across commands.
    fn lock_for_write(&self) -> Result<std::sync::MutexGuard<'_, ()>, AppError> {
        self.write_lock.lock().map_err(|_| {
            AppError::Io(
                "the schema-map layout store is in a broken state after an earlier \
                 crash; restart the app to continue"
                    .into(),
            )
        })
    }

    fn read_all(&self) -> Result<BTreeMap<String, MapLayout>, AppError> {
        let contents = match fs::read_to_string(&self.path) {
            Ok(contents) => contents,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
            Err(err) => return Err(err.into()),
        };
        serde_json::from_str(&contents).map_err(|err| {
            AppError::Serialization(format!(
                "Map layouts file is corrupted: {} could not be read ({err}); \
                 fix or remove the file to continue",
                self.path.display()
            ))
        })
    }

    fn write_all(&self, layouts: &BTreeMap<String, MapLayout>) -> Result<(), AppError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(layouts)?;
        let tmp_path = self.path.with_extension("json.tmp");
        fs::write(&tmp_path, json)?;
        fs::rename(&tmp_path, &self.path)?;
        Ok(())
    }
}

fn store_key(connection_id: &str, schema: &str) -> String {
    format!("{connection_id}{KEY_SEP}{schema}")
}

impl MapLayoutRepository for JsonFileMapLayoutRepository {
    fn get(&self, connection_id: &str, schema: &str) -> Result<Option<MapLayout>, AppError> {
        Ok(self.read_all()?.remove(&store_key(connection_id, schema)))
    }

    fn save(&self, connection_id: &str, schema: &str, layout: &MapLayout) -> Result<(), AppError> {
        let _guard = self.lock_for_write()?;
        let mut layouts = self.read_all()?;
        layouts.insert(store_key(connection_id, schema), layout.clone());
        self.write_all(&layouts)
    }
}

/// Default PNG raster scale when the renderer sends none — 2× for crisp HiDPI
/// output, matching what the old webview-canvas path produced.
const DEFAULT_PNG_SCALE: f64 = 2.0;

/// Write an exported diagram to a user-chosen path (create/truncate).
///
/// For both formats `payload.data` is the SVG document text (see
/// `ExportPayload`): SVG is written verbatim; PNG is rasterized here with resvg
/// (`render::svg_to_png`) at `payload.scale`× — never in the webview canvas,
/// which WebKitGTK can't do on Linux. The destination came from the native save
/// dialog, so the user explicitly consented to this path — no scope check.
///
/// DESIGN_SPEC §5: any IO failure surfaces a human sentence naming the path so
/// the renderer can show it inline.
pub fn write_export(payload: &ExportPayload) -> Result<(), AppError> {
    let bytes = match payload.format {
        ExportFormat::Svg => payload.data.as_bytes().to_vec(),
        ExportFormat::Png => {
            let scale = payload.scale.unwrap_or(DEFAULT_PNG_SCALE) as f32;
            svg_to_png(&payload.data, scale)?
        }
    };
    write_bytes(Path::new(&payload.path), &bytes)
}

fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    fs::write(path, bytes)
        .map_err(|err| AppError::Io(format!("Could not write {}: {err}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::super::domain::{EdgeWaypoint, NodePosition};
    use super::*;

    fn repo_in(dir: &tempfile::TempDir) -> JsonFileMapLayoutRepository {
        JsonFileMapLayoutRepository::new(dir.path().join("map_layouts.json"))
    }

    fn layout(table: &str, x: f64) -> MapLayout {
        MapLayout {
            positions: vec![NodePosition {
                table: table.into(),
                x,
                y: 0.0,
                w: None,
            }],
            edges: vec![EdgeWaypoint {
                id: format!("{table}.fk->other"),
                dx: 3.0,
                dy: -4.0,
            }],
            cardinalities: Vec::new(),
            zoom: Some(1.25),
        }
    }

    // ---- layout store ----

    #[test]
    fn get_on_missing_file_is_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(repo_in(&dir).get("conn-1", "main").expect("get"), None);
    }

    #[test]
    fn save_then_get_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = repo_in(&dir);
        let l = layout("users", 42.0);
        repo.save("conn-1", "main", &l).expect("save");
        assert_eq!(repo.get("conn-1", "main").expect("get"), Some(l));
    }

    #[test]
    fn two_schemas_under_one_connection_are_independent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = repo_in(&dir);
        let main = layout("a", 1.0);
        let other = layout("b", 2.0);
        repo.save("conn-1", "main", &main).expect("save main");
        repo.save("conn-1", "other", &other).expect("save other");

        assert_eq!(repo.get("conn-1", "main").expect("get main"), Some(main));
        assert_eq!(repo.get("conn-1", "other").expect("get other"), Some(other));
        // A different connection with the same schema name is also independent.
        assert_eq!(repo.get("conn-2", "main").expect("get conn-2"), None);
    }

    #[test]
    fn save_overwrites_same_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = repo_in(&dir);
        repo.save("conn-1", "main", &layout("users", 1.0))
            .expect("save");
        let updated = layout("users", 100.0);
        repo.save("conn-1", "main", &updated).expect("overwrite");
        assert_eq!(repo.get("conn-1", "main").expect("get"), Some(updated));
    }

    #[test]
    fn save_leaves_no_temp_file_and_creates_parents() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo =
            JsonFileMapLayoutRepository::new(dir.path().join("nested/deep/map_layouts.json"));
        repo.save("conn-1", "main", &layout("users", 1.0))
            .expect("save");
        assert!(dir.path().join("nested/deep/map_layouts.json").exists());
        assert!(!dir.path().join("nested/deep/map_layouts.json.tmp").exists());
        assert!(repo.get("conn-1", "main").expect("get").is_some());
    }

    #[test]
    fn corrupt_file_is_an_error_not_a_silent_reset() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("map_layouts.json");
        fs::write(&path, "{ not json !!").expect("write corrupt file");
        let repo = JsonFileMapLayoutRepository::new(path.clone());
        let err = repo.get("conn-1", "main").unwrap_err();
        assert!(matches!(err, AppError::Serialization(_)));
        assert!(err.to_string().contains("Map layouts file is corrupted"));
        assert!(err.to_string().contains("map_layouts.json"));
        // The corrupt file is left untouched for the user to inspect.
        assert_eq!(
            fs::read_to_string(&path).expect("read back"),
            "{ not json !!"
        );
    }

    // ---- export write ----

    #[test]
    fn write_export_writes_svg_text_verbatim() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("diagram.svg");
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect/></svg>";
        write_export(&ExportPayload {
            path: path.to_string_lossy().into_owned(),
            format: ExportFormat::Svg,
            data: svg.into(),
            scale: None,
        })
        .expect("write svg");
        assert_eq!(fs::read_to_string(&path).expect("read back"), svg);
    }

    #[test]
    fn write_export_rasterizes_png_from_svg() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("diagram.png");
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"10\" \
                   viewBox=\"0 0 20 10\"><rect width=\"20\" height=\"10\"/></svg>";
        write_export(&ExportPayload {
            path: path.to_string_lossy().into_owned(),
            format: ExportFormat::Png,
            data: svg.into(),
            scale: Some(2.0),
        })
        .expect("write png");
        let bytes = fs::read(&path).expect("read back");
        // Real PNG magic header — proof it was rasterized, not written verbatim.
        assert!(bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]));
        // 20×10 @2× → 40×20 in the IHDR.
        assert_eq!(
            u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]),
            40
        );
        assert_eq!(
            u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]),
            20
        );
    }

    #[test]
    fn write_export_to_a_bad_path_is_an_io_error_naming_the_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Parent directory does not exist → fs::write fails.
        let bad = dir.path().join("no/such/dir/diagram.svg");
        let err = write_export(&ExportPayload {
            path: bad.to_string_lossy().into_owned(),
            format: ExportFormat::Svg,
            data: "<svg/>".into(),
            scale: None,
        })
        .unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
        assert!(err.to_string().contains("Could not write"));
        assert!(err.to_string().contains("diagram.svg"));
    }

    #[test]
    fn write_export_rejects_unparseable_svg_png() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("diagram.png");
        let err = write_export(&ExportPayload {
            path: path.to_string_lossy().into_owned(),
            format: ExportFormat::Png,
            data: "not an svg".into(),
            scale: Some(2.0),
        })
        .unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
        assert!(!path.exists());
    }
}
