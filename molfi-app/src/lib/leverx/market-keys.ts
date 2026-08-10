/**
 * Pure market-key helpers: turn a market row into a stable id.
 *
 * The `add*MarketKey` PTB builders that used to live here took a Sui
 * `Transaction` and are gone with the rest of the DeepBook Predict layer. What
 * remains is string manipulation with no chain dependency at all.
 */

export type MarketKeyArgs = {
  oracleId: string;
  expiryMs: number;
  strike: number;
  higherStrike?: number;
  isUp: boolean;
  isRange: boolean;
};

export function marketRowToKey(row: {
  oracleId: string;
  expiry: number;
  strikeRaw: number;
  higherStrikeRaw: number;
  isUp: boolean;
  isRange: boolean;
}): MarketKeyArgs | undefined {
  if (row.expiry <= 0 || row.strikeRaw <= 0) return undefined;
  if (row.isRange && row.higherStrikeRaw <= row.strikeRaw) return undefined;
  return {
    oracleId: row.oracleId,
    expiryMs: row.expiry,
    strike: row.strikeRaw,
    higherStrike: row.isRange ? row.higherStrikeRaw : 0,
    isUp: row.isUp,
    isRange: row.isRange,
  };
}


export function positionKeyFromArgs(args: MarketKeyArgs): string {
  const higherStrike = args.isRange ? (args.higherStrike ?? 0) : 0;
  const isUp = args.isRange ? true : args.isUp;
  return `${args.oracleId}:${args.expiryMs}:${args.strike}:${higherStrike}:${isUp ? 1 : 0}:${args.isRange ? 1 : 0}`;
}
