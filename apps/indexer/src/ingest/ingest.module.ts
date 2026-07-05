import { Module, type OnModuleInit } from '@nestjs/common';
import { BackfillService } from './backfill.service';
import { LogParser } from './log-parser';
import { EventPersister } from './persister.service';
import { RpcService } from './rpc.service';
import { TailService } from './tail.service';

/**
 * Background indexing worker (write path). Runs in-process with the API (no
 * separate deployable for the hackathon). On boot it runs a full backfill
 * (program history -> cursor) + an authoritative Market-account refresh, then
 * the TailService keeps a poll-based tail running on an interval.
 */
@Module({
  providers: [
    RpcService,
    LogParser,
    EventPersister,
    TailService,
    BackfillService,
  ],
})
export class IngestModule implements OnModuleInit {
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
