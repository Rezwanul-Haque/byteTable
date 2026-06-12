// Temporary placeholder proving the token layer loads — replaced in a later task.
export function App() {
  return (
    <main
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        background: "var(--bg0)",
        color: "var(--text)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="msym" style={{ color: "var(--accent)", fontSize: 20 }}>
          table
        </span>
        <span style={{ fontWeight: 600 }}>ByteTable</span>
        <span
          style={{
            fontFamily: "var(--mono)",
            color: "var(--text-dim)",
            fontSize: 12,
          }}
        >
          tokens loaded
        </span>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {["--accent", "--bg2", "--error"].map((token) => (
          <div
            key={token}
            title={token}
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: `var(${token})`,
              border: "1px solid var(--border)",
            }}
          />
        ))}
      </div>
    </main>
  );
}
