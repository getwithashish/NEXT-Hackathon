"use client";

import { useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Fingerprint, LogIn } from "lucide-react";
import { signIn, useSession } from "@/lib/auth-client";

function LoginContent() {
  const { data: session } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/fingerprint";

  // Already logged in — redirect
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

        {/* Google button */}
        <button
          onClick={() =>
            signIn.social({
              provider: "google",
              callbackURL: callbackUrl,
            })
          }
          className="w-full flex items-center justify-center gap-3 rounded-md border border-white/[0.10] bg-white/[0.04] px-4 py-3 text-[14px] font-[510] text-text-primary transition-all hover:bg-white/[0.08] hover:border-white/[0.15] active:scale-[0.98]"
        >
          {/* Google SVG */}
          <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24">
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              fill="#4285F4"
            />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853"
            />
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              fill="#EA4335"
            />
          </svg>
          Continue with Google
        </button>

        <p className="text-[11px] text-text-subtle">
          Only used for authentication — we don&apos;t store your data.
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
