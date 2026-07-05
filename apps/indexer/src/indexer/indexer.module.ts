import { Module, type OnModuleInit } from '@nestjs/common';
import { BackfillService } from './backfill.service';
import { LogParser } from './log-parser';
import { EventPersister } from './persister.service';
import { SubscriberService } from './subscriber.service';

/**
 * Background indexing worker. Runs in-process with the API (no separate
 * deployable for the hackathon). On boot it runs a full backfill (program
 * history -> cursor) + an authoritative Market-account refresh, then the
 * SubscriberService keeps a poll-based tail running on an interval.
 */
@Module({
  providers: [LogParser, EventPersister, SubscriberService, BackfillService],
})
export class IndexerModule implements OnModuleInit {
  constructor(private readonly backfill: BackfillService) {}

  async onModuleInit(): Promise<void> {
    // Backfill first so the live tail only has to cover new activity.
    // Guarded internally by INDEXER_ENABLED; swallow errors so a cold DB or RPC
    // never blocks API startup.
    try {
      await this.backfill.run();
    } catch {
      // logged inside the service
    }
  }
}
