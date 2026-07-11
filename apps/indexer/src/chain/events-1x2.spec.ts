/**
 * Unit tests for the 1X2 (phase C) additions: event decoding + the LMSR softmax
 * price port. No live 1X2 market exists on devnet yet, so — unlike the binary
 * `events.spec.ts` (real devnet payloads) — these encode each event's borsh body
 * by hand (discriminator + fields, mirroring `state.rs`) and assert the decoder
 * round-trips it. When a real 1X2 market lands, swap in captured `Program data:`
 * payloads the same way the binary spec does.
 */
import {
  getAddressEncoder,
  getBooleanEncoder,
  getI64Encoder,
  getU16Encoder,
  getU64Encoder,
  getU8Encoder,
  type ReadonlyUint8Array,
} from '@solana/kit';
import { createHash } from 'node:crypto';
import { decodeAmmEvent, Event1x2Outcome } from './events.decoder';
import { prices1x2Bps } from './lmsr-price';

// Anchor `emit!` discriminator = sha256("event:<Name>")[..8].
const disc = (name: string): Uint8Array =>
  Uint8Array.from(
    createHash('sha256').update(`event:${name}`).digest().subarray(0, 8),
  );

const cat = (...parts: ReadonlyUint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const i64 = (v: bigint) => getI64Encoder().encode(v);
const u64 = (v: bigint) => getU64Encoder().encode(v);
const u16 = (v: number) => getU16Encoder().encode(v);
const u8 = (v: number) => getU8Encoder().encode(v);
const bool = (v: boolean) => getBooleanEncoder().encode(v);
const addr = (a: string) => getAddressEncoder().encode(a as never);

const OWNER = '8gmXG7C9NeZRUXfNNiyokAuqXfn9NPCKdSHuqDGdsaow';
const CONFIG = '5aPPJQsxdDRxhPJnKoVCkP4fS1D9JFoBqjAYyKoRjddj';
const FIX = 18179549n;

describe('decodeAmmEvent — 1X2 events (borsh round-trip)', () => {
  it('decodes Market1x2Created (config, b, q[3], prices[3])', () => {
    const payload = cat(
      disc('Market1x2Created'),
      i64(FIX),
      addr(CONFIG),
      u64(100_000_000n),
      u64(1_000_000n),
      u64(0n),
      u64(0n),
      u16(3333),
      u16(3333),
      u16(3333),
    );
    const ev = decodeAmmEvent(payload);
    expect(ev).toMatchObject({
      name: 'Market1x2Created',
      fixtureId: FIX,
      config: CONFIG,
      b: 100_000_000n,
      q: [1_000_000n, 0n, 0n],
      pricesBps: [3333, 3333, 3333],
    });
  });

  it('decodes Market1x2Activated / Market1x2Frozen (fixture + ts)', () => {
    expect(
      decodeAmmEvent(
        cat(disc('Market1x2Activated'), i64(FIX), i64(1783234496n)),
      ),
    ).toMatchObject({
      name: 'Market1x2Activated',
      fixtureId: FIX,
      ts: 1783234496n,
    });
    expect(
      decodeAmmEvent(cat(disc('Market1x2Frozen'), i64(FIX), i64(1783234536n))),
    ).toMatchObject({
      name: 'Market1x2Frozen',
      fixtureId: FIX,
      ts: 1783234536n,
    });
  });

  it('decodes a Trade1x2 (buy Draw)', () => {
    const payload = cat(
      disc('Trade1x2'),
      i64(FIX),
      addr(OWNER),
      u8(1), // outcome = Draw
      bool(true), // is_buy
      u64(5_000_000n),
      u64(4_748_297n),
      u16(3500),
      u16(30),
    );
    expect(decodeAmmEvent(payload)).toMatchObject({
      name: 'Trade1x2',
      fixtureId: FIX,
      owner: OWNER,
      outcome: 1,
      isBuy: true,
      usdt: 5_000_000n,
      tokens: 4_748_297n,
      priceBps: 3500,
      feeBps: 30,
    });
  });

  it('decodes Market1x2Resolved (Team2) and Redeemed1x2', () => {
    expect(
      decodeAmmEvent(cat(disc('Market1x2Resolved'), i64(FIX), u8(3))),
    ).toMatchObject({
      name: 'Market1x2Resolved',
      fixtureId: FIX,
      outcome: Event1x2Outcome.Team2,
    });
    expect(
      decodeAmmEvent(
        cat(disc('Redeemed1x2'), i64(FIX), addr(OWNER), u8(3), u64(4_748_297n)),
      ),
    ).toMatchObject({
      name: 'Redeemed1x2',
      fixtureId: FIX,
      owner: OWNER,
      outcome: Event1x2Outcome.Team2,
      payout: 4_748_297n,
    });
  });

  it('decodes Market1x2Closed and Set mint/redeem events', () => {
    expect(
      decodeAmmEvent(cat(disc('Market1x2Closed'), i64(FIX), u64(42n))),
    ).toMatchObject({ name: 'Market1x2Closed', fixtureId: FIX, swept: 42n });
    expect(
      decodeAmmEvent(
        cat(disc('SetMinted1x2'), i64(FIX), addr(OWNER), u64(1_000n)),
      ),
    ).toMatchObject({
      name: 'SetMinted1x2',
      fixtureId: FIX,
      owner: OWNER,
      amount: 1_000n,
    });
    expect(
      decodeAmmEvent(
        cat(disc('SetRedeemed1x2'), i64(FIX), addr(OWNER), u64(1_000n)),
      ),
    ).toMatchObject({
      name: 'SetRedeemed1x2',
      fixtureId: FIX,
      owner: OWNER,
      amount: 1_000n,
    });
  });
});

describe('prices1x2Bps — LMSR softmax port (parity with lmsr.rs)', () => {
  it('is uniform at the origin: [3333, 3333, 3333]', () => {
    // Matches lmsr.rs `prices_uniform_at_origin` (floor(10_000/3) each).
    expect(prices1x2Bps([0n, 0n, 0n], 1_000_000n)).toEqual([3333, 3333, 3333]);
  });

  it('sums within the documented rounding band [9997, 10000]', () => {
    const p = prices1x2Bps([2_000_000n, 0n, 0n], 1_000_000n);
    const sum = p[0] + p[1] + p[2];
    expect(sum).toBeGreaterThanOrEqual(9997);
    expect(sum).toBeLessThanOrEqual(10_000);
    // Dominant outcome priced highest; the two symmetric ones are equal.
    expect(p[0]).toBeGreaterThan(p[1]);
    expect(p[1]).toBe(p[2]);
  });

  it('is shift-invariant (equal q shift leaves prices unchanged)', () => {
    const base = prices1x2Bps([1_000_000n, 500_000n, 0n], 2_000_000n);
    const shifted = prices1x2Bps(
      [3_000_000n, 2_500_000n, 2_000_000n],
      2_000_000n,
    );
    expect(shifted).toEqual(base);
  });

  it('falls back to an even split for degenerate b = 0', () => {
    expect(prices1x2Bps([1n, 2n, 3n], 0n)).toEqual([3333, 3333, 3333]);
  });
});
