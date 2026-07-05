import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { BackfillService } from './backfill.service';

/**
 * Live tail (backend-plan §3.2). Poll-based: every `INDEXER_POLL_MS` run one
 * `tailOnce()` — getSignaturesForAddress since the persisted IndexerCursor,
 * replay, advance cursor. Polling (vs logsSubscribe websockets) is deliberate
 * for the hackathon: it is idempotent by construction (same code path as the
 * boot backfill), survives RPC disconnects with zero reconnect logic, and
 * plays nicer with rate-limited devnet endpoints. A websocket fast-path can be
 * layered on later without touching persistence.
 *
 * After a poll that indexed new transactions, the Market accounts are
 * re-fetched via the Codama decoders so the snapshot stays authoritative.
 * Gated behind INDEXER_ENABLED so the REST API can run standalone.
 */
@Injectable()
export class SubscriberService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscriberService.name);
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(private readonly backfill: BackfillService) {}

  onModuleInit(): void {
    if (!this.backfill.enabled) {
      this.logger.warn(
        'INDEXER_ENABLED is off — live tail NOT started ' +
          '(set INDEXER_ENABLED=1 to enable live indexing).',
      );
      return;
    }
    this.logger.log(`live tail polling every ${this.backfill.pollMs}ms`);
    this.timer = setInterval(() => void this.tick(), this.backfill.pollMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One poll iteration; re-entrancy guarded (slow RPC > interval). */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const processed = await this.backfill.tailOnce();
      if (processed > 0) {
        this.logger.log(`tail indexed ${processed} new transaction(s)`);
        await this.backfill.refreshMarkets();
      }
    } catch (err) {
      this.logger.error(`tail poll failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
