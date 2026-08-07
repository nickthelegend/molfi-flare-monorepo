/** Server routing and wire format — docs/extension-contract.md §2, §4. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { VERSION } from "../app/config.js";
import * as handlers from "../app/handlers.js";
import { bytesToHex, hexToBytes, stringToBytes32Hex } from "../base/encoding.js";
import { Server } from "../base/server.js";

const ENCLAVE_KEY = `0x${"a1".repeat(32)}`;
const SIGNER_KEY = `0x${"b2".repeat(32)}`;
const BOOK = "0x22B0F197b12e86653d449326b7677e65e2162c90";

const env: NodeJS.ProcessEnv = {
  CHAIN_ID: "114",
  ENCLAVE_PRIVATE_KEY: ENCLAVE_KEY,
  TEE_SIGNER_KEY: SIGNER_KEY,
  SEALED_BID_BOOK: BOOK,
  SIMULATED_TEE: "true",
};

let srv: Server;

beforeEach(() => {
  handlers.resetState(env);
  srv = new Server(0, 0, VERSION, handlers.register, handlers.reportState);
});
afterEach(() => handlers.resetState(env));

/** Build a POST /action body in the exact shape tee-node sends. */
function buildAction(opts: {
  opType?: string;
  opCommand?: string;
  original?: Buffer | Uint8Array;
  actionId?: string;
} = {}): string {
  const {
    opType = "MOLFI",
    opCommand = "SEAL_KEY",
    original = Buffer.alloc(0),
    actionId = `0x${"11".repeat(32)}`,
  } = opts;

  const dataFixed = {
    instructionId: actionId,
    teeId: `0x${"22".repeat(20)}`,
    timestamp: 1700000000,
    rewardEpochId: 42,
    opType: stringToBytes32Hex(opType),
    opCommand: stringToBytes32Hex(opCommand),
    cosigners: [],
    cosignersThreshold: 0,
    originalMessage: bytesToHex(new Uint8Array(original)),
    additionalFixedMessage: "0x",
  };

  return JSON.stringify({
    data: {
      id: actionId,
      type: "instruction",
      submissionTag: "submit",
      message: bytesToHex(Buffer.from(JSON.stringify(dataFixed), "utf-8")),
    },
    additionalVariableMessages: [],
    timestamps: [],
    additionalActionData: "0x",
    signatures: [],
  });
}

describe("routing", () => {
  it("returns 405 for GET /action", async () => {
    expect((await srv.handleRequest("GET", "/action", ""))[0]).toBe(405);
  });

  it("returns 405 for POST /state", async () => {
    expect((await srv.handleRequest("POST", "/state", ""))[0]).toBe(405);
  });

  it("returns 404 for unknown paths", async () => {
    expect((await srv.handleRequest("GET", "/nope", ""))[0]).toBe(404);
    expect((await srv.handleRequest("POST", "/nope", ""))[0]).toBe(404);
  });

  it("returns 501 for an unknown op type", async () => {
    const [status, body] = await srv.handleRequest(
      "POST", "/action", buildAction({ opType: "GREETING" }),
    );
    expect(status).toBe(501);
    expect(body).toBe("unsupported op type");
  });

  it("returns 501 for an unknown op command", async () => {
    const [status] = await srv.handleRequest(
      "POST", "/action", buildAction({ opCommand: "NOPE" }),
    );
    expect(status).toBe(501);
  });

  it("ignores the query string", async () => {
    expect((await srv.handleRequest("GET", "/state?verbose=1", ""))[0]).toBe(200);
  });
});

describe("malformed input", () => {
  it("returns 400 for a non-JSON body", async () => {
    expect((await srv.handleRequest("POST", "/action", "not json"))[0]).toBe(400);
  });

  it("returns 400 when data is missing", async () => {
    expect((await srv.handleRequest("POST", "/action", '{"foo":1}'))[0]).toBe(400);
  });

  it("returns 400 for invalid hex in message", async () => {
    const body = JSON.stringify({
      data: { id: "0x1", type: "instruction", submissionTag: "submit", message: "0xZZ" },
    });
    expect((await srv.handleRequest("POST", "/action", body))[0]).toBe(400);
  });

  it("returns 400 when message is not JSON", async () => {
    const body = JSON.stringify({
      data: {
        id: "0x1", type: "instruction", submissionTag: "submit",
        message: bytesToHex(Buffer.from("not json")),
      },
    });
    expect((await srv.handleRequest("POST", "/action", body))[0]).toBe(400);
  });
});

describe("ActionResult wire format", () => {
  it("returns the success shape", async () => {
    const [status, body] = await srv.handleRequest("POST", "/action", buildAction());
    const r = body as Record<string, unknown>;

    expect(status).toBe(200);
    expect(r.status).toBe(1);
    expect(r.log).toBe("ok");
    expect(r.opType).toBe(stringToBytes32Hex("MOLFI"));
    expect(r.opCommand).toBe(stringToBytes32Hex("SEAL_KEY"));
    expect(String(r.data).startsWith("0x")).toBe(true);
  });

  it("sends version as a plain string, not bytes32", async () => {
    // Contract §4.4: tee-node declares `Version string`. The sign repo's
    // Python/TS ports hex-encode this and are wrong; this test pins it.
    const [, body] = await srv.handleRequest("POST", "/action", buildAction());
    const r = body as Record<string, unknown>;

    expect(r.version).toBe(VERSION);
    expect(String(r.version).startsWith("0x")).toBe(false);
  });

  it("reports handler failure as HTTP 200 with status 0", async () => {
    // An OPEN_BOOK with no market id is a handler-level failure, not a
    // transport-level one.
    const [status, body] = await srv.handleRequest(
      "POST", "/action", buildAction({ opCommand: "OPEN_BOOK" }),
    );
    const r = body as Record<string, unknown>;

    expect(status).toBe(200);
    expect(r.status).toBe(0);
    expect(String(r.log).startsWith("error: ")).toBe(true);
    // Present as "0x", not omitted: the Go struct has no omitempty.
    expect(r.data).toBe("0x");
  });

  it("always emits every field", async () => {
    // tee-node's ActionResult has no omitempty tags, so every field appears on
    // the wire regardless of value.
    const [, body] = await srv.handleRequest("POST", "/action", buildAction());
    const r = body as Record<string, unknown>;

    expect(Object.keys(r).sort()).toEqual([
      "additionalResultStatus", "data", "id", "log", "opCommand",
      "opType", "status", "submissionTag", "version",
    ]);
    expect(r.additionalResultStatus).toBe("0x");
  });

  it("echoes id and submissionTag", async () => {
    const actionId = `0x${"ab".repeat(32)}`;
    const [, body] = await srv.handleRequest("POST", "/action", buildAction({ actionId }));
    const r = body as Record<string, unknown>;

    expect(r.id).toBe(actionId);
    expect(r.submissionTag).toBe("submit");
  });

  it("carries the sealing key a client needs in order to bid", async () => {
    const [, body] = await srv.handleRequest("POST", "/action", buildAction());
    const r = body as Record<string, unknown>;
    const payload = JSON.parse(
      Buffer.from(hexToBytes(r.data as string)).toString("utf-8"),
    );

    expect(String(payload.publicKey)).toMatch(/^0x0[23][0-9a-f]{64}$/);
    expect(payload.book).toBe(BOOK);
  });
});

describe("state wire format", () => {
  it("sends stateVersion as bytes32", async () => {
    // Asymmetric with ActionResult.version by design — contract §4.5.
    const [status, body] = await srv.handleRequest("GET", "/state", "");
    const r = body as Record<string, unknown>;

    expect(status).toBe(200);
    expect(r.stateVersion).toBe(stringToBytes32Hex(VERSION));
    expect(String(r.stateVersion).length).toBe(66);
  });

  it("agrees with SEAL_KEY about the enclave's identity", async () => {
    // If /state and /action ever disagreed, a client could seal to a key the
    // opener does not hold — and the bid would be unopenable.
    const [, action] = await srv.handleRequest("POST", "/action", buildAction());
    const published = JSON.parse(
      Buffer.from(hexToBytes((action as Record<string, unknown>).data as string)).toString("utf-8"),
    );

    const [, body] = await srv.handleRequest("GET", "/state", "");
    const state = (body as { state: Record<string, unknown> }).state;

    expect(state.enclavePublicKey).toBe(published.publicKey);
    expect(state.teeSigner).toBe(published.teeSigner);
  });
});

describe("serialization", () => {
  it("does not wedge the queue when a handler throws", async () => {
    // A rejected handler must not block subsequent requests (contract §5).
    const boom = new Server(0, 0, VERSION, (f) => {
      f.handle("MOLFI", "SEAL_KEY", () => {
        throw new Error("boom");
      });
    }, () => ({ ok: true }));

    await expect(
      boom.handleRequest("POST", "/action", buildAction()),
    ).rejects.toThrow("boom");

    // The queue must still be usable.
    const [status] = await boom.handleRequest("GET", "/state", "");
    expect(status).toBe(200);
  });
});
