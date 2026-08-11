import { useEffect, useState } from "react";
import { assetIconUrl } from "@/lib/asset-icons";
import { normalizeProtectionBase } from "@/lib/markets";
import { cn } from "@/lib/utils";

const MONOGRAM_COLORS: Record<string, string> = {
  FLR: "bg-pink-500/10 text-pink-600 ring-pink-400/25",
  SUI: "bg-accent/12 text-accent ring-accent/25",
  ETH: "bg-violet-500/10 text-violet-600 ring-violet-400/25",
  BTC: "bg-orange-500/10 text-orange-600 ring-orange-400/25",
  SOL: "bg-emerald-500/10 text-emerald-600 ring-emerald-400/25",
};

const SIZE_CLASS = {
  sm: "h-6 w-6 text-[10px]",
  md: "h-9 w-9 text-sm",
  lg: "h-12 w-12 text-sm",
} as const;

export type AssetBadgeSize = keyof typeof SIZE_CLASS;

export function AssetBadge({
  asset,
  size = "sm",
  className,
  iconUrl,
}: {
  asset: string;
  size?: AssetBadgeSize;
  className?: string;
  /** Explicit thumbnail (e.g. a Polymarket market image); overrides the asset icon. */
  iconUrl?: string;
}) {
  const label = normalizeProtectionBase(asset) || asset.trim().toUpperCase() || "?";
  const src = iconUrl || assetIconUrl(asset);
  const sizeClass = SIZE_CLASS[size];

  /**
   * Fall back to the monogram when the remote icon 404s.
   *
   * The monogram below already existed but was unreachable whenever a URL was
   * present — and the backend hands every market a `cdn.jsdelivr.net/.../<sym>.png`,
   * which that icon set does not have for FLR. So every FLR market — on Flare's
   * own token — rendered a broken-image box. Any symbol the CDN lacks now
   * degrades to the monogram instead.
   */
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        role="presentation"
        onError={() => setFailed(true)}
        className={cn(
          "shrink-0 rounded-full object-cover ring-1 ring-border",
          sizeClass,
          className,
        )}
      />
    );
  }

  const cls = MONOGRAM_COLORS[label] ?? "bg-secondary text-foreground ring-border";
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-sans font-semibold ring-1",
        sizeClass,
        cls,
        className,
      )}
    >
      {label.length > 4 ? label.slice(0, 3) : label}
    </span>
  );
}
