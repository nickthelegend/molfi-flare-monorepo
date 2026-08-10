/** Molfi handlers — the MOLFI/SEAL_KEY and MOLFI/OPEN_BOOK contract surface. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as handlers from "../app/handlers.js";
import { decodeMarketId } from "../app/abi.js";
import { bytesToHex, hexToBytes } from "../base/encoding.js";
import type { HandlerResult } from "../base/types.js";

/** A deterministic enclave identity so the published key is assertable. */
const ENCLAVE_KEY = `0x${"a1".repeat(32)}`;
const SIGNER_KEY = `0x${"b2".repeat(32)}`;
const BOOK = "0x22B0F197b12e86653d449326b7677e65e2162c90";
const MARKET = `0x${"7c".repeat(32)}`;

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  CHAIN_ID: "114",
  CHAIN_URL: "https://coston2-api.flare.network/ext/C/rpc",
  ENCLAVE_PRIVATE_KEY: ENCLAVE_KEY,
  TEE_SIGNER_KEY: SIGNER_KEY,
  SIMULATED_TEE: "true",
  ...extra,
});

function parseData(result: HandlerResult): Record<string, unknown> {
  return JSON.parse(Buffer.from(hexToBytes(result[0]!)).toString("utf-8"));
}

const jsonMsg = (obj: unknown): string =>
  bytesToHex(Buffer.from(JSON.stringify(obj), "utf-8"));

beforeEach(() => handlers.resetState(env({ SEALED_BID_BOOK: BOOK })));
afterEach(() => handlers.resetState(env()));

describe("MOLFI/SEAL_KEY", () => {
  it("publishes a compressed secp256k1 public key", () => {
    const [, status] = handlers.handleSealKey("0x");
    expect(status).toBe(1);

    const data = parseData(handlers.handleSealKey("0x"));
    expect(String(data.publicKey)).toMatch(/^0x0[23][0-9a-f]{64}$/);
    expect(data.chainId).toBe(114);
    expect(data.book).toBe(BOOK);
  });

  it("is stable across calls — a rotating key would strand sealed bids", () => {
    const a = parseData(handlers.handleSealKey("0x")).publicKey;
    const b = parseData(handlers.handleSealKey("0x")).publicKey;
    expect(a).toBe(b);
  });

  it("never publishes the private half", () => {
    const raw = JSON.stringify(parseData(handlers.handleSealKey("0x")));
    expect(raw).not.toContain("a1a1a1");
  });
});

describe("MOLFI/OPEN_BOOK payload decoding", () => {
  it("accepts abi.encode(bytes32) — the on-chain route", () => {
    expect(decodeMarketId(MARKET)).toBe(MARKET);
  });

  it("accepts JSON — the keeper/app route", () => {
    expect(decodeMarketId(jsonMsg({ marketId: MARKET }))).toBe(MARKET);
  });

  it("rejects an empty payload", () => {
    expect(() => decodeMarketId("0x")).toThrow(/empty payload/);
  });

  it("rejects a short id rather than zero-padding it", () => {
    expect(() => decodeMarketId("0xdeadbeef")).toThrow();
  });

  it("rejects non-hex", () => {
    expect(() => decodeMarketId("0xZZ")).toThrow(/non-hex/);
  });

  it("rejects JSON without a well-formed marketId", async () => {
    const [data, status, err] = await handlers.handleOpenBook(jsonMsg({ marketId: "nope" }));
    expect(status).toBe(0);
    expect(data).toBeNull();
    expect(err).toMatch(/marketId must be a 32-byte hex id/);
  });
});

describe("MOLFI/OPEN_BOOK response shape", () => {
  it("is documented as the ABI tuple, not JSON", () => {
    // The response is consumed by `SealedBidBook.openMarketFromTee`, which
    // abi.decodes it. tee-node signs whatever comes back, so a JSON blob would
    // be just as signed and completely unusable on-chain. The happy path needs
    // a live chain (see molfi-contracts/scripts/fcc-e2e-local.ts); what is
    // assertable here is that the two commands are distinct, so nobody
    // "simplifies" them back into one.
    expect(handlers.handleOpenBook).not.toBe(handlers.handleOpenings);
  });
});

describe("MOLFI/OPEN_BOOK configuration", () => {
  it("fails cleanly when no book is configured", async () => {
    handlers.resetState(env()); // no SEALED_BID_BOOK
    const [, status, err] = await handlers.handleOpenBook(MARKET);
    expect(status).toBe(0);
    expect(err).toMatch(/SEALED_BID_BOOK is not configured/);
  });
});

describe("reported state", () => {
  it("exposes the sealing key and signer, and no market's split", () => {
    const state = handlers.reportState() as Record<string, unknown>;
    expect(state.extension).toBe("molfi-sealed-book");
    expect(state.commands).toEqual(["SEAL_KEY", "OPEN_BOOK", "OPENINGS"]);
    expect(String(state.enclavePublicKey)).toMatch(/^0x0[23][0-9a-f]{64}$/);
    expect(state.openedCount).toBe(0);

    // The point of the product: nothing here can reveal a live book's lean.
    const keys = Object.keys(state);
    expect(keys).not.toContain("yesPool");
    expect(keys).not.toContain("noPool");
  });

  it("is JSON-serializable — a bigint here would 500 the /state endpoint", () => {
    expect(() => JSON.stringify(handlers.reportState())).not.toThrow();
  });
});
