import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "Model Fingerprint Verifier",
  description: "Detect cloned or distilled LLMs via behavioral fingerprinting",
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#0f0f1a", color: "#e0e0ff" }}>
        <nav style={{ background: "#1a1a2e", padding: "12px 24px", borderBottom: "1px solid #2a2a4e", display: "flex", gap: 24 }}>
          <a href="/" style={{ color: "#6366f1", textDecoration: "none", fontWeight: 700 }}>🔍 Model Fingerprinter</a>
          <a href="/fingerprint" style={{ color: "#a0a0cc", textDecoration: "none" }}>Fingerprint</a>
          <a href="/approvals" style={{ color: "#a0a0cc", textDecoration: "none" }}>Pending Approvals</a>
          <a href="/jobs" style={{ color: "#a0a0cc", textDecoration: "none" }}>All Jobs</a>
        </nav>
        <main style={{ maxWidth: 900, margin: "0 auto", padding: "24px 16px" }}>
          {children}
        </main>
      </body>
    </html>
  );
}
