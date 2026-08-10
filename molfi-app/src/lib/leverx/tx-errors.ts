/**
 * User-facing wording for a failed transaction.
 *
 * Everything Sui-specific is gone with the DeepBook Predict layer — the gas
 * helpers, the Move abort table and the relay branches all keyed on errors this
 * app cannot produce. What is left is the EVM mapping that actually fires on
 * Flare.
 */

/**
 * Turn a viem/EVM failure into one sentence a bettor can act on.
 *
 * Everything below this file's Sui branches used to `return raw`, and on Flare
 * NONE of those branches match — so a reverted bet rendered the whole viem
 * dump in a toast: the ABI signature, all six Groth16 limbs, the contract
 * address, a docs link and "Version: viem@2.54.1". This runs first for EVM
 * errors and only falls through when there is genuinely nothing to say.
 */
function describeEvmError(raw: string): string | null {
  // User-initiated, and not a failure worth alarming anyone about.
  if (/User rejected|User denied|ACTION_REJECTED|rejected the request/i.test(raw)) {
    return "You cancelled the transaction in your wallet.";
  }
  if (/insufficient funds for gas|insufficient funds for intrinsic/i.test(raw)) {
    return "Not enough C2FLR to pay gas. Top up from the Coston2 faucet and try again.";
  }
  // ERC-20 shortfalls, whether the custom error or the classic string.
  if (/ERC20InsufficientBalance|transfer amount exceeds balance/i.test(raw)) {
    return "You don't have enough FXRP for this bet.";
  }
  if (/ERC20InsufficientAllowance|insufficient allowance/i.test(raw)) {
    return "FXRP spending approval is missing or too low — approve the escrow and try again.";
  }
  if (/nonce too low|already known|replacement transaction underpriced/i.test(raw)) {
    return "A previous transaction is still confirming. Wait for it to land, then try again.";
  }
  if (/\bMarketClosed\b|market is closed|MarketNotOpen/i.test(raw)) {
    return "This market has already closed.";
  }
  if (/\bNotResolved\b|not resolved/i.test(raw)) {
    return "This market hasn't settled yet.";
  }
  if (/NullifierUsed|already claimed/i.test(raw)) {
    return "That note has already been claimed.";
  }
  if (/InvalidProof|proof/i.test(raw) && /revert/i.test(raw)) {
    return "The zero-knowledge proof was rejected on-chain.";
  }
  if (/timed out|timeout|ETIMEDOUT/i.test(raw)) {
    return "Coston2 didn't respond in time. Your transaction may still land — check your wallet before retrying.";
  }
  if (/fetch failed|Failed to fetch|NetworkError|ECONNREFUSED/i.test(raw)) {
    return "Couldn't reach Coston2. Check your connection and try again.";
  }
  // A revert we have no specific copy for. Keep viem's own one-line summary if
  // it has one, and drop the argument dump that follows it.
  if (/reverted|execution reverted|CallExecutionError|ContractFunctionExecutionError/i.test(raw)) {
    const reason = raw.match(/reverted with the following reason:\s*\n?(.+)/)?.[1]?.trim();
    if (reason && !/unknown reason/i.test(reason)) {
      return `The transaction was rejected on-chain: ${reason}`;
    }
    return "The transaction was rejected on-chain. Nothing was charged beyond gas.";
  }
  return null;
}

export function formatTxError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Transaction failed.";

  const evm = describeEvmError(raw);
  if (evm) {
    // The full error still reaches the console for debugging; only the toast
    // is trimmed.
    if (import.meta.env.DEV) console.debug("[tx-error]", raw);
    return evm;
  }

  // Nothing matched. Return the first line rather than a multi-paragraph dump —
  // viem puts its summary there and the rest is machine detail.
  if (import.meta.env.DEV) console.debug("[tx-error unmapped]", raw);
  return raw.split("\n")[0].trim() || "The transaction failed.";
}
