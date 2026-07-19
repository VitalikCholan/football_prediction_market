/**
 * User-facing decoding of on-chain program errors (PLAN.md §12 BUG-5).
 *
 * A failed instruction surfaces as `{"InstructionError":[idx,{"Custom":code}]}`
 * (or a hex `custom program error: 0x…` in logs). The raw JSON must never reach
 * the UI. This maps `(program, code)` to a friendly sentence.
 *
 * Attribution note: the AMM and TxLINE programs BOTH use Anchor's 6000-based
 * code space, so some numbers collide across programs (e.g. AMM 6007
 * SolvencyViolation vs TxLINE 6007 RootNotAvailable). A bare code is therefore
 * ambiguous — callers that KNOW which program they invoked should pass the
 * `program` hint. The keeper does finer log-based attribution
 * (`apps/keeper/src/solana/errors.ts`); this module is the lightweight
 * UI-facing counterpart.
 */

/** Which program a failing instruction targeted (caller-supplied context). */
export type ErrorProgram = "amm" | "txline";

/** Curated, user-facing messages for the codes a trader can actually hit. */
const AMM_MESSAGES: Readonly<Record<number, string>> = {
  6004: "Enter an amount greater than zero.",
  6005: "Trade is too large for the current liquidity.",
  6006: "The price moved — increase slippage tolerance and try again.",
  6012: "This market isn't open for trading yet.",
  6015: "You don't have enough of this position to sell.",
  6016: "You're not authorized to do that.",
  6017: "The match result proof was rejected.",
  6018: "This position has already been redeemed.",
  6024: "The settlement grace period hasn't elapsed yet.",
  // Leverage layer (leverage-v1 §4) — codes 6031..6047.
  6031: "Leverage isn't enabled for this market.",
  6032: "That leverage is above the cap at the current price — lower it.",
  6033: "Leverage must be at least 2×.",
  6034: "No mark price has been posted yet — try again shortly.",
  6035: "The mark price is stale — wait for the next keeper update.",
  6036: "Mark price is out of range.",
  6037: "Leveraged opens are temporarily paused (risk valve).",
  6038: "Risk valve parameters are out of bounds.",
  6039: "Too close to match freeze to open a leveraged position.",
  6040: "The pool's open-interest cap is full — try a smaller size.",
  6041: "The pool can't cover this position right now — try a smaller size.",
  6042: "This leveraged position is already settled.",
  6043: "This position hasn't expired — funding hasn't consumed the collateral yet.",
  6044: "Withdrawal is still locked — wait for the unlock time.",
  6045: "No pending withdrawal to claim.",
  6046: "Not enough free LP shares.",
  6047: "Funding math error — please try again.",
};

const TXLINE_MESSAGES: Readonly<Record<number, string>> = {
  6058: "Faucet rate-limited — you already have test USDT.",
  6063: "That trade is below the minimum size.",
};

/**
 * Pull a custom-program error code out of an arbitrary send/simulate error
 * (typed `InstructionError` shape first, then a regex over the stringified
 * error to catch Kit `SolanaError` / hex-log shapes).
 */
export function extractCustomCode(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const ie = (err as { InstructionError?: unknown }).InstructionError;
    if (Array.isArray(ie) && ie.length === 2) {
      const detail = ie[1] as { Custom?: number | bigint } | string;
      if (
        detail &&
        typeof detail === "object" &&
        (typeof detail.Custom === "number" || typeof detail.Custom === "bigint")
      ) {
        return Number(detail.Custom);
      }
    }
  }
  const s = safeStringify(err);
  const dec = s.match(/"Custom"\s*:\s*(\d+)/);
  if (dec) return Number(dec[1]);
  const hex = s.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (hex) return parseInt(hex[1], 16);
  return undefined;
}

/**
 * Turn any tx/simulation error into a single human sentence. Pass `program`
 * when the caller knows which program it invoked (resolves 6000-space
 * collisions). Falls back to a generic message that still hides the raw JSON.
 */
export function friendlyTxError(err: unknown, program?: ErrorProgram): string {
  const code = extractCustomCode(err);
  if (code !== undefined) {
    const table =
      program === "txline"
        ? TXLINE_MESSAGES
        : program === "amm"
          ? AMM_MESSAGES
          : { ...AMM_MESSAGES, ...TXLINE_MESSAGES }; // no hint: best-effort
    const msg = table[code];
    if (msg) return msg;
    return `Transaction failed (error ${code}). Please try again.`;
  }
  if (isTransient(err)) {
    return "Network hiccup — please try again.";
  }
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong. Please try again.";
}

function isTransient(err: unknown): boolean {
  const s = err instanceof Error ? err.message : safeStringify(err);
  return /blockhash|node is behind|too many requests|429|rate.?limit|fetch failed|timed? ?out|ECONN|ETIMEDOUT|socket|network/i.test(
    s,
  );
}

function safeStringify(v: unknown): string {
  try {
    return (
      JSON.stringify(v, (_k, x: unknown) =>
        typeof x === "bigint" ? Number(x) : x,
      ) ?? ""
    );
  } catch {
    return String(v);
  }
}
