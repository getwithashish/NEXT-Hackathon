import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Vercel Workflow Demo",
  description: "Durable workflows with Human-in-the-Loop",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
