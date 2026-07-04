import type { Instruction } from "@solana/kit";
import { findMarketPda } from "@fpm/shared";
import { log } from "../log.ts";
import { readMarketState, type ActionContext } from "./context.ts";

/**
 * activate_market: Open -> Trading, fired at kickoff.
 *
 * Idempotent: no-ops if the market is already past Open.
 */
export async function activateMarket(
  ctx: ActionContext,
  fixtureId: bigint,
): Promise<string | null> {
  const [market] = await findMarketPda(fixtureId);
  const state = await readMarketState(ctx, market);
  if (state && state !== "Open") {
    log.info({ fixtureId: fixtureId.toString(), state }, "activate: already advanced, skipping");
    return null;
  }

  const instructions = buildActivateInstructions();
  return ctx.txSender.sendAndConfirm({
    instructions,
    writableAccounts: [market],
  });
}

/**
 * TODO(program-team IDL): build via getActivateMarketInstruction(...) from
 * `@fpm/idl` (accounts: market, marketConfig, globalConfig, keeper signer).
 * Returns [] until the instruction exists in the IDL so the pipeline typechecks.
 */
function buildActivateInstructions(): Instruction[] {
  return [];
}
