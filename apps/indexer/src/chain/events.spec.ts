/**
 * Event-decoder unit tests using REAL devnet fixtures: the base64 payloads
 * below are verbatim `Program data:` lines emitted by program
 * H59qQz8DXzUWWc3L528iTCFL36ozwBhJc4tHzuwL2JuY (markets for TxLINE fixtures
 * 18179549 and 17588316, July 2026).
 */
import {
  decodeAmmEvent,
  decodeAmmEventsFromLogs,
  EventOutcome,
  extractProgramDataPayloads,
} from './events.decoder';
import { bigintSqrt, deriveReservesFromPrice } from './reserve-math';

const PROGRAM = 'H59qQz8DXzUWWc3L528iTCFL36ozwBhJc4tHzuwL2JuY';

const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));

// Real devnet payloads (market HNkBat…, fixture 18179549, resolved YES).
const MARKET_CREATED =
  'WLiC5+JUBjrdZRUBAAAAAEP8OYD4HfdchoJ0UJSAXdEagRUx/ZOo1sIp28L71FWyAOH1BQAAAAAA4fUFAAAAAIgT';
const MARKET_ACTIVATED = 'xElOMLuEawvdZRUBAAAAAMD/SWoAAAAA';
const TRADE_BUY_YES =
  'GP7amP0rElHdZRUBAAAAAHIxzQkuqNzOEvXAuEnZ+gnpMUau74qXE8uWa0Fy0s22AQFAS0wAAAAAAAl0SAAAAAAAexQeAA==';
const MARKET_FROZEN = 'oiTVzhl20p7dZRUBAAAAAOj/SWoAAAAA';
const MARKET_RESOLVED = 'WUPmX49qx8rdZRUBAAAAAAE=';
const REDEEMED =
  'Dh23Rx+laybdZRUBAAAAAHIxzQkuqNzOEvXAuEnZ+gnpMUau74qXE8uWa0Fy0s22AQl0SAAAAAAA';

describe('decodeAmmEvent (real devnet payloads)', () => {
  it('decodes MarketCreated', () => {
    const ev = decodeAmmEvent(b64(MARKET_CREATED));
    expect(ev).toMatchObject({
      name: 'MarketCreated',
      fixtureId: 18179549n,
      yesReserve: 100_000_000n,
      noReserve: 100_000_000n,
      priceBps: 5000,
    });
    if (ev?.name === 'MarketCreated') {
      expect(ev.config).toBe('5aPPJQsxdDRxhPJnKoVCkP4fS1D9JFoBqjAYyKoRjddj');
    }
  });

  it('decodes MarketActivated / MarketFrozen (fixture + ts)', () => {
    expect(decodeAmmEvent(b64(MARKET_ACTIVATED))).toMatchObject({
      name: 'MarketActivated',
      fixtureId: 18179549n,
      ts: 1783234496n,
    });
    expect(decodeAmmEvent(b64(MARKET_FROZEN))).toMatchObject({
      name: 'MarketFrozen',
      fixtureId: 18179549n,
      ts: 1783234536n,
    });
  });

  it('decodes a Trade (buy YES, 5 USDC, price 5000 -> 5243 bps)', () => {
    const ev = decodeAmmEvent(b64(TRADE_BUY_YES));
    expect(ev).toMatchObject({
      name: 'Trade',
      fixtureId: 18179549n,
      sideYes: true,
      isBuy: true,
      usdc: 5_000_000n,
      tokens: 4_748_297n,
      priceBps: 5243,
      feeBps: 30,
    });
    if (ev?.name === 'Trade') {
      expect(ev.owner).toBe('8gmXG7C9NeZRUXfNNiyokAuqXfn9NPCKdSHuqDGdsaow');
    }
  });

  it('decodes MarketResolved outcome Yes', () => {
    expect(decodeAmmEvent(b64(MARKET_RESOLVED))).toMatchObject({
      name: 'MarketResolved',
      fixtureId: 18179549n,
      outcome: EventOutcome.Yes,
    });
  });

  it('decodes Redeemed (winner payout)', () => {
    expect(decodeAmmEvent(b64(REDEEMED))).toMatchObject({
      name: 'Redeemed',
      fixtureId: 18179549n,
      outcome: EventOutcome.Yes,
      payout: 4_748_297n,
    });
  });

  it('returns null for unknown discriminators and truncated payloads', () => {
    expect(decodeAmmEvent(new Uint8Array(8))).toBeNull();
    expect(decodeAmmEvent(b64(TRADE_BUY_YES).slice(0, 20))).toBeNull();
    expect(decodeAmmEvent(new Uint8Array(0))).toBeNull();
  });
});

describe('extractProgramDataPayloads (invoke-frame attribution)', () => {
  // Verbatim devnet logs of tx cSnSzh2aHaiR… (buy on fixture 18179549).
  const realBuyLogs = [
    `Program ${PROGRAM} invoke [1]`,
    'Program log: Instruction: Buy',
    'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]',
    'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 105 of 185331 compute units',
    'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success',
    `Program data: ${TRADE_BUY_YES}`,
    `Program ${PROGRAM} consumed 17576 of 200000 compute units`,
    `Program ${PROGRAM} success`,
  ];

  it('extracts our program data from real buy logs', () => {
    expect(extractProgramDataPayloads(realBuyLogs, PROGRAM)).toEqual([
      TRADE_BUY_YES,
    ]);
  });

  it('skips Program data emitted by other programs (CPI frames)', () => {
    const foreign = [
      'Program SomeOtherProgram1111111111111111111111111 invoke [1]',
      `Program data: ${TRADE_BUY_YES}`,
      'Program SomeOtherProgram1111111111111111111111111 success',
    ];
    expect(extractProgramDataPayloads(foreign, PROGRAM)).toEqual([]);
  });

  it('attributes data inside nested CPI frames to the inner program', () => {
    const nested = [
      `Program ${PROGRAM} invoke [1]`,
      'Program Other11111111111111111111111111111111111111 invoke [2]',
      'Program data: aW5uZXI=',
      'Program Other11111111111111111111111111111111111111 success',
      `Program data: ${MARKET_RESOLVED}`,
      `Program ${PROGRAM} success`,
    ];
    expect(extractProgramDataPayloads(nested, PROGRAM)).toEqual([
      MARKET_RESOLVED,
    ]);
  });

  it('decodeAmmEventsFromLogs decodes end-to-end', () => {
    const events = decodeAmmEventsFromLogs(realBuyLogs, PROGRAM);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('Trade');
  });
});

describe('reserve math', () => {
  it('bigintSqrt is exact for perfect squares and floors otherwise', () => {
    expect(bigintSqrt(0n)).toBe(0n);
    expect(bigintSqrt(1n)).toBe(1n);
    expect(bigintSqrt(10_000_000_000_000_000n)).toBe(100_000_000n);
    expect(bigintSqrt(99n)).toBe(9n);
  });

  it('recovers post-trade reserves from k + price (real trade: 5000->5243 bps)', () => {
    const k = 100_000_000n * 100_000_000n; // from the real MarketCreated event
    const { yesReserve, noReserve } = deriveReservesFromPrice(k, 5243, {
      yesReserve: 100_000_000n,
      noReserve: 100_000_000n,
    });
    // price(YES) = no/(yes+no) should round-trip to 5243 bps (±1 bps of
    // integer-sqrt truncation; the exact event price is stored on the row).
    const bps = Number((noReserve * 10_000n) / (yesReserve + noReserve));
    expect(Math.abs(bps - 5243)).toBeLessThanOrEqual(1);
    // constant product preserved (within integer-sqrt rounding)
    const kBack = yesReserve * noReserve;
    const drift = kBack > k ? kBack - k : k - kBack;
    expect(drift < k / 1_000_000n).toBe(true);
  });

  it('falls back on degenerate prices', () => {
    const fallback = { yesReserve: 7n, noReserve: 11n };
    expect(deriveReservesFromPrice(0n, 5000, fallback)).toEqual(fallback);
    expect(deriveReservesFromPrice(100n, 0, fallback)).toEqual(fallback);
    expect(deriveReservesFromPrice(100n, 10_000, fallback)).toEqual(fallback);
  });
});
