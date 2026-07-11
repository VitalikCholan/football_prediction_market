/**
 * 1X2 devnet smoke mode (`--smoke-1x2` / SMOKE_1X2=1): proves the keeper's
 * NEW 1X2 instruction wiring against the LIVE program without mutating anything
 * (SPEC §3.1 phase C2). Simulate-only; DRY_RUN is forced so nothing is sent.
 *
 *   1. connect to devnet RPC (RPC_URLS or public devnet);
 *   2. load the keeper keypair (~/.config/solana/id.json by default);
 *   3. fetch GlobalConfig — absent => graceful skip (exit 0);
 *   4. STRUCTURAL build of resolve_1x2 with a dummy proof + each hint, asserting
 *      the generated builder derives the expected accounts (keeper, global,
 *      market1x2, marketConfig, txlineProgram, dailyScoresMerkleRoots) — no send;
 *   5. if any Market1x2 exists: list them; SIMULATE activate_market_1x2 on an
 *      Open market past kickoff (or a negative-path activate through the error
 *      discriminator), same as the binary --smoke.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getBase58Decoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  getU16Encoder,
  type Address,
  type Base58EncodedBytes,
} from "@solana/kit";
import {
  MARKET1X2_DISCRIMINATOR,
  MarketState,
  fetchMaybeGlobalConfig,
  getActivateMarket1x2InstructionAsync,
  getMarket1x2Decoder,
  getResolve1x2InstructionAsync,
  type Market1x2,
} from "@fpm/idl";
import {
  AMM_PROGRAM_ID,
  DAILY_SCORES_ROOTS_SEED,
  TXLINE,
  findConfigPda,
  findMarket1x2Pda,
} from "@fpm/shared";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { marketStateName } from "./actions/context.ts";
import { Outcome1x2Hint } from "./actions/resolve1x2.ts";
import { discriminateTxError } from "./solana/errors.ts";
import { createClients } from "./solana/rpc.ts";
import { loadKeeperSigner } from "./solana/signer.ts";
import { KitTxSender } from "./solana/txSender.ts";

const DEFAULT_SMOKE_RPCS = "https://api.devnet.solana.com";

export async function runSmoke1x2(): Promise<void> {
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
    "smoke-1x2: connected (DRY_RUN forced — simulate only)",
  );

  // ---- 1. GlobalConfig ----
  const [configPda] = await findConfigPda();
  const gc = await fetchMaybeGlobalConfig(clients.rpc, configPda);
  if (!gc.exists) {
    log.warn({ configPda }, "smoke-1x2: config not initialized yet, run scripts/devnet-init.ts");
    return; // graceful pre-init success
  }
  log.info(
    { configPda, keeper: gc.data.keeper, keeperMatchesSigner: gc.data.keeper === signer.address },
    "smoke-1x2: GlobalConfig fetched",
  );

  // ---- 2. STRUCTURAL resolve_1x2 build (no send) — proves account derivation ----
  await proveResolve1x2Accounts(config.cluster);

  // ---- 3. Market1x2 accounts (if any) + activate_market_1x2 simulation ----
  const markets = await listMarkets1x2(clients.rpc);
  if (markets.length === 0) {
    log.info("smoke-1x2: no Market1x2 accounts found (seed one via scripts/seed-markets-1x2.ts)");
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
        q: data.q.map((x) => x.toString()),
        pastKickoff: nowSec >= data.kickoffTs,
      },
      "smoke-1x2: market1x2",
    );
  }

  const txSender = new KitTxSender(clients, signer, config);
  const candidate = markets.find(
    (m) => m.data.state === MarketState.Open && nowSec >= m.data.kickoffTs,
  );
  const probe = candidate ?? markets[0];
  const ix = await getActivateMarket1x2InstructionAsync({
    keeper: signer,
    market: probe.address,
  });
  const sim = await txSender.simulate({
    instructions: [ix],
    writableAccounts: [probe.address],
  });
  if (candidate) {
    log.info(
      {
        market: probe.address,
        fixtureId: probe.data.fixtureId.toString(),
        ok: sim.ok,
        unitsConsumed: sim.unitsConsumed?.toString(),
        err: sim.err,
      },
      sim.ok
        ? "smoke-1x2: activate_market_1x2 simulation SUCCEEDED (nothing sent)"
        : "smoke-1x2: activate_market_1x2 simulation failed (see err/logs)",
    );
    return;
  }
  const d = discriminateTxError(sim.err, sim.logs);
  log.info(
    {
      market: probe.address,
      state: marketStateName(probe.data.state),
      ok: sim.ok,
      discriminated: { ourError: d.ourError, txlineCode: d.txlineCode, unknownCode: d.unknownCode },
      logsTail: sim.logs?.slice(-4),
    },
    "smoke-1x2: negative-path activate_market_1x2 (expected our InvalidMarketState)",
  );
}

/**
 * Build a resolve_1x2 instruction for each hint with a DUMMY proof (never sent)
 * and assert the generated builder resolves the six expected accounts in order.
 * This is the structural gate: it proves the new ix builder + account derivation
 * (incl. the daily_scores_roots PDA under the TxLINE program) compile and wire
 * correctly without any live send.
 */
async function proveResolve1x2Accounts(cluster: "devnet" | "mainnet"): Promise<void> {
  const txlineProgram = TXLINE[cluster].txlineProgram;
  const fixtureId = 18_179_549n;
  const [market] = await findMarket1x2Pda(fixtureId);
  // A plausible epoch-day roots PDA (ts in ms -> epoch day).
  const epochDay = Number(1_700_000_000_000n / 86_400_000n);
  const [roots] = await getProgramDerivedAddress({
    programAddress: txlineProgram,
    seeds: [DAILY_SCORES_ROOTS_SEED, getU16Encoder().encode(epochDay)],
  });
  const dummyStat = {
    statToProve: { key: 1, value: 0, period: 100 },
    eventStatRoot: new Uint8Array(32),
    statProof: [],
  };
  const marketConfig = market; // structural only — not sent; any address type-checks

  const hints = [Outcome1x2Hint.Team1, Outcome1x2Hint.Draw, Outcome1x2Hint.Team2];
  for (const hint of hints) {
    const ix = await getResolve1x2InstructionAsync({
      keeper: {
        address: AMM_PROGRAM_ID as unknown as Address,
        signAndSendTransactions: async () => [],
      } as never,
      market,
      marketConfig,
      txlineProgram,
      dailyScoresMerkleRoots: roots,
      hint,
      ts: 1_700_000_000_000n,
      fixtureSummary: {
        fixtureId,
        updateStats: { updateCount: 1, minTimestamp: 0n, maxTimestamp: 0n },
        eventsSubTreeRoot: new Uint8Array(32),
      },
      fixtureProof: [],
      mainTreeProof: [],
      statA: dummyStat,
      statB: { ...dummyStat, statToProve: { key: 2, value: 0, period: 100 } },
      op: 1, // BinaryExpression.Subtract
    });
    const got = ix.accounts.map((a) => a.address);
    const expected = [market, /* global auto */ got[1], market, marketConfig, txlineProgram, roots];
    const ok =
      got.length === 6 &&
      got[2] === market &&
      got[3] === marketConfig &&
      got[4] === txlineProgram &&
      got[5] === roots;
    log.info(
      { hint: Object.keys(Outcome1x2Hint).find((k) => (Outcome1x2Hint as Record<string, number>)[k] === hint), accounts: got, ok },
      ok
        ? "smoke-1x2: resolve_1x2 account derivation OK (structural, not sent)"
        : "smoke-1x2: resolve_1x2 account derivation MISMATCH",
    );
    if (!ok) throw new Error(`resolve_1x2 account derivation mismatch for hint ${hint}: ${JSON.stringify(expected)}`);
  }
}

interface FoundMarket1x2 {
  address: Address;
  data: Market1x2;
}

async function listMarkets1x2(
  rpc: ReturnType<typeof createClients>["rpc"],
): Promise<FoundMarket1x2[]> {
  const base64 = getBase64Encoder();
  const decoder = getMarket1x2Decoder();

  const fixtureEnv = process.env.SMOKE_1X2_FIXTURE_ID;
  if (fixtureEnv) {
    const out: FoundMarket1x2[] = [];
    for (const raw of fixtureEnv.split(",")) {
      const fixtureId = BigInt(raw.trim());
      const [market] = await findMarket1x2Pda(fixtureId);
      const { value } = await rpc.getAccountInfo(market, { encoding: "base64" }).send();
      if (!value) {
        log.warn({ fixtureId: fixtureId.toString(), market }, "smoke-1x2: no market1x2 for fixture");
        continue;
      }
      out.push({ address: market, data: decoder.decode(base64.encode(value.data[0])) });
    }
    return out;
  }

  const discriminator = getBase58Decoder().decode(
    MARKET1X2_DISCRIMINATOR,
  ) as Base58EncodedBytes;
  const accounts = await rpc
    .getProgramAccounts(AMM_PROGRAM_ID, {
      encoding: "base64",
      filters: [{ memcmp: { offset: 0n, bytes: discriminator, encoding: "base58" } }],
    })
    .send();
  return accounts.map((a) => ({
    address: a.pubkey,
    data: decoder.decode(base64.encode(a.account.data[0])),
  }));
}
