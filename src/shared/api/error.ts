// Structured error payload emitted by every Tauri command boundary.
// Mirrors the `Serialize` impl of `AppError` in
// `src-tauri/src/shared/error.rs` — keep the two in sync.
//
// Slices that need to branch on failure category (e.g. show "not found"
// differently from an I/O failure) should narrow the caught `unknown` to
// `AppErrorPayload` before reading `kind`.

/** Machine-readable error category. Mirrors `AppError::kind()` in Rust. */
export type AppErrorKind = "io" | "serialization" | "notFound" | "invalid";

/** Shape of the rejection value from `invoke()` when a command fails. */
export interface AppErrorPayload {
  kind: AppErrorKind;
  message: string;
}

/** Type guard for narrowing an `unknown` invoke() rejection. */
export function isAppErrorPayload(value: unknown): value is AppErrorPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "message" in value &&
    typeof (value as { message: unknown }).message === "string"
  );
}
