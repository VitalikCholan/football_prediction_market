import type { Instruction } from "@solana/kit";
import { findMarketPda } from "@fpm/shared";
import { log } from "../log.ts";
import { readMarketState, type ActionContext } from "./context.ts";

/**
 * freeze_market: Trading -> Locked, fired at the final whistle.
 *
 * Idempotent: no-ops if the market is already Locked/Resolved/Closed.
 */
export async function freezeMarket(
  ctx: ActionContext,
  fixtureId: bigint,
): Promise<string | null> {
  const [market] = await findMarketPda(fixtureId);
  const state = await readMarketState(ctx, market);
  if (state && state !== "Open" && state !== "Trading") {
    log.info({ fixtureId: fixtureId.toString(), state }, "freeze: already advanced, skipping");
    return null;
  }

  const instructions = buildFreezeInstructions();
  return ctx.txSender.sendAndConfirm({
    instructions,
    writableAccounts: [market],
  });
}

/**
 * TODO(program-team IDL): build via getFreezeMarketInstruction(...) from
 * `@fpm/idl`. Returns [] until the instruction exists so the pipeline typechecks.
 */
function buildFreezeInstructions(): Instruction[] {
  return [];
}
