import type { Metadata } from "next";
import { Navbar } from "@/components/Navbar";
import "./globals.css";

export const metadata: Metadata = {
  title: "ModelScope — LLM Fingerprint Verifier",
  description: "Detect cloned or distilled LLMs via behavioral fingerprinting",
  viewport: "width=device-width, initial-scale=1",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg-base text-text-primary font-sans antialiased">
        <Navbar />
        <main className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
