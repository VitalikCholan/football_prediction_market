/**
 * Pure Anchor event decoding for the amm program — no Nest, no RPC, no DB, so
 * the whole file is unit-testable with plain byte fixtures.
 *
 * Anchor `emit!` writes a `Program data: <base64>` log line whose payload is an
 * 8-byte event discriminator followed by the Borsh-encoded event struct.
 * Layouts mirror `target/idl/amm.json` (`events` + `types`) — Codama does not
 * currently generate event decoders for this IDL, so we build them from
 * `@solana/kit` codecs (same primitives the generated account decoders use).
 *
 * Event type shapes live in `events.types.ts`; discriminators in
 * `events.constants.ts` (both re-exported here for consumers).
 */
import {
  getAddressDecoder,
  getArrayDecoder,
  getBooleanDecoder,
  getI64Decoder,
  getStructDecoder,
  getU16Decoder,
  getU64Decoder,
  getU8Decoder,
  type FixedSizeDecoder,
} from '@solana/kit';
import { DISCRIMINATORS, key } from './events.constants';
import type { AmmEvent } from './events.types';

export * from './events.types';
export { DISCRIMINATORS } from './events.constants';

// ---- borsh payload decoders (layouts from IDL `types`) ----------------------

const addr = getAddressDecoder();
const i64 = getI64Decoder();
const u64 = getU64Decoder();
const u16 = getU16Decoder();
const u8 = getU8Decoder();
const bool = getBooleanDecoder();

const marketCreatedDecoder = getStructDecoder([
  ['fixtureId', i64],
  ['config', addr],
  ['yesReserve', u64],
  ['noReserve', u64],
  ['priceBps', u16],
]);

const tsLifecycleDecoder = getStructDecoder([
  ['fixtureId', i64],
  ['ts', i64],
]);

const marketResolvedDecoder = getStructDecoder([
  ['fixtureId', i64],
  ['outcome', u8],
]);

const marketClosedDecoder = getStructDecoder([
  ['fixtureId', i64],
  ['swept', u64],
]);

const redeemedDecoder = getStructDecoder([
  ['fixtureId', i64],
  ['owner', addr],
  ['outcome', u8],
  ['payout', u64],
]);

const tradeDecoder = getStructDecoder([
  ['fixtureId', i64],
  ['owner', addr],
  ['sideYes', bool],
  ['isBuy', bool],
  ['usdt', u64],
  ['tokens', u64],
  ['priceBps', u16],
  ['feeBps', u16],
]);

// ---- 1X2 borsh payload decoders (state.rs `#[event]` structs) --------------

const u64x3 = getArrayDecoder(u64, { size: 3 });
const u16x3 = getArrayDecoder(u16, { size: 3 });

const market1x2CreatedDecoder = getStructDecoder([
  ['fixtureId', i64],
  ['config', addr],
  ['b', u64],
  ['q', u64x3],
  ['pricesBps', u16x3],
]);

const market1x2ResolvedDecoder = getStructDecoder([
  ['fixtureId', i64],
  ['outcome', u8],
]);

const market1x2ClosedDecoder = getStructDecoder([
  ['fixtureId', i64],
  ['swept', u64],
]);

const redeemed1x2Decoder = getStructDecoder([
  ['fixtureId', i64],
  ['owner', addr],
  ['outcome', u8],
  ['payout', u64],
]);

const trade1x2Decoder = getStructDecoder([
  ['fixtureId', i64],
  ['owner', addr],
  ['outcome', u8],
  ['isBuy', bool],
  ['usdt', u64],
  ['tokens', u64],
  ['priceBps', u16],
  ['feeBps', u16],
]);

const setEvent1x2Decoder = getStructDecoder([
  ['fixtureId', i64],
  ['owner', addr],
  ['amount', u64],
]);

/**
 * Decode one Anchor event payload (8-byte discriminator + borsh fields).
 * Returns null for unknown discriminators or truncated payloads.
 */
export function decodeAmmEvent(bytes: Uint8Array): AmmEvent | null {
  if (bytes.length < 8) return null;
  const name = DISCRIMINATORS[key([...bytes.slice(0, 8)])];
  if (!name) return null;
  const body = bytes.slice(8);
  try {
    switch (name) {
      case 'MarketCreated':
        return { name, ...decode(marketCreatedDecoder, body) };
      case 'MarketActivated':
        return { name, ...decode(tsLifecycleDecoder, body) };
      case 'MarketFrozen':
        return { name, ...decode(tsLifecycleDecoder, body) };
      case 'MarketResolved': {
        const d = decode(marketResolvedDecoder, body);
        return { name, fixtureId: d.fixtureId, outcome: d.outcome };
      }
      case 'MarketClosed':
        return { name, ...decode(marketClosedDecoder, body) };
      case 'Redeemed': {
        const d = decode(redeemedDecoder, body);
        return {
          name,
          fixtureId: d.fixtureId,
          owner: d.owner,
          outcome: d.outcome,
          payout: d.payout,
        };
      }
      case 'Trade':
        return { name, ...decode(tradeDecoder, body) };
      case 'Market1x2Created': {
        const d = decode(market1x2CreatedDecoder, body);
        return {
          name,
          fixtureId: d.fixtureId,
          config: d.config,
          b: d.b,
          q: [d.q[0], d.q[1], d.q[2]],
          pricesBps: [d.pricesBps[0], d.pricesBps[1], d.pricesBps[2]],
        };
      }
      case 'Market1x2Activated':
        return { name, ...decode(tsLifecycleDecoder, body) };
      case 'Market1x2Frozen':
        return { name, ...decode(tsLifecycleDecoder, body) };
      case 'Market1x2Resolved': {
        const d = decode(market1x2ResolvedDecoder, body);
        return { name, fixtureId: d.fixtureId, outcome: d.outcome };
      }
      case 'Market1x2Closed':
        return { name, ...decode(market1x2ClosedDecoder, body) };
      case 'Redeemed1x2': {
        const d = decode(redeemed1x2Decoder, body);
        return {
          name,
          fixtureId: d.fixtureId,
          owner: d.owner,
          outcome: d.outcome,
          payout: d.payout,
        };
      }
      case 'Trade1x2':
        return { name, ...decode(trade1x2Decoder, body) };
      case 'SetMinted1x2':
        return { name, ...decode(setEvent1x2Decoder, body) };
      case 'SetRedeemed1x2':
        return { name, ...decode(setEvent1x2Decoder, body) };
    }
  } catch {
    return null; // truncated / malformed payload
  }
  return null;
}

function decode<T extends object>(
  decoder: FixedSizeDecoder<T>,
  bytes: Uint8Array,
): T {
  if (bytes.length < decoder.fixedSize) {
    throw new Error(
      `payload too short: ${bytes.length} < ${decoder.fixedSize}`,
    );
  }
  return decoder.decode(bytes);
}

/**
 * Walk a transaction's log messages and return the base64 `Program data:`
 * payloads emitted **by `programId`'s own invoke frames** (CPI events from
 * other programs mentioned in the tx are skipped). Pure function.
 */
export function extractProgramDataPayloads(
  logs: readonly string[],
  programId: string,
): string[] {
  const payloads: string[] = [];
  const stack: string[] = [];
  for (const line of logs) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    if (/^Program \w+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (line.startsWith('Program data: ')) {
      if (stack[stack.length - 1] === programId) {
        payloads.push(line.slice('Program data: '.length).trim());
      }
    }
  }
  return payloads;
}

/** Decode every amm event in a transaction's logs (pure; order-preserving). */
export function decodeAmmEventsFromLogs(
  logs: readonly string[],
  programId: string,
): AmmEvent[] {
  const events: AmmEvent[] = [];
  for (const b64 of extractProgramDataPayloads(logs, programId)) {
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
    } catch {
      continue;
    }
    const ev = decodeAmmEvent(bytes);
    if (ev) events.push(ev);
  }
  return events;
}
