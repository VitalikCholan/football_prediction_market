import { Injectable, Logger } from '@nestjs/common';
import {
  address,
  createSolanaRpc,
  type Address,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from '@solana/kit';
import { AMM_PROGRAM_ID } from '@fpm/shared';
import {
  fetchAllMaybeMarket,
  fetchAllMaybeMarketConfig,
  MarketState as OnchainMarketState,
  Outcome as OnchainOutcome,
} from '@fpm/idl';
import { PrismaService } from '../db/prisma.service';
import { loadIndexerConfig, type IndexerConfig } from './indexer.config';
import { LogParser } from './log-parser';
import { EventPersister } from './persister.service';

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
 * `tailOnce()` (called by SubscriberService on an interval): the same
 * signature walk bounded to "newer than the cursor" — this is the poll-based
 * live tail.
 *
 * All RPC calls go through `withRetry` (exponential backoff + endpoint
 * rotation) because public devnet is rate-limited.
 */
@Injectable()
export class BackfillService {
  private readonly logger = new Logger(BackfillService.name);
  private readonly config: IndexerConfig;
  private readonly rpcs: Rpc<SolanaRpcApi>[];
  private readonly programId: Address;

  constructor(
    private readonly prisma: PrismaService,
    private readonly parser: LogParser,
    private readonly persister: EventPersister,
  ) {
    this.config = loadIndexerConfig(process.env);
    this.rpcs = this.config.rpcUrls.map((url) => createSolanaRpc(url));
    this.programId = this.config.ammProgramId
      ? address(this.config.ammProgramId)
      : AMM_PROGRAM_ID;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get pollMs(): number {
    return this.config.pollMs;
  }

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
    if (!this.config.enabled) {
      this.logger.warn('INDEXER_ENABLED off — skipping backfill');
      return;
    }
    const replayed = await this.tailOnce();
    this.logger.log(`Backfill replayed ${replayed} transaction(s)`);
    await this.refreshMarkets();
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
      const page = await this.withRetry((rpc) =>
        rpc
          .getSignaturesForAddress(this.programId, {
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
    const tx = await this.withRetry((rpc) =>
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
   * Fetch every known Market account (and its MarketConfig) via the Codama
   * decoders and overwrite the denormalized snapshot — the account, not the
   * event stream, is the source of truth for reserves/supplies/state.
   */
  async refreshMarkets(): Promise<void> {
    const rows = await this.prisma.market.findMany({
      select: { id: true, configId: true },
    });
    if (rows.length === 0) return;

    const slot = await this.withRetry((rpc) => rpc.getSlot().send());
    const accounts = await this.withRetry((rpc) =>
      fetchAllMaybeMarket(
        rpc,
        rows.map((r) => address(r.id)),
      ),
    );

    const configIds = [...new Set(rows.map((r) => r.configId))];
    const configs = await this.withRetry((rpc) =>
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

    for (const account of accounts) {
      if (!account.exists) continue;
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
          updatedSlot: BigInt(slot),
        },
      });
    }
    this.logger.log(
      `refreshed ${accounts.filter((a) => a.exists).length}/${rows.length} market account(s) from chain`,
    );
  }

  // ---- rpc resilience ---------------------------------------------------------

  /**
   * Run an RPC call with exponential backoff, rotating through the configured
   * endpoints (primary first) — public devnet 429s are expected.
   */
  private async withRetry<T>(
    fn: (rpc: Rpc<SolanaRpcApi>) => Promise<T>,
  ): Promise<T> {
    const maxAttempts = 3 * this.rpcs.length;
    let delayMs = 500;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const rpc = this.rpcs[attempt % this.rpcs.length];
      try {
        return await fn(rpc);
      } catch (err) {
        lastErr = err;
        this.logger.debug(
          `rpc attempt ${attempt + 1}/${maxAttempts} failed: ${(err as Error).message}; retrying in ${delayMs}ms`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs = Math.min(delayMs * 2, 15_000);
      }
    }
    throw lastErr;
  }
}
