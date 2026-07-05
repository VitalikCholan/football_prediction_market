/**
 * Error discrimination for simulation / transaction failures (backend-plan
 * §2.8). A failed `resolve` can carry a custom code from EITHER program:
 *
 *   - OUR amm program (e.g. 6017 ProofRejected, 6012 InvalidMarketState) —
 *     typed via the generated `@fpm/idl` error constants, or
 *   - the TxLINE oracle reached via CPI (e.g. 6007 RootNotAvailable) — read
 *     from the program logs, since both programs use overlapping Anchor
 *     6000-based code spaces (TxLINE 6007 collides with our 6007
 *     SolvencyViolation, TxLINE 6021/6023 collide with ours too).
 *
 * Attribution therefore MUST come from the logs (which program logged the
 * failure), never from the bare numeric code. The extraction pattern mirrors
 * tests/surfpool/run.ts (proven against the real TxLINE binary).
 */
import {
  AMM_ERROR__FREEZE_NOT_REACHED,
  AMM_ERROR__GRACE_NOT_ELAPSED,
  AMM_ERROR__KICKOFF_NOT_REACHED,
  getAmmErrorMessage,
  type AmmError,
} from "@fpm/idl";
import { AMM_PROGRAM_ID, TXLINE } from "@fpm/shared";
import { TxSimulationError } from "./txSender.ts";

/** TxLINE proof-error codes surfaced through the resolve CPI. */
export const TXLINE_ERR = {
  /** TRANSIENT: the epoch-day root isn't posted yet (5-min batches) -> retry. */
  RootNotAvailable: 6007,
  /** Terminal for this proof: predicate evaluated false on-oracle. */
  PredicateFailed: 6021,
  /** Terminal for this proof: inner stat Merkle proof invalid. */
  InvalidStatProof: 6023,
  /** Terminal for this proof: main-tree Merkle proof invalid. */
  InvalidMainTreeProof: 6004,
  /** Terminal for this proof: proof exceeds size limits. */
  ProofTooLarge: 6062,
} as const;

const TXLINE_TERMINAL_CODES: ReadonlySet<number> = new Set([
  TXLINE_ERR.PredicateFailed,
  TXLINE_ERR.InvalidStatProof,
  TXLINE_ERR.InvalidMainTreeProof,
  TXLINE_ERR.ProofTooLarge,
]);

/** Our program's codes that just mean "too early" — safe to retry later. */
const AMM_RETRYABLE_CODES: ReadonlySet<number> = new Set([
  AMM_ERROR__KICKOFF_NOT_REACHED,
  AMM_ERROR__FREEZE_NOT_REACHED,
  AMM_ERROR__GRACE_NOT_ELAPSED,
]);

export interface DiscriminatedTxError {
  /** Set when the failing custom code was attributed to OUR amm program. */
  ourError?: { code: number; message: string };
  /** Set when the failing custom code came from the TxLINE oracle program. */
  txlineCode?: number;
  /** Custom code we could not attribute to a program (no logs). */
  unknownCode?: number;
  /** True when retrying the same action later can plausibly succeed. */
  retryable: boolean;
  /** Program logs the attribution came from (when available). */
  logs?: readonly string[];
  raw: unknown;
}

/** Name of a TxLINE error code from our known table (falls back to the code). */
export function txlineErrorName(code: number): string {
  return (
    Object.entries(TXLINE_ERR).find(([, v]) => v === code)?.[0] ??
    `TxlineError(${code})`
  );
}

/** True for TxLINE codes that permanently reject THIS proof payload. */
export function isTerminalTxlineCode(code: number | undefined): boolean {
  return code !== undefined && TXLINE_TERMINAL_CODES.has(code);
}

/**
 * Parse a simulation/tx error into { ourError?, txlineCode?, retryable }.
 *
 * Order of attribution:
 *  1. logs (TxSimulationError carries them; explicit `logs` param wins) —
 *     innermost `Program X failed: custom program error: 0x…` line, falling
 *     back to an Anchor `Error Number:` log attributed via the invoke stack;
 *  2. bare custom code from the RPC error object (unattributable -> treated as
 *     ours only if nothing suggests the CPI was reached);
 *  3. transport-level heuristics (blockhash, timeouts, 429s) -> retryable.
 */
export function discriminateTxError(
  err: unknown,
  logs?: readonly string[],
): DiscriminatedTxError {
  const effectiveLogs =
    logs ?? (err instanceof TxSimulationError ? err.logs : undefined);
  const rawErr = err instanceof TxSimulationError ? err.simErr : err;

  const attributed = effectiveLogs
    ? attributeFromLogs(effectiveLogs)
    : undefined;

  if (attributed) {
    return classify(attributed.program, attributed.code, effectiveLogs, err);
  }

  const bareCode = extractCustomErrorCode(rawErr);
  if (bareCode !== undefined) {
    // No logs to attribute with — report as unknown; callers must treat
    // ambiguous codes conservatively (terminal unless proven transient).
    return { unknownCode: bareCode, retryable: false, logs: effectiveLogs, raw: err };
  }

  return {
    retryable: isTransientTransportError(err),
    logs: effectiveLogs,
    raw: err,
  };
}

function classify(
  program: string | undefined,
  code: number,
  logs: readonly string[] | undefined,
  raw: unknown,
): DiscriminatedTxError {
  const txlinePrograms: string[] = [
    TXLINE.devnet.txlineProgram,
    TXLINE.mainnet.txlineProgram,
  ];
  if (program === (AMM_PROGRAM_ID as string)) {
    return {
      ourError: { code, message: ammErrorMessage(code) },
      retryable: AMM_RETRYABLE_CODES.has(code),
      logs,
      raw,
    };
  }
  if (program !== undefined && txlinePrograms.includes(program)) {
    return {
      txlineCode: code,
      retryable: code === TXLINE_ERR.RootNotAvailable,
      logs,
      raw,
    };
  }
  return { unknownCode: code, retryable: false, logs, raw };
}

function ammErrorMessage(code: number): string {
  const msg = getAmmErrorMessage(code as AmmError) as string | undefined;
  return msg ?? `AmmError(${code})`;
}

/**
 * Walk the logs and find the failing program + custom code.
 *
 * Two patterns (both observed in tests/surfpool/run.ts against the real
 * binaries):
 *   - `Program <id> failed: custom program error: 0x1781` — the FIRST such
 *     line is the innermost failure (CPI failures propagate outward, so the
 *     outer amm line comes after the inner TxLINE one);
 *   - Anchor's `Program log: AnchorError … Error Number: 6007. …` — attributed
 *     to whichever program is on top of the invoke stack at that point.
 */
function attributeFromLogs(
  logs: readonly string[],
): { program?: string; code: number } | undefined {
  for (const line of logs) {
    const m = /^Program (\S+) failed: custom program error: 0x([0-9a-fA-F]+)$/.exec(
      line,
    );
    if (m) return { program: m[1], code: parseInt(m[2], 16) };
  }

  const stack: string[] = [];
  for (const line of logs) {
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    const done = /^Program (\S+) (?:success|failed)/.exec(line);
    if (done) {
      if (stack[stack.length - 1] === done[1]) stack.pop();
      continue;
    }
    const anchorErr = /Error Number: (\d+)/.exec(line);
    if (anchorErr) {
      return { program: stack[stack.length - 1], code: Number(anchorErr[1]) };
    }
  }
  return undefined;
}

/** Extract a bare custom-program error code from an RPC error object. */
export function extractCustomErrorCode(err: unknown): number | undefined {
  // Typed shape: { InstructionError: [idx, { Custom: n }] }
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
  // Fallback: regex over the stringified error (covers Kit SolanaError shapes).
  const s = stringifySafe(err);
  const m =
    s.match(/"Custom"\s*:\s*(\d+)/) ??
    s.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (!m) return undefined;
  return m[0].includes("0x") ? parseInt(m[1], 16) : Number(m[1]);
}

function isTransientTransportError(err: unknown): boolean {
  const s =
    err instanceof Error ? `${err.message} ${stringifySafe(err)}` : stringifySafe(err);
  return /blockhash|node is behind|too many requests|429|rate.?limit|fetch failed|timed? ?out|ECONN|ETIMEDOUT|socket|network/i.test(
    s,
  );
}

function stringifySafe(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x: unknown) =>
      typeof x === "bigint" ? Number(x) : x,
    ) ?? "";
  } catch {
    return String(v);
  }
}
