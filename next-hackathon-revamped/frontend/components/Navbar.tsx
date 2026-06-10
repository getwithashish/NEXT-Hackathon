"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fingerprint, ClipboardList, Clock, Activity, Menu, X } from "lucide-react";
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
      <header className="sticky top-0 z-40 w-full border-b border-white/[0.07] bg-[#0b0c0d]/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">

          {/* Brand */}
          <Link
            href="/"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 shrink-0 group"
          >
            <span className="relative flex h-7 w-7 items-center justify-center rounded-lg bg-accent-gradient shadow-glow-accent-sm transition-transform group-hover:scale-105">
              <Fingerprint className="h-4 w-4 text-white" />
            </span>
            <span className="text-[15px] font-[600] tracking-tight text-gradient">
              llmHash
            </span>
          </Link>

          {/* Desktop nav links */}
          <nav className="hidden md:flex items-center gap-0.5 ml-2">
            {links.map(({ href, label, icon: Icon }) => {
              const active = pathname === href || (href !== "/" && pathname.startsWith(href));
              return (
                <Link
                  key={href}
                  href={href}
                  className={cn(
                    "relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-[510] transition-all duration-150",
                    active
                      ? "bg-white/[0.07] text-text-primary shadow-elevation-low"
                      : "text-text-muted hover:bg-white/[0.04] hover:text-text-secondary"
                  )}
                >
                  <Icon className={cn("h-3.5 w-3.5", active && "text-accent-bright")} />
                  {label}
                </Link>
              );
            })}
          </nav>

          {/* Right: CTA (desktop) + hamburger (mobile) */}
          <div className="ml-auto flex items-center gap-2">
            {/* Hamburger — mobile only */}
            <button
              onClick={() => setOpen((v) => !v)}
              aria-label="Toggle menu"
              className="md:hidden flex h-8 w-8 items-center justify-center rounded-md border border-white/[0.07] text-text-muted hover:bg-white/5 hover:text-text-primary transition-colors"
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


          </div>
        )}
      </header>
    </>
  );
}
