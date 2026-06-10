"use client";

import { useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Fingerprint } from "lucide-react";
import { signIn, useSession } from "@/lib/auth-client";

function LoginContent() {
  const { data: session } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/fingerprint";

  useEffect(() => {
    if (session?.user) router.replace(callbackUrl);
  }, [session, callbackUrl, router]);

  return (
    <div className="flex min-h-[70vh] items-center justify-center animate-fade-in">
      <div className="surface-card hairline-top w-full max-w-sm p-8 text-center space-y-6">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-gradient shadow-glow-accent">
            <Fingerprint className="h-6 w-6 text-white" />
          </span>
          <div>
            <h1 className="text-[18px] font-[640] text-gradient">llmHash</h1>
            <p className="text-[13px] text-text-muted mt-1">Sign in to fingerprint a model</p>
          </div>
        </div>

        {/* GitHub button */}
        <button
          onClick={() =>
            signIn.social({
              provider: "github",
              callbackURL: callbackUrl,
            })
          }
          className="w-full flex items-center justify-center gap-3 rounded-md border border-white/[0.10] bg-white/[0.04] px-4 py-3 text-[14px] font-[510] text-text-primary transition-all hover:bg-white/[0.08] hover:border-white/[0.15] active:scale-[0.98]"
        >
          {/* GitHub SVG */}
          <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
          </svg>
          Continue with GitHub
        </button>

        <p className="text-[11px] text-text-subtle">
          Only your name and avatar are used — no repo access.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}
