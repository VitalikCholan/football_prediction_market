import { request } from "undici";
import type { KeeperConfig } from "../config.ts";
import { log } from "../log.ts";
import type { TxlineAuth } from "./auth.ts";
import type {
  BinaryExpression,
  ProofNode,
  ResolveProofArgs,
  ScoreStat,
  ScoresBatchSummary,
  StatTerm,
} from "./types.ts";

/**
 * Fetch the stat-validation proof from TxLINE and map it into the args our
 * `resolve` instruction forwards to the validate_stat CPI (backend-plan §2.8).
 *
 *   GET /api/scores/stat-validation?fixtureId=X&seq=Y&statKey=Z&statKey2=W
 *
 * The response is directly usable as validate_stat args; we normalize its
 * (docs-generic) field names into the typed ResolveProofArgs.
 */
export interface StatValidationQuery {
  fixtureId: bigint;
  seq?: number;
  statKey: number;
  statKey2?: number;
  op?: BinaryExpression;
}

export class ProofFetcher {
  private readonly config: KeeperConfig;
  private readonly auth: TxlineAuth;

  constructor(config: KeeperConfig, auth: TxlineAuth) {
    this.config = config;
    this.auth = auth;
  }

  async fetch(query: StatValidationQuery): Promise<ResolveProofArgs> {
    const headers = await this.auth.headers();
    const params = new URLSearchParams();
    params.set("fixtureId", query.fixtureId.toString());
    if (query.seq !== undefined) params.set("seq", String(query.seq));
    params.set("statKey", String(query.statKey));
    if (query.statKey2 !== undefined)
      params.set("statKey2", String(query.statKey2));

    const url = `${this.config.txlineBaseUrl}/api/scores/stat-validation?${params}`;
    const res = await request(url, { method: "GET", headers });
    if (res.statusCode >= 300) {
      const body = await res.body.text();
      throw new Error(`stat-validation failed (${res.statusCode}): ${body}`);
    }
    const json = (await res.body.json()) as Record<string, unknown>;
    log.debug({ fixtureId: query.fixtureId.toString() }, "fetched stat proof");
    return this.mapResponse(json, query);
  }

  /** Normalize the (generic) response into typed ResolveProofArgs. */
  private mapResponse(
    json: Record<string, unknown>,
    query: StatValidationQuery,
  ): ResolveProofArgs {
    const ts = BigInt((json.ts ?? json.timestamp ?? 0) as string | number);
    const epochDay =
      Number(json.epoch_day ?? json.epochDay ?? 0) ||
      Number(ts / 86_400n); // fallback: seconds -> days

    return {
      ts,
      epochDay,
      fixtureSummary: this.mapSummary(
        json.fixture_summary ?? json.fixtureSummary,
        query.fixtureId,
      ),
      fixtureProof: this.mapProof(json.fixture_proof ?? json.fixtureProof),
      mainTreeProof: this.mapProof(json.main_tree_proof ?? json.mainTreeProof),
      statA: this.mapStatTerm(json.stat_a ?? json.statA),
      statB:
        json.stat_b ?? json.statB
          ? this.mapStatTerm(json.stat_b ?? json.statB)
          : undefined,
      op: query.op ?? (json.op as BinaryExpression | undefined),
    };
  }

  private mapProof(raw: unknown): ProofNode[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((n) => {
      const o = n as Record<string, unknown>;
      return {
        hash: this.toBytes(o.hash),
        isRightSibling: Boolean(o.is_right_sibling ?? o.isRightSibling),
      };
    });
  }

  private mapStatTerm(raw: unknown): StatTerm {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      statToProve: this.mapStat(o.stat_to_prove ?? o.statToProve),
      eventStatRoot: this.toBytes(o.event_stat_root ?? o.eventStatRoot),
      statProof: this.mapProof(o.stat_proof ?? o.statProof),
    };
  }

  private mapStat(raw: unknown): ScoreStat {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      key: Number(o.key ?? 0),
      value: Number(o.value ?? 0),
      period: Number(o.period ?? 0),
    };
  }

  private mapSummary(raw: unknown, fixtureId: bigint): ScoresBatchSummary {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      fixtureId: o.fixture_id
        ? BigInt(o.fixture_id as string | number)
        : fixtureId,
      updateStats: { raw: o.update_stats ?? o.updateStats ?? null },
      eventsSubTreeRoot: this.toBytes(
        o.events_sub_tree_root ?? o.eventsSubTreeRoot,
      ),
    };
  }

  /** Coerce a hash field (hex string, base64, or number[]) into 32 bytes. */
  private toBytes(raw: unknown): Uint8Array {
    if (raw instanceof Uint8Array) return raw;
    if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
    if (typeof raw === "string") {
      // Try hex first, then base64.
      if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
        return Uint8Array.from(Buffer.from(raw, "hex"));
      }
      return Uint8Array.from(Buffer.from(raw, "base64"));
    }
    return new Uint8Array(32);
  }
}
