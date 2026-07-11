import { Injectable, Logger } from '@nestjs/common';
import { address, type Signature } from '@solana/kit';
import {
  fetchAllMaybeMarket,
  fetchAllMaybeMarket1x2,
  fetchAllMaybeMarketConfig,
  MarketState as OnchainMarketState,
  Outcome as OnchainOutcome,
  Outcome1x2 as OnchainOutcome1x2,
} from '@fpm/idl';
import { prices1x2Bps } from '../chain/lmsr-price';
import { PrismaService } from '../db/prisma.service';
import { LogParser } from './log-parser';
import { EventPersister } from './persister.service';
import { RpcService } from './rpc.service';

/** On-chain `Outcome1x2` enum -> DB `outcome_1x2` string (null = unresolved). */
function onchainOutcome1x2Label(o: OnchainOutcome1x2): string | null {
  switch (o) {
    case OnchainOutcome1x2.Team1:
      return 'Team1';
    case OnchainOutcome1x2.Draw:
      return 'Draw';
    case OnchainOutcome1x2.Team2:
      return 'Team2';
    case OnchainOutcome1x2.Void:
      return 'Void';
    default:
      return null; // Unset
  }
}

interface SignatureInfo {
  signature: string;
  slot: bigint;
  blockTime: number | null;
  err: unknown;
}

/**
 * Chain -> DB replay (backend-plan §3.2).
 *
 * `run()` (boot): walk getSignaturesForAddress(AMM_PROGRAM_ID) back to the
 * persisted cursor (or the full program history on first run), replay each tx
 * via getTransaction, decode Anchor events from the logs, persist idempotently,
 * then refresh every known Market/MarketConfig account via the Codama decoders
 * for authoritative state (reserves, supplies, state, outcome, timestamps).
 *
 * `tailOnce()` (called by TailService on an interval): the same
 * signature walk bounded to "newer than the cursor" — this is the poll-based
 * live tail.
 *
 * All RPC calls go through `RpcService.withRetry` (exponential backoff +
 * endpoint rotation) because public devnet is rate-limited.
 */
@Injectable()
export class BackfillService {
  private readonly logger = new Logger(BackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly parser: LogParser,
    private readonly persister: EventPersister,
    private readonly rpc: RpcService,
  ) {}

  // ---- cursor ---------------------------------------------------------------

  async getCursor(): Promise<{
    lastIndexedSignature: string | null;
    lastIndexedSlot: bigint | null;
  }> {
    const row = await this.prisma.indexerCursor.findUnique({
      where: { id: true },
    });
    return {
      lastIndexedSignature: row?.lastIndexedSignature ?? null,
      lastIndexedSlot: row?.lastIndexedSlot ?? null,
    };
  }

  async setCursor(signature: string, slot: bigint): Promise<void> {
    await this.prisma.indexerCursor.upsert({
      where: { id: true },
      create: {
        id: true,
        lastIndexedSignature: signature,
        lastIndexedSlot: slot,
      },
      update: { lastIndexedSignature: signature, lastIndexedSlot: slot },
    });
  }

  // ---- replay ---------------------------------------------------------------

  /** Boot-time catch-up: full replay to cursor + account refresh. */
  async run(): Promise<void> {
    if (!this.rpc.enabled) {
      this.logger.warn('INDEXER_ENABLED off — skipping backfill');
      return;
    }
    const replayed = await this.tailOnce();
    this.logger.log(`Backfill replayed ${replayed} transaction(s)`);
    await this.refreshMarkets();
    // Backfill team names for any pre-existing rows still missing them.
    await this.persister.enrichMissingTeams();
  }

  /**
   * One tail iteration: fetch all signatures newer than the cursor (paginated,
   * oldest-first replay), decode + persist, advance the cursor. Returns the
   * number of transactions processed. Re-entrancy-safe: the boot backfill and
   * the interval tail share one in-flight run (persistence is idempotent, but
   * two concurrent replays of the same tx would race the unique index).
   */
  async tailOnce(): Promise<number> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.tailOnceInner().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private inFlight?: Promise<number>;

  private async tailOnceInner(): Promise<number> {
    const { lastIndexedSignature } = await this.getCursor();
    const signatures = await this.fetchSignaturesSince(lastIndexedSignature);
    if (signatures.length === 0) return 0;

    let processed = 0;
    // Oldest first so the cursor advances monotonically.
    for (const sig of [...signatures].reverse()) {
      if (!sig.err) {
        const events = await this.replayTransaction(sig);
        if (events > 0) {
          this.logger.log(
            `indexed ${events} event(s) from ${sig.signature.slice(0, 16)}… (slot ${sig.slot})`,
          );
        }
      }
      await this.setCursor(sig.signature, sig.slot);
      processed += 1;
    }
    return processed;
  }

  /** All signatures newer than `until` (newest-first), paginated past 1000. */
  private async fetchSignaturesSince(
    until: string | null,
  ): Promise<SignatureInfo[]> {
    const all: SignatureInfo[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.rpc.withRetry((rpc) =>
        rpc
          .getSignaturesForAddress(this.rpc.programId, {
            ...(before ? { before: before as Signature } : {}),
            ...(until ? { until: until as Signature } : {}),
            limit: 1000,
          })
          .send(),
      );
      for (const s of page) {
        all.push({
          signature: s.signature,
          slot: BigInt(s.slot),
          blockTime: s.blockTime != null ? Number(s.blockTime) : null,
          err: s.err,
        });
      }
      if (page.length < 1000) return all;
      before = page[page.length - 1].signature;
    }
  }

  /** Fetch one tx, decode its logs, persist. Returns the event count. */
  private async replayTransaction(sig: SignatureInfo): Promise<number> {
    const tx = await this.rpc.withRetry((rpc) =>
      rpc
        .getTransaction(sig.signature as Signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
          encoding: 'json',
        })
        .send(),
    );
    if (!tx || tx.meta?.err) return 0;
    const logs = tx.meta?.logMessages ?? [];
    const events = this.parser.parse(
      logs,
      sig.signature,
      sig.slot,
      tx.blockTime != null ? Number(tx.blockTime) : sig.blockTime,
    );
    await this.persister.persist(events);
    return events.length;
  }

  // ---- authoritative account refresh -----------------------------------------

  /**
   * Fetch every known market account (and its MarketConfig) via the Codama
   * decoders and overwrite the denormalized snapshot — the account, not the
   * event stream, is the source of truth for reserves/supplies/state. Binary
   * (`marketKind = 0`) and 1X2 (`marketKind = 1`) rows use distinct account
   * decoders; both share the MarketConfig base-fee lookup.
   */
  async refreshMarkets(): Promise<void> {
    const rows = await this.prisma.market.findMany({
      select: { id: true, configId: true, marketKind: true },
    });
    if (rows.length === 0) return;

    const binaryRows = rows.filter((r) => r.marketKind !== 1);
    const oneX2Rows = rows.filter((r) => r.marketKind === 1);

    const slot = await this.rpc.withRetry((rpc) => rpc.getSlot().send());

    // Shared base-fee lookup: every market's MarketConfig, decoded once.
    const configIds = [...new Set(rows.map((r) => r.configId))];
    const configs = await this.rpc.withRetry((rpc) =>
      fetchAllMaybeMarketConfig(
        rpc,
        configIds.map((c) => address(c)),
      ),
    );
    const baseFeeByConfig = new Map<string, number>();
    for (const cfg of configs) {
      if (cfg.exists) {
        baseFeeByConfig.set(cfg.address.toString(), cfg.data.baseFeeBps);
      }
    }

    let refreshed = 0;
    refreshed += await this.refreshBinaryMarkets(
      binaryRows,
      baseFeeByConfig,
      BigInt(slot),
    );
    refreshed += await this.refreshMarkets1x2(
      oneX2Rows,
      baseFeeByConfig,
      BigInt(slot),
    );
    this.logger.log(
      `refreshed ${refreshed}/${rows.length} market account(s) from chain ` +
        `(${binaryRows.length} binary, ${oneX2Rows.length} 1X2)`,
    );

    // Best-effort live score + reference odds enrichment. Runs after the
    // authoritative state write so it sees fresh Trading/Resolved states. Never
    // throws (internally resilient); a flaky TxLINE feed must not break the poll.
    await this.persister.enrichScoreAndOdds();
  }

  /** Refresh binary Market accounts. Returns the count of existing accounts. */
  private async refreshBinaryMarkets(
    rows: { id: string }[],
    baseFeeByConfig: Map<string, number>,
    slot: bigint,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const accounts = await this.rpc.withRetry((rpc) =>
      fetchAllMaybeMarket(
        rpc,
        rows.map((r) => address(r.id)),
      ),
    );
    let count = 0;
    for (const account of accounts) {
      if (!account.exists) continue;
      count += 1;
      const m = account.data;
      await this.prisma.market.update({
        where: { id: account.address.toString() },
        data: {
          configId: m.config.toString(),
          state: OnchainMarketState[m.state] ?? 'Open',
          outcome:
            m.outcome === OnchainOutcome.Yes
              ? 1
              : m.outcome === OnchainOutcome.No
                ? 0
                : null,
          yesReserve: m.yesReserve.toString(),
          noReserve: m.noReserve.toString(),
          yesSupply: m.yesSupply.toString(),
          noSupply: m.noSupply.toString(),
          yesPriceBps: m.lastPriceBps,
          baseFeeBps: baseFeeByConfig.get(m.config.toString()) ?? null,
          kickoffTs:
            m.kickoffTs > 0n ? new Date(Number(m.kickoffTs) * 1000) : null,
          freezeTs:
            m.freezeTs > 0n ? new Date(Number(m.freezeTs) * 1000) : null,
          updatedSlot: slot,
        },
      });
    }
    return count;
  }

  /**
   * Refresh Market1x2 accounts: decode q/b/supply/state/outcome and compute the
   * three softmax display prices from `q`+`b` (LMSR — see `chain/lmsr-price.ts`).
   * Prices derive from `q` (INCLUDES the admin seed offset that sets the odds);
   * `*Supply` DTO fields come from `supply` (USER tokens only). Returns the count
   * of existing accounts.
   */
  private async refreshMarkets1x2(
    rows: { id: string }[],
    baseFeeByConfig: Map<string, number>,
    slot: bigint,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const accounts = await this.rpc.withRetry((rpc) =>
      fetchAllMaybeMarket1x2(
        rpc,
        rows.map((r) => address(r.id)),
      ),
    );
    let count = 0;
    for (const account of accounts) {
      if (!account.exists) continue;
      count += 1;
      const m = account.data;
      const q: [bigint, bigint, bigint] = [m.q[0], m.q[1], m.q[2]];
      const [p1, pd, p2] = prices1x2Bps(q, m.b);
      await this.prisma.market.update({
        where: { id: account.address.toString() },
        data: {
          configId: m.config.toString(),
          marketKind: 1,
          state: OnchainMarketState[m.state] ?? 'Open',
          outcome1x2: onchainOutcome1x2Label(m.outcome),
          oneXTeam1PriceBps: p1,
          oneXDrawPriceBps: pd,
          oneXTeam2PriceBps: p2,
          oneXTeam1Supply: m.supply[0].toString(),
          oneXDrawSupply: m.supply[1].toString(),
          oneXTeam2Supply: m.supply[2].toString(),
          oneXB: m.b.toString(),
          yesPriceBps: p1, // legacy col mirrors the Team1 price for 1X2 rows
          baseFeeBps: baseFeeByConfig.get(m.config.toString()) ?? null,
          kickoffTs:
            m.kickoffTs > 0n ? new Date(Number(m.kickoffTs) * 1000) : null,
          freezeTs:
            m.freezeTs > 0n ? new Date(Number(m.freezeTs) * 1000) : null,
          updatedSlot: slot,
        },
      });
    }
    return count;
  }

  /**
   * Off-chain-only refresh for the no-new-tx poll path: live score + reference
   * odds move even when no on-chain trade lands, so the tail refreshes them
   * every cycle (throttled per fixture inside the persister). No RPC calls.
   */
  async refreshLiveData(): Promise<void> {
    await this.persister.enrichScoreAndOdds();
  }
}
