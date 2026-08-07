/**
 * ★ Decoding the `originalMessage` payload.
 *
 * OPEN_BOOK carries one market id, and it arrives by two different routes that
 * encode it differently:
 *
 *   on-chain  — `InstructionSender.sendOpenBook(bytes32)` passes
 *               `abi.encode(marketId)`, which for a single bytes32 is exactly
 *               the 32 raw bytes.
 *   direct    — the settlement keeper and the app POST `/action` with
 *               `{"marketId":"0x…"}` as UTF-8 JSON.
 *
 * Both are accepted and normalized here. Length is the discriminator: a bytes32
 * is 32 bytes, and no JSON object that small is valid, so the two cannot be
 * confused.
 */

const MARKET_ID_RE = /^0x[0-9a-fA-F]{64}$/;

/** Decode an OPEN_BOOK payload to a market id, or throw with a usable message. */
export function decodeMarketId(msgHex: string): `0x${string}` {
  const hex = String(msgHex ?? "").replace(/^0x/, "");
  if (hex.length % 2 !== 0) throw new Error("invalid hex: odd length");
  if (hex.length > 0 && !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("invalid hex: non-hex characters");
  }
  if (hex.length === 0) throw new Error("empty payload: expected a market id");

  const bytes = Buffer.from(hex, "hex");

  // abi.encode(bytes32) — the raw word, no offset or length prefix.
  if (bytes.length === 32) return `0x${hex.toLowerCase()}`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf-8"));
  } catch {
    throw new Error(
      `payload is neither a 32-byte market id nor JSON (got ${bytes.length} bytes)`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("payload JSON must be an object with a marketId");
  }
  const marketId = (parsed as { marketId?: unknown }).marketId;
  if (typeof marketId !== "string" || !MARKET_ID_RE.test(marketId)) {
    throw new Error("marketId must be a 32-byte hex id");
  }
  return marketId.toLowerCase() as `0x${string}`;
}
