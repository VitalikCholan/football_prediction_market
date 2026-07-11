/**
 * Devnet smoke mode (`--smoke` / SMOKE=1): proves the keeper's instruction
 * wiring against the LIVE program without mutating anything.
 *
 *   1. connect to devnet RPC (Helius primary, public devnet fallback);
 *   2. load the keeper keypair (~/.config/solana/id.json by default);
 *   3. fetch GlobalConfig — absent => "config not initialized yet" + exit 0;
 *   4. list Market accounts (getProgramAccounts by discriminator, or
 *      SMOKE_FIXTURE_ID for a single known market);
 *   5. for a market in Open state past kickoff, SIMULATE activate_market
 *      (DRY_RUN forced — nothing is ever sent) and print the result.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getBase58Decoder,
  getBase64Encoder,
  type Address,
  type Base58EncodedBytes,
} from "@solana/kit";
import {
  MARKET_DISCRIMINATOR,
  MarketState,
  fetchMaybeGlobalConfig,
  getActivateMarketInstructionAsync,
  getMarketDecoder,
  type Market,
} from "@fpm/idl";
import { AMM_PROGRAM_ID, findConfigPda, findMarketPda } from "@fpm/shared";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { marketStateName } from "./actions/context.ts";
import { discriminateTxError } from "./solana/errors.ts";
import { createClients } from "./solana/rpc.ts";
import { loadKeeperSigner } from "./solana/signer.ts";
import { KitTxSender } from "./solana/txSender.ts";

/** Public devnet by default; pass a dedicated RPC via RPC_URLS (see .env.example). */
const DEFAULT_SMOKE_RPCS = "https://api.devnet.solana.com";

export async function runSmoke(): Promise<void> {
  // Smoke defaults: devnet RPCs, DRY_RUN forced, Solana CLI default keypair.
  if (!process.env.RPC_URLS) process.env.RPC_URLS = DEFAULT_SMOKE_RPCS;
  process.env.DRY_RUN = "1"; // never send in smoke mode
  if (!process.env.KEEPER_KEYPAIR && !process.env.KEEPER_KEYPAIR_PATH) {
    process.env.KEEPER_KEYPAIR_PATH = join(homedir(), ".config", "solana", "id.json");
  }

  const config = loadConfig();
  const clients = createClients(config);
  const signer = await loadKeeperSigner(config);
  log.info(
    { rpc: config.rpcUrls[0], cluster: config.cluster, keeper: signer.address },
    "smoke: connected (DRY_RUN forced — simulate only)",
  );

  // ---- 1. GlobalConfig ----
  const [configPda] = await findConfigPda();
  const gc = await fetchMaybeGlobalConfig(clients.rpc, configPda);
  if (!gc.exists) {
    log.warn(
      { configPda },
      "smoke: config not initialized yet, run scripts/devnet-init.ts",
    );
    return; // exit 0 — graceful path counts as success pre-init
  }
  log.info(
    {
      configPda,
      authority: gc.data.authority,
      keeper: gc.data.keeper,
      txlineProgram: gc.data.txlineProgram,
      usdtMint: gc.data.usdtMint,
      keeperMatchesSigner: gc.data.keeper === signer.address,
    },
    "smoke: GlobalConfig fetched",
  );

  // ---- 2. Markets ----
  const markets = await listMarkets(clients.rpc);
  if (markets.length === 0) {
    log.info("smoke: no Market accounts found (create one via scripts/devnet-init.ts)");
    return;
  }
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  for (const { address: addr, data } of markets) {
    log.info(
      {
        market: addr,
        fixtureId: data.fixtureId.toString(),
        state: marketStateName(data.state),
        kickoffTs: data.kickoffTs.toString(),
        freezeTs: data.freezeTs.toString(),
        pastKickoff: nowSec >= data.kickoffTs,
      },
      "smoke: market",
    );
  }

  // ---- 3. Simulate activate on an Open market past kickoff ----
  const txSender = new KitTxSender(clients, signer, config);
  const candidate = markets.find(
    (m) => m.data.state === MarketState.Open && nowSec >= m.data.kickoffTs,
  );
  if (candidate) {
    const ix = await getActivateMarketInstructionAsync({
      keeper: signer,
      market: candidate.address,
    });
    const sim = await txSender.simulate({
      instructions: [ix],
      writableAccounts: [candidate.address],
    });
    log.info(
      {
        market: candidate.address,
        fixtureId: candidate.data.fixtureId.toString(),
        ok: sim.ok,
        unitsConsumed: sim.unitsConsumed?.toString(),
        err: sim.err,
        logs: sim.logs,
      },
      sim.ok
        ? "smoke: activate_market simulation SUCCEEDED (nothing sent)"
        : "smoke: activate_market simulation failed (see err/logs)",
    );
    return;
  }

  // Negative path: no Open market — simulate activate on the first market
  // anyway and run the result through the error discriminator. An
  // already-advanced market must come back as OUR InvalidMarketState (6012),
  // proving instruction wiring + log attribution against the live program.
  const probe = markets[0];
  log.info(
    { market: probe.address, state: marketStateName(probe.data.state) },
    "smoke: no Open market past kickoff — negative-path simulation instead",
  );
  const ix = await getActivateMarketInstructionAsync({
    keeper: signer,
    market: probe.address,
  });
  const sim = await txSender.simulate({
    instructions: [ix],
    writableAccounts: [probe.address],
  });
  const d = discriminateTxError(sim.err, sim.logs);
  log.info(
    {
      market: probe.address,
      ok: sim.ok,
      err: sim.err,
      discriminated: {
        ourError: d.ourError,
        txlineCode: d.txlineCode,
        unknownCode: d.unknownCode,
        retryable: d.retryable,
      },
      logsTail: sim.logs?.slice(-4),
    },
    "smoke: negative-path activate simulation (expected our InvalidMarketState)",
  );
}

interface FoundMarket {
  address: Address;
  data: Market;
}

/**
 * List Market accounts. SMOKE_FIXTURE_ID (comma-separable) narrows to known
 * fixtures; otherwise getProgramAccounts with a memcmp on the 8-byte Codama
 * discriminator (same pattern as the indexer plan §3).
 */
async function listMarkets(
  rpc: ReturnType<typeof createClients>["rpc"],
): Promise<FoundMarket[]> {
  const base64 = getBase64Encoder();
  const decoder = getMarketDecoder();

  const fixtureEnv = process.env.SMOKE_FIXTURE_ID;
  if (fixtureEnv) {
    const out: FoundMarket[] = [];
    for (const raw of fixtureEnv.split(",")) {
      const fixtureId = BigInt(raw.trim());
      const [market] = await findMarketPda(fixtureId);
      const { value } = await rpc
        .getAccountInfo(market, { encoding: "base64" })
        .send();
      if (!value) {
        log.warn({ fixtureId: fixtureId.toString(), market }, "smoke: no market for fixture");
        continue;
      }
      out.push({ address: market, data: decoder.decode(base64.encode(value.data[0])) });
    }
    return out;
  }

  const discriminator = getBase58Decoder().decode(
    MARKET_DISCRIMINATOR,
  ) as Base58EncodedBytes;
  const accounts = await rpc
    .getProgramAccounts(AMM_PROGRAM_ID, {
      encoding: "base64",
      filters: [
        { memcmp: { offset: 0n, bytes: discriminator, encoding: "base58" } },
      ],
    })
    .send();
  return accounts.map((a) => ({
    address: a.pubkey,
    data: decoder.decode(base64.encode(a.account.data[0])),
  }));
}
