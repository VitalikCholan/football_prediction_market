import { Injectable, Logger } from '@nestjs/common';
import { AMM_PROGRAM_ID, BPS_DENOM } from '@fpm/shared';
import type { IndexedEvent } from './indexer.types';

/**
 * Decodes Anchor program logs into normalized domain events.
 *
 * Anchor emits `emit!` events as base64 "Program data:" log lines carrying an
 * 8-byte event discriminator + Borsh-encoded fields. Once the program team
 * finalizes the event structs, wire the Codama-generated event decoders from
 * `@fpm/idl` here (the `identify*`/`parse*` helpers) keyed by discriminator.
 *
 * For now this is a structured skeleton: it isolates the "Program data:" lines
 * for our program and exposes the price-derivation helper so the wiring point is
 * a single, obvious TODO.
 */
@Injectable()
export class LogParser {
  private readonly logger = new Logger(LogParser.name);
  private readonly programId = AMM_PROGRAM_ID.toString();

  /**
   * Parse the log lines of a single transaction into domain events.
   *
   * @param logs        transaction log messages (from logsSubscribe / getTransaction)
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
    const events: IndexedEvent[] = [];
    const ts = new Date((blockTime ?? Math.floor(Date.now() / 1000)) * 1000);
    let eventIndex = 0;

    for (const line of logs) {
      const data = this.extractProgramData(line);
      if (!data) continue;
      // TODO(program-team IDL): decode `data` (base64 -> bytes) with the Codama
      // event decoders from `@fpm/idl`, match the 8-byte discriminator to
      // Buy/Sell/Activate/Freeze/Resolve, and push the mapped IndexedEvent.
      // Skeleton keeps the index advancing so downstream idempotency keys line up.
      this.logger.debug(
        `program data on ${signature} @ ${eventIndex} (${data.length}b) — decoder not yet wired`,
      );
      eventIndex += 1;
    }

    void ts; // used once events are actually constructed
    return events;
  }

  /** Return the base64 payload of an Anchor "Program data:" line, else null. */
  private extractProgramData(line: string): string | null {
    const marker = 'Program data: ';
    const idx = line.indexOf(marker);
    if (idx === -1) return null;
    return line.slice(idx + marker.length).trim();
  }

  /**
   * On-chain price math (anchor-programs-plan §4.3):
   *   price(YES) = no_reserve / (yes_reserve + no_reserve)
   * Returned in basis points (0..10000). `last_price_bps` from the decoded
   * account is the cross-check.
   */
  static deriveYesPriceBps(yesReserve: bigint, noReserve: bigint): number {
    const total = yesReserve + noReserve;
    if (total === 0n) return BPS_DENOM / 2; // 50/50 before any liquidity
    return Number((noReserve * BigInt(BPS_DENOM)) / total);
  }
}
