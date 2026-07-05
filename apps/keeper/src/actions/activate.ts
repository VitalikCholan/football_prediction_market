import { getActivateMarketInstructionAsync, MarketState } from "@fpm/idl";
import { findMarketPda } from "@fpm/shared";
import { log } from "../log.ts";
import { marketStateName, readMarket, type ActionContext } from "./context.ts";

/**
 * activate_market: Open -> Trading, fired at kickoff.
 *
 * Accounts: keeper signer, global config PDA (auto-derived by the generated
 * builder), market PDA (derived from fixtureId). Idempotent: no-ops if the
 * market is already past Open.
 */
export async function activateMarket(
  ctx: ActionContext,
  fixtureId: bigint,
): Promise<string | null> {
  const [market] = await findMarketPda(fixtureId);
  const state = (await readMarket(ctx, market))?.state;
  if (state === undefined) {
    log.warn(
      { fixtureId: fixtureId.toString(), market },
      "activate: market account not found, skipping",
    );
    return null;
  }
  if (state !== MarketState.Open) {
    log.info(
      { fixtureId: fixtureId.toString(), state: marketStateName(state) },
      "activate: already advanced, skipping",
    );
    return null;
  }

  const ix = await getActivateMarketInstructionAsync({
    keeper: ctx.signer,
    market,
  });
  return ctx.txSender.sendAndConfirm({
    instructions: [ix],
    writableAccounts: [market],
  });
}
