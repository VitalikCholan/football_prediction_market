import { getFreezeMarketInstructionAsync, MarketState } from "@fpm/idl";
import { findMarketPda } from "@fpm/shared";
import { log } from "../log.ts";
import { marketStateName, readMarket, type ActionContext } from "./context.ts";

/**
 * freeze_market: Trading -> Locked, fired at the final whistle.
 *
 * Accounts: keeper signer, global config PDA (auto-derived by the generated
 * builder), market PDA (derived from fixtureId). Idempotent: no-ops if the
 * market is already Locked/Resolved/Closed.
 */
export async function freezeMarket(
  ctx: ActionContext,
  fixtureId: bigint,
): Promise<string | null> {
  const [market] = await findMarketPda(fixtureId);
  const state = (await readMarket(ctx, market))?.state;
  if (state === undefined) {
    log.warn(
      { fixtureId: fixtureId.toString(), market },
      "freeze: market account not found, skipping",
    );
    return null;
  }
  if (state !== MarketState.Open && state !== MarketState.Trading) {
    log.info(
      { fixtureId: fixtureId.toString(), state: marketStateName(state) },
      "freeze: already advanced, skipping",
    );
    return null;
  }

  const ix = await getFreezeMarketInstructionAsync({
    keeper: ctx.signer,
    market,
  });
  return ctx.txSender.sendAndConfirm({
    instructions: [ix],
    writableAccounts: [market],
  });
}
