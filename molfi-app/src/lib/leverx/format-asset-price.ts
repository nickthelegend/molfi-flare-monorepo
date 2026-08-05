import { formatDecimalWithSubscript, truncateToFractionDigits } from "@/lib/format-decimal-subscript";

/**
 * Precision that suits the magnitude.
 *
 * A flat 2 decimals is fine for BTC and ETH but destroys sub-dollar assets:
 * FLR trades near $0.006, which truncates to 0.00 and renders as "$0" — the
 * price looks broken and the strike is unreadable. Molfi lists FLR and XRP
 * alongside BTC, so the formatter has to scale with the number.
 */
function defaultFractionDigits(usd: number): number {
  if (usd >= 100) return 2;
  if (usd >= 1) return 4;
  return 6;
}

/** Full USD asset price — never K/M/B/T (oracle spot, strikes, chart guides). */
export function formatAssetPriceUsd(
  usd: number,
  options?: { maximumFractionDigits?: number },
): string {
  if (!Number.isFinite(usd) || usd <= 0) return "—";

  const subscript = formatDecimalWithSubscript(usd);
  if (subscript !== null) return subscript;

  const maximumFractionDigits =
    options?.maximumFractionDigits ?? defaultFractionDigits(usd);
  const truncated = truncateToFractionDigits(usd, maximumFractionDigits);
  return truncated.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  });
}

export function formatAssetPriceUsdWithSymbol(
  usd: number,
  options?: { maximumFractionDigits?: number },
): string {
  return `$${formatAssetPriceUsd(usd, options)}`;
}

/** On-chain strike field (1e9 scale) → full USD label. */
export function formatStrikeUsdFromRaw(strikeRaw: number): string {
  if (strikeRaw <= 0) return "—";
  return formatAssetPriceUsdWithSymbol(strikeRaw / 1e9);
}
