/**
 * Anchor event discriminators for the amm program — verbatim from
 * `target/idl/amm.json` `events[].discriminator`. If the program's events
 * change, `anchor build` regenerates the IDL and these must be re-checked
 * (the decoder specs assert them against live devnet payloads).
 */
import type { AmmEvent } from './events.types';

/** 8-byte discriminator (as a comma-joined key) -> event name. */
export const DISCRIMINATORS: Record<string, AmmEvent['name']> = {
  [key([88, 184, 130, 231, 226, 84, 6, 58])]: 'MarketCreated',
  [key([196, 73, 78, 48, 187, 132, 107, 11])]: 'MarketActivated',
  [key([162, 36, 213, 206, 25, 118, 210, 158])]: 'MarketFrozen',
  [key([89, 67, 230, 95, 143, 106, 199, 202])]: 'MarketResolved',
  [key([86, 91, 119, 43, 94, 0, 217, 113])]: 'MarketClosed',
  [key([14, 29, 183, 71, 31, 165, 107, 38])]: 'Redeemed',
  [key([24, 254, 218, 152, 253, 43, 18, 81])]: 'Trade',
};

/** Discriminator bytes -> lookup key (also used by the decoder). */
export function key(bytes: number[]): string {
  return bytes.join(',');
}
