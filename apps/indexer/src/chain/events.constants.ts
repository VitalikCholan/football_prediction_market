/**
 * Anchor event discriminators for the amm program — verbatim from
 * `target/idl/amm.json` `events[].discriminator`. If the program's events
 * change, `anchor build` regenerates the IDL and these must be re-checked
 * (the decoder specs assert them against live devnet payloads).
 */
import type { AmmEvent } from './events.types';

/**
 * 8-byte discriminator (as a comma-joined key) -> event name.
 *
 * Binary (v0) and 1X2 (phase C) events share one program, so both live here;
 * the decoder keys on the name. Every value is `sha256("event:<Name>")[..8]`
 * (Anchor's `emit!` discriminator) — verified against the binary set already
 * present, and the 1X2 set was computed the same way (state.rs event structs).
 */
export const DISCRIMINATORS: Record<string, AmmEvent['name']> = {
  [key([88, 184, 130, 231, 226, 84, 6, 58])]: 'MarketCreated',
  [key([196, 73, 78, 48, 187, 132, 107, 11])]: 'MarketActivated',
  [key([162, 36, 213, 206, 25, 118, 210, 158])]: 'MarketFrozen',
  [key([89, 67, 230, 95, 143, 106, 199, 202])]: 'MarketResolved',
  [key([86, 91, 119, 43, 94, 0, 217, 113])]: 'MarketClosed',
  [key([14, 29, 183, 71, 31, 165, 107, 38])]: 'Redeemed',
  [key([24, 254, 218, 152, 253, 43, 18, 81])]: 'Trade',
  // ---- 1X2 (phase C) --------------------------------------------------------
  [key([80, 66, 193, 53, 122, 9, 129, 77])]: 'Market1x2Created',
  [key([21, 21, 181, 138, 8, 69, 81, 223])]: 'Market1x2Activated',
  [key([56, 124, 166, 228, 139, 254, 3, 225])]: 'Market1x2Frozen',
  [key([77, 208, 76, 150, 247, 136, 0, 172])]: 'Market1x2Resolved',
  [key([243, 38, 2, 244, 90, 71, 197, 253])]: 'Market1x2Closed',
  [key([174, 180, 249, 40, 65, 188, 169, 176])]: 'Redeemed1x2',
  [key([105, 51, 109, 13, 194, 75, 227, 159])]: 'Trade1x2',
  [key([169, 123, 226, 63, 240, 24, 216, 165])]: 'SetMinted1x2',
  [key([152, 59, 29, 160, 83, 182, 17, 12])]: 'SetRedeemed1x2',
};

/** Discriminator bytes -> lookup key (also used by the decoder). */
export function key(bytes: number[]): string {
  return bytes.join(',');
}
