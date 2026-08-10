/** Request shapes the keeper API accepts. Types only — the Sui signing
 * helpers that built them went with the DeepBook Predict layer. */

export type KeeperIntentRequest = {
  address: string;
  expires_at_ms: number;
  message_bytes: string;
  signature?: string;
  token?: string;
};

export type KeeperManagerCreateRequest = KeeperIntentRequest;
