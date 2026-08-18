// "Open a data file" sheet (M35 Task 4) — ported from the prototype's
// `OpenDataFileSheet` (csv-open.jsx).
//
// ONE overlay, reachable from three places: the connect screen's "Open file"
// menu, File ▸ Open ▸ Open CSV, and the viewer's own parse pill. It is not an
// importer and it writes nothing itself — it produces a {@link DataFileRef}
// and hands it to whoever opened it. (The workspace it opens CAN edit and save
// the file; that happens in the Data tab, never here.)
//
// The whole point is seeing the effect of a parse option BEFORE committing, so
// every control re-parses, re-types and re-counts issues live against the real
// file. Escape/scrim dismissal and the focus trap come from the shared <Modal>,
// which dismisses only the top-most sheet — so re-opening from inside the
// viewer leaves the workspace untouched behind it.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal } from "../../../shared/ui/Modal";
import { useToast } from "../../../shared/ui/toastContext";
import type { DataFileRef } from "../../workspaces/types";
import { analyze, delimLabel, fmtBytes, parse, sniff, TYPES } from "../core";
import { DEMOS } from "../demos";
import {
  hasDesktopShell,
  pickDataFile,
  readBrowserFile,
  readPath,
  type PickedFile,
} from "../dialog";
import "./OpenDataFileSheet.css";

/** Delimiter choices: `auto` (whatever was sniffed) plus manual overrides. */
const DELIM_OPTS = [
  { v: "auto", label: "Auto" },
  { v: ",", label: "," },
  { v: ";", label: ";" },
  { v: "\t", label: "Tab" },
  { v: "|", label: "|" },
] as const;

/** Preview size — enough to recognise the file, small enough to stay readable. */
const PREVIEW_ROWS = 6;
const PREVIEW_COLS = 9;

interface OpenDataFileSheetProps {
  onClose: () => void;
  /** Hand the committed file to the opener (the sheet does not close itself). */
  onOpen: (file: DataFileRef) => void;
}

export function OpenDataFileSheet({ onClose, onOpen }: OpenDataFileSheetProps) {
  const toast = useToast();
  const [file, setFile] = useState<PickedFile | null>(null);
  const [delim, setDelim] = useState<string>("auto");
  const [header, setHeader] = useState(true);
  const [trim, setTrim] = useState(false);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const sniffed = useMemo(() => (file ? sniff(file.text) : null), [file]);
  // The sniffed header verdict is a DEFAULT, not a lock: it seeds the checkbox
  // on load and the user overrides it from there.
  useEffect(() => {
    if (sniffed) setHeader(sniffed.header);
  }, [sniffed]);

  const parsed = useMemo(() => {
    if (!file || !sniffed) return null;
    return parse(file.text, {
      delimiter: delim === "auto" ? sniffed.delimiter : delim,
      header,
      trim,
    });
  }, [file, sniffed, delim, header, trim]);

  const analysis = useMemo(() => (parsed ? analyze(parsed) : null), [parsed]);

  const load = (loader: () => Promise<PickedFile | null>) => {
    setBusy(true);
    void loader()
      .then((picked) => {
        if (!picked) return;
        setFile(picked);
        setDelim("auto");
      })
      .catch((error: unknown) => {
        toast(error instanceof Error ? error.message : "Could not read that file", "err");
      })
      .finally(() => setBusy(false));
  };

  // Click-to-browse: the native picker on the desktop, the hidden input in
  // plain-browser dev (where the dialog plugin does not exist).
  const browse = () => {
    if (!hasDesktopShell()) {
      inputRef.current?.click();
      return;
    }
    load(pickDataFile);
  };

  // Desktop drag-and-drop. The webview swallows OS drops before the DOM sees
  // them, so the HTML5 handlers below never fire there — this is the real path,
  // and it only listens while no file is loaded (the drop zone is the empty
  // state).
  useEffect(() => {
    if (file || !hasDesktopShell()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const stop = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") setDrag(true);
        else if (event.payload.type === "leave") setDrag(false);
        else {
          setDrag(false);
          const path = event.payload.paths[0];
          if (path !== undefined) load(() => readPath(path));
        }
      });
      if (cancelled) stop();
      else unlisten = stop;
    })().catch(() => {
      /* no webview API (plain browser dev) — the HTML5 handlers cover it */
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // `load` is stable enough for this: it only closes over setState setters
    // and the toast callback, none of which change identity per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const cols = analysis?.cols ?? [];
  const previewCols = cols.slice(0, PREVIEW_COLS);
  const errors = analysis ? analysis.issues.filter((i) => i.sev === "error").length : 0;

  const commit = () => {
    if (!file || !parsed) return;
    onOpen({
      name: file.name,
      path: file.path,
      size: file.size,
      text: file.text,
      opts: {
        delimiter: parsed.opts.delimiter,
        header: parsed.opts.header,
        trim: parsed.opts.trim,
      },
    });
  };

  return (
    <Modal className="csvo-sheet" label="Open a data file" onClose={onClose}>
      <div className="csvo-head">
        <Icon name="table_view" size={17} style={{ color: "var(--accent)" }} />
        <div className="csvo-title">Open a data file</div>
        <span className="csvo-sub">
          CSV · TSV · delimited text — edited in place, nothing is uploaded
        </span>
        <IconBtn icon="close" title="Close" onClick={onClose} />
      </div>

      <div className="csvo-body">
        {!file || !sniffed || !parsed || !analysis ? (
          <Fragment>
            <button
              type="button"
              className={"csvo-drop" + (drag ? " over" : "")}
              onClick={browse}
              // HTML5 drag-and-drop: the plain-browser-dev path only (see the
              // effect above for the desktop one).
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                const dropped = e.dataTransfer.files[0];
                if (dropped) load(() => readBrowserFile(dropped));
              }}
            >
              <Icon name={busy ? "hourglass_top" : "upload_file"} size={26} />
              <span className="csvo-drop-main">
                {busy ? "Reading…" : "Drop a file here, or click to browse"}
              </span>
              <span className="csvo-drop-sub">
                Delimiter, header row and encoding are detected for you
              </span>
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.tsv,.txt,.tab,.psv,text/csv"
              style={{ display: "none" }}
              onChange={(e) => {
                const chosen = e.target.files?.[0];
                if (chosen) load(() => readBrowserFile(chosen));
              }}
            />

            <div className="csvo-samples-h">Or start from a sample</div>
            <div className="csvo-samples">
              {DEMOS.map((d) => (
                <button
                  type="button"
                  key={d.name}
                  className="csvo-sample"
                  onClick={() => {
                    setFile({ name: d.name, path: null, size: d.size, text: d.text });
                    setDelim("auto");
                  }}
                >
                  <Icon name="description" size={15} style={{ color: "var(--text-faint)" }} />
                  <span className="csvo-sample-body">
                    <span className="csvo-sample-name">{d.name}</span>
                    <span className="csvo-sample-note">{d.note}</span>
                  </span>
                  <span className="csvo-sample-size">{fmtBytes(d.size)}</span>
                </button>
              ))}
            </div>
          </Fragment>
        ) : (
          <Fragment>
            <div className="csvo-file">
              <Icon name="description" size={18} style={{ color: "var(--accent)" }} />
              <div className="csvo-file-body">
                <div className="csvo-file-name" title={file.path ?? file.name}>
                  {file.name}
                </div>
                <div className="csvo-file-meta">
                  {fmtBytes(file.size)} · {sniffed.encoding} · {sniffed.crlf ? "CRLF" : "LF"} line
                  endings
                </div>
              </div>
              <Btn icon="swap_horiz" variant="text" onClick={() => setFile(null)}>
                Choose another
              </Btn>
            </div>

            <div className="csvo-opts">
              <div className="csvo-opt">
                <span className="csvo-opt-label" id="csvo-delim-label">
                  Delimiter
                </span>
                <div className="seg csvo-seg" role="group" aria-labelledby="csvo-delim-label">
                  {DELIM_OPTS.map((d) => (
                    <button
                      type="button"
                      key={d.v}
                      className={"seg-btn" + (delim === d.v ? " active" : "")}
                      onClick={() => setDelim(d.v)}
                    >
                      {d.label}
                      {d.v === "auto" ? (
                        <em className="csvo-auto">{delimLabel(sniffed.delimiter)}</em>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>
              <label className="csvo-check">
                <input
                  type="checkbox"
                  checked={header}
                  onChange={(e) => setHeader(e.target.checked)}
                />
                First row is a header
              </label>
              <label className="csvo-check">
                <input type="checkbox" checked={trim} onChange={(e) => setTrim(e.target.checked)} />
                Trim whitespace
              </label>
            </div>

            <div className="csvo-prev-wrap">
              <table className="csvo-prev">
                <thead>
                  <tr>
                    <th className="csvo-prev-n" />
                    {previewCols.map((c) => (
                      <th key={c.name}>
                        <div className="csvo-prev-name">{c.name}</div>
                        <div className="csvo-prev-type" style={{ color: TYPES[c.type].color }}>
                          <Icon name={TYPES[c.type].icon} size={11} />
                          {c.type}
                        </div>
                      </th>
                    ))}
                    {cols.length > previewCols.length ? (
                      <th className="csvo-prev-more">+{cols.length - previewCols.length}</th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.slice(0, PREVIEW_ROWS).map((r, ri) => (
                    <tr key={ri}>
                      <td className="csvo-prev-n">{ri + 1}</td>
                      {previewCols.map((c) => {
                        const value = r[c.index] ?? null;
                        return (
                          <td
                            key={c.name}
                            className={
                              value === null ? "nul" : c.bad.includes(ri) ? "bad" : undefined
                            }
                          >
                            {value === null ? "null" : String(value)}
                          </td>
                        );
                      })}
                      {cols.length > previewCols.length ? (
                        <td className="csvo-prev-more">…</td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="csvo-detect">
              <span
                className="csvo-dot"
                style={{ background: errors ? "var(--warn)" : "var(--accent)" }}
              />
              <b>{delimLabel(parsed.opts.delimiter)}-delimited</b>
              <span>
                {parsed.rows.length.toLocaleString()} rows × {cols.length} columns
              </span>
              <span>parsed in {parsed.ms} ms</span>
              {errors ? (
                <span className="csvo-warn">
                  <Icon name="report" size={12} />
                  {/* One span, not two siblings: as bare text runs in a flex row
                      the plural suffix detaches onto its own line. */}
                  <span>
                    {errors} issue{errors === 1 ? "" : "s"} found — review them in the viewer
                  </span>
                </span>
              ) : (
                <span className="csvo-ok">
                  <Icon name="check" size={12} />
                  <span>no structural problems</span>
                </span>
              )}
            </div>
          </Fragment>
        )}
      </div>

      <div className="csvo-foot">
        <span className="csvo-foot-note">
          Opens as an editable workspace — changes are staged until you save. Query it with SQL.
        </span>
        <Btn variant="text" onClick={onClose}>
          Cancel
        </Btn>
        <Btn icon="arrow_forward" variant="filled" disabled={!parsed} onClick={commit}>
          Open viewer
        </Btn>
      </div>
    </Modal>
  );
}
