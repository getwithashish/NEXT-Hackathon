"use client";
import { useState, useEffect } from "react";
import { getPendingApprovals, decideApproval } from "../../lib/api";

type Provider = {
  id: string;
  name: string;
  docs_url: string | null;
  pricing_url: string | null;
  status: string;
  discovered_at: string;
};

function ApprovalCard({ provider, onDecided }: { provider: Provider; onDecided: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(approved: boolean) {
    setBusy(true);
    setError(null);
    try {
      await decideApproval(provider.id, approved, apiKey);
      onDecided();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ background: "#1a1a2e", border: "1px solid #6366f1", borderRadius: 12, padding: 20, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h3 style={{ margin: 0, color: "#e0e0ff" }}>{provider.name}</h3>
          <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>Discovered: {new Date(provider.discovered_at).toLocaleString()}</div>
        </div>
        <span style={{ background: "#2a2a4e", color: "#f59e0b", fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 20 }}>NEEDS API KEY</span>
      </div>
      <div style={{ marginTop: 12, display: "flex", gap: 12 }}>
        {provider.docs_url && <a href={provider.docs_url} target="_blank" rel="noreferrer" style={{ color: "#6366f1", fontSize: 13 }}>📄 Docs</a>}
        {provider.pricing_url && <a href={provider.pricing_url} target="_blank" rel="noreferrer" style={{ color: "#6366f1", fontSize: 13 }}>💰 Pricing</a>}
      </div>
      <div style={{ marginTop: 16 }}>
        <label style={{ color: "#a0a0cc", fontSize: 13 }}>API Key (required to approve)
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="Enter the API key you obtained from this provider"
            style={{ display: "block", width: "100%", marginTop: 6, padding: "10px 14px", background: "#0f0f1a", border: apiKey ? "1px solid #6366f1" : "1px solid #2a2a4e", borderRadius: 8, color: "#e0e0ff", fontSize: 14, boxSizing: "border-box" }}
          />
        </label>
      </div>
      {error && <div style={{ color: "#fca5a5", fontSize: 13, marginTop: 8 }}>❌ {error}</div>}
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <button
          onClick={() => decide(true)}
          disabled={busy || !apiKey.trim()}
          title={!apiKey.trim() ? "Enter an API key first" : undefined}
          style={{
            flex: 1,
            background: apiKey.trim() ? "#22c55e" : "#1a3a1a",
            color: apiKey.trim() ? "#fff" : "#555",
            border: "none",
            borderRadius: 8,
            padding: "10px 0",
            fontWeight: 700,
            cursor: busy || !apiKey.trim() ? "not-allowed" : "pointer",
            fontSize: 14,
          }}
        >
          {busy ? "Processing…" : "✅ Approve"}
        </button>
        <button
          onClick={() => decide(false)}
          disabled={busy}
          style={{
            flex: 1,
            background: "#3a1a1a",
            color: "#fca5a5",
            border: "1px solid #ef4444",
            borderRadius: 8,
            padding: "10px 0",
            fontWeight: 700,
            cursor: busy ? "not-allowed" : "pointer",
            fontSize: 14,
          }}
        >
          ⏭️ Skip
        </button>
      </div>
    </div>
  );
}

export default function ApprovalsPage() {
  const [pending, setPending] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const data = await getPendingApprovals();
      setPending(data.pending);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ color: "#6366f1" }}>⏳ Pending Approvals</h2>
        <button onClick={load} style={{ background: "#2a2a4e", color: "#a0a0cc", border: "none", borderRadius: 8, padding: "8px 16px", cursor: "pointer" }}>🔄 Refresh</button>
      </div>
      <p style={{ color: "#666", fontSize: 13 }}>These providers were discovered by the autonomous crawler and require an API key to proceed with fingerprinting.</p>
      {loading && <div style={{ color: "#666" }}>Loading…</div>}
      {error && <div style={{ color: "#fca5a5" }}>❌ {error}</div>}
      {!loading && pending.length === 0 && <div style={{ color: "#666", textAlign: "center", padding: 40 }}>No pending approvals.</div>}
      {pending.map(p => (
        <ApprovalCard key={p.id} provider={p} onDecided={load} />
      ))}
    </div>
  );
}
