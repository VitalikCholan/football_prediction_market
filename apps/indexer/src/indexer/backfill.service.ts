import { Injectable, Logger } from '@nestjs/common';
import {
  createSolanaRpc,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from '@solana/kit';
import { AMM_PROGRAM_ID } from '@fpm/shared';
import { PrismaService } from '../db/prisma.service';
import { loadIndexerConfig, type IndexerConfig } from './indexer.config';
import { LogParser } from './log-parser';

/**
 * Startup catch-up (backend-plan §3.2). On boot, walk
 * getSignaturesForAddress(AMM_PROGRAM_ID) back to the persisted cursor and
 * replay each tx via getTransaction to fill gaps from downtime. Idempotent
 * upserts keyed by (signature, event_index) make re-runs safe.
 *
 * Skeleton: cursor read/write + the fetch loop are structured; the per-tx
 * decode reuses LogParser (whose event decoder is the pending IDL TODO).
 */
@Injectable()
export class BackfillService {
  private readonly logger = new Logger(BackfillService.name);
  private readonly config: IndexerConfig;
  private readonly rpc: Rpc<SolanaRpcApi>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly parser: LogParser,
  ) {
    this.config = loadIndexerConfig(process.env);
    this.rpc = createSolanaRpc(this.config.rpcUrls[0]);
  }

  /** Read the single-row replay checkpoint. */
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

  /** Persist the replay checkpoint. */
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

  /**
   * Replay signatures newer than the cursor. Called once on boot before the
   * live subscription takes over.
   */
  async run(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.warn('INDEXER_ENABLED off — skipping backfill');
      return;
    }
    const { lastIndexedSignature } = await this.getCursor();
    this.logger.log(
      `Backfill from ${lastIndexedSignature ?? 'genesis of program history'}`,
    );

    const signatures = await this.rpc
      .getSignaturesForAddress(AMM_PROGRAM_ID, {
        until: (lastIndexedSignature as Signature | null) ?? undefined,
        limit: 1000,
      })
      .send();

    if (signatures.length === 0) {
      this.logger.log('Backfill: nothing to replay');
      return;
    }

    // Oldest first so the cursor advances monotonically.
    const ordered = [...signatures].reverse();
    for (const sig of ordered) {
      const tx = await this.rpc
        .getTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
          encoding: 'json',
        })
        .send();
      const logs = tx?.meta?.logMessages ?? [];
      const slot = BigInt(sig.slot);
      const events = this.parser.parse(
        logs,
        sig.signature,
        slot,
        sig.blockTime ? Number(sig.blockTime) : null,
      );
      // persistence handled the same way the subscriber does — omitted here to
      // avoid duplicating logic; the subscriber's persist() is the shared sink
      // once decoders are wired. For now backfill just advances the cursor.
      void events;
      await this.setCursor(sig.signature, slot);
    }
    this.logger.log(`Backfill replayed ${ordered.length} signatures`);
  }
}
