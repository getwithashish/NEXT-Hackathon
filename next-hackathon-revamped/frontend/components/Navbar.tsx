"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fingerprint, ClipboardList, Clock, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

const links = [
  { href: "/",            label: "Dashboard",    icon: Activity },
  { href: "/fingerprint", label: "Fingerprint",  icon: Fingerprint },
  { href: "/jobs",        label: "All Jobs",      icon: ClipboardList },
  { href: "/approvals",   label: "Approvals",     icon: Clock },
];

export function Navbar() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 w-full border-b border-white/5 bg-[#0f1011]/80 backdrop-blur-md">
      <div className="mx-auto flex h-12 max-w-7xl items-center gap-8 px-6">
        {/* Brand */}
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <Fingerprint className="h-5 w-5 text-accent-bright" />
          <span className="text-sm font-[510] tracking-tight text-text-primary">
            ModelScope
          </span>
        </Link>

        {/* Nav links */}
        <nav className="flex items-center gap-1">
          {links.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || (href !== "/" && pathname.startsWith(href));
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-1.5 rounded px-3 py-1.5 text-[13px] font-[510] transition-colors",
                  active
                    ? "bg-white/5 text-text-primary"
                    : "text-text-muted hover:bg-white/5 hover:text-text-secondary"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Right: CTA */}
        <div className="ml-auto">
          <Link
            href="/fingerprint"
            className="rounded bg-accent px-3 py-1.5 text-[13px] font-[510] text-white transition-colors hover:bg-accent-hover"
          >
            + New Job
          </Link>
        </div>
      </div>
    </header>
  );
}
