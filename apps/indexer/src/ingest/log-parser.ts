import { Injectable, Logger } from '@nestjs/common';
import { AMM_PROGRAM_ID } from '@fpm/shared';
import { decodeAmmEventsFromLogs } from '../chain/events.decoder';
import type { IndexedEvent } from '../chain/indexed-events.types';
import { toIndexedEvent } from '../chain/log-parser';

/**
 * Decodes Anchor program logs into normalized domain events.
 *
 * The heavy lifting (invoke-frame attribution + discriminator matching + borsh
 * decode + envelope mapping) lives in the pure functions of `chain/`; this
 * class is the Nest glue that stamps the per-transaction envelope (signature,
 * slot, block time, event index) and logs unhandled events.
 */
@Injectable()
export class LogParser {
  private readonly logger = new Logger(LogParser.name);
  private readonly programId = AMM_PROGRAM_ID.toString();

  /**
   * Parse the log lines of a single transaction into domain events.
   *
   * @param logs        transaction log messages (from getTransaction)
   * @param signature   tx signature
   * @param slot        slot the tx landed in
   * @param blockTime   block time (unix seconds) or null
   */
  parse(
    logs: readonly string[],
    signature: string,
    slot: bigint,
    blockTime: number | null,
  ): IndexedEvent[] {
    const ts = new Date((blockTime ?? Math.floor(Date.now() / 1000)) * 1000);
    const raw = decodeAmmEventsFromLogs(logs, this.programId);
    const events: IndexedEvent[] = [];

    raw.forEach((ev, eventIndex) => {
      const mapped = toIndexedEvent(ev, { signature, eventIndex, slot, ts });
      if (mapped) {
        events.push(mapped);
      } else {
        this.logger.warn(`unhandled amm event on ${signature}`);
      }
    });
    return events;
  }
}
