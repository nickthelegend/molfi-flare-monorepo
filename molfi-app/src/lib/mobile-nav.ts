import { LayoutGrid, Trophy, Vault, Wallet, type LucideIcon } from "lucide-react";

export type MobileNavItem = {
  label: string;
  icon: LucideIcon;
  to: string;
  isActive: (pathname: string) => boolean;
  /** Center hero tab. */
  featured?: boolean;
};

export const MOBILE_BOTTOM_NAV: MobileNavItem[] = [
  {
    label: "Markets",
    icon: LayoutGrid,
    to: "/markets",
    isActive: (pathname) =>
      pathname.startsWith("/markets") || pathname.startsWith("/predictions"),
  },
  {
    label: "Portfolio",
    icon: Wallet,
    to: "/portfolio",
    isActive: (pathname) => pathname.startsWith("/portfolio"),
  },
  // Vault and Leaderboard exist as routes and are linked from the desktop
  // header, but the header collapses below `md` — so on a phone these two
  // screens had no entry point at all and were reachable only by typing the URL.
  {
    label: "Vault",
    icon: Vault,
    to: "/vault",
    isActive: (pathname) => pathname.startsWith("/vault"),
  },
  {
    label: "Leaders",
    icon: Trophy,
    to: "/leaderboard",
    isActive: (pathname) => pathname.startsWith("/leaderboard"),
  },
];
