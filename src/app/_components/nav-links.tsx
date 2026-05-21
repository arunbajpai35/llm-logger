"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Chat" },
  { href: "/conversations", label: "Conversations" },
  { href: "/dashboard", label: "Dashboard" },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1">
      {LINKS.map((l) => {
        const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={
              "px-3 py-1.5 text-sm rounded-md transition-colors " +
              (active
                ? "text-[var(--text)] bg-[var(--bg-hover)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)]")
            }
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
