"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fingerprint, ClipboardList, Clock, Activity, Menu, X, LogIn, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession, signOut } from "@/lib/auth-client";
import Image from "next/image";

const links = [
  { href: "/",            label: "Dashboard",   icon: Activity },
  { href: "/fingerprint", label: "Fingerprint", icon: Fingerprint },
  { href: "/jobs",        label: "All Jobs",     icon: ClipboardList },
  { href: "/approvals",   label: "Approvals",    icon: Clock },
];

export function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { data: session } = useSession();
  const user = session?.user;

  async function handleSignOut() {
    await signOut();
    router.push("/login");
    setOpen(false);
  }

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

          {/* Right: user / sign-in + hamburger */}
          <div className="ml-auto flex items-center gap-2">

            {/* Desktop: user info or sign-in */}
            {user ? (
              <div className="hidden md:flex items-center gap-2">
                {user.image ? (
                  <Image
                    src={user.image}
                    alt={user.name ?? "avatar"}
                    width={28}
                    height={28}
                    className="rounded-full ring-1 ring-white/10"
                  />
                ) : (
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/20 text-[12px] font-[600] text-accent-bright ring-1 ring-accent/20">
                    {(user.name ?? user.email ?? "?")[0].toUpperCase()}
                  </span>
                )}
                <span className="text-[13px] text-text-secondary max-w-[120px] truncate">
                  {user.name ?? user.email}
                </span>
                <button
                  onClick={handleSignOut}
                  className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[12px] text-text-muted hover:bg-white/5 hover:text-text-secondary transition-colors"
                  title="Sign out"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Sign out
                </button>
              </div>
            ) : (
              <Link
                href="/login"
                className="hidden md:flex items-center gap-1.5 rounded-md border border-white/[0.08] px-3 py-1.5 text-[13px] font-[510] text-text-secondary hover:bg-white/5 hover:text-text-primary transition-colors"
              >
                <LogIn className="h-3.5 w-3.5" />
                Sign in
              </Link>
            )}

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

            {/* Mobile sign-in / sign-out */}
            <div className="mt-3 border-t border-white/5 pt-3">
              {user ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 px-3 py-1">
                    {user.image ? (
                      <Image src={user.image} alt="" width={24} height={24} className="rounded-full" />
                    ) : (
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/20 text-[11px] font-[600] text-accent-bright">
                        {(user.name ?? user.email ?? "?")[0].toUpperCase()}
                      </span>
                    )}
                    <span className="text-[13px] text-text-secondary truncate">{user.name ?? user.email}</span>
                  </div>
                  <button
                    onClick={handleSignOut}
                    className="flex w-full items-center gap-2 rounded px-3 py-2.5 text-[14px] text-text-muted hover:bg-white/5 hover:text-text-secondary transition-colors"
                  >
                    <LogOut className="h-4 w-4" />
                    Sign out
                  </button>
                </div>
              ) : (
                <Link
                  href="/login"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2 rounded px-3 py-2.5 text-[14px] text-text-muted hover:bg-white/5 hover:text-text-secondary transition-colors"
                >
                  <LogIn className="h-4 w-4" />
                  Sign in
                </Link>
              )}
            </div>
          </div>
        )}
      </header>
    </>
  );
}
