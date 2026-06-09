import Link from "next/link";
export default function Home() {
  return (
    <div>
      <h1 style={{ color: "#6366f1" }}>Model Fingerprint Verifier</h1>
      <p style={{ color: "#a0a0cc" }}>Detect cloned or distilled LLMs via behavioral fingerprinting.</p>
      <div style={{ display: "flex", gap: 16, marginTop: 24 }}>
        <Link href="/fingerprint" style={{ background: "#6366f1", color: "#fff", padding: "12px 24px", borderRadius: 8, textDecoration: "none", fontWeight: 600 }}>
          🔍 Fingerprint a Model
        </Link>
        <Link href="/approvals" style={{ background: "#1a1a2e", color: "#e0e0ff", padding: "12px 24px", borderRadius: 8, textDecoration: "none", border: "1px solid #2a2a4e" }}>
          ⏳ Pending Approvals
        </Link>
      </div>
    </div>
  );
}
