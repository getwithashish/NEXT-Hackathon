"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fingerprint, ClipboardList, Clock, Activity, Menu, X, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

const links = [
  { href: "/",            label: "Dashboard",   icon: Activity },
  { href: "/fingerprint", label: "Fingerprint", icon: Fingerprint },
  { href: "/jobs",        label: "All Jobs",     icon: ClipboardList },
  { href: "/approvals",   label: "Approvals",    icon: Clock },
];

export function Navbar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      <header className="sticky top-0 z-40 w-full border-b border-white/5 bg-[#0f1011]/90 backdrop-blur-md">
        <div className="mx-auto flex h-12 max-w-7xl items-center gap-4 px-4 sm:px-6">

          {/* Brand */}
          <Link
            href="/"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 shrink-0"
          >
            <Fingerprint className="h-5 w-5 text-accent-bright" />
            <span className="text-sm font-[510] tracking-tight text-text-primary">
              llmHash
            </span>
          </Link>

          {/* Desktop nav links */}
          <nav className="hidden md:flex items-center gap-1">
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

          {/* Right: CTA (desktop) + hamburger (mobile) */}
          <div className="ml-auto flex items-center gap-2">
            <Link
              href="/fingerprint"
              className="hidden sm:flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-[13px] font-[510] text-white transition-colors hover:bg-accent-hover"
            >
              <Plus className="h-3.5 w-3.5" />
              New Job
            </Link>

            {/* Hamburger — mobile only */}
            <button
              onClick={() => setOpen((v) => !v)}
              aria-label="Toggle menu"
              className="md:hidden flex h-8 w-8 items-center justify-center rounded border border-white/8 text-text-muted hover:bg-white/5 hover:text-text-primary transition-colors"
            >
              {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {/* Mobile dropdown menu */}
        {open && (
          <div className="md:hidden border-t border-white/5 bg-[#0f1011] px-4 pb-4 pt-2 animate-fade-in">
            <nav className="flex flex-col gap-1">
              {links.map(({ href, label, icon: Icon }) => {
                const active = pathname === href || (href !== "/" && pathname.startsWith(href));
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setOpen(false)}
                    className={cn(
                      "flex items-center gap-3 rounded px-3 py-2.5 text-[14px] font-[510] transition-colors",
                      active
                        ? "bg-white/5 text-text-primary"
                        : "text-text-muted hover:bg-white/5 hover:text-text-secondary"
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {label}
                  </Link>
                );
              })}
            </nav>

            <div className="mt-3 border-t border-white/5 pt-3">
              <Link
                href="/fingerprint"
                onClick={() => setOpen(false)}
                className="flex w-full items-center justify-center gap-2 rounded bg-accent py-2.5 text-[14px] font-[590] text-white transition-colors hover:bg-accent-hover"
              >
                <Plus className="h-4 w-4" />
                New Job
              </Link>
            </div>
          </div>
        )}
      </header>
    </>
  );
}
