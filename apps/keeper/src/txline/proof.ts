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
  ScoresUpdateStats,
  StatTerm,
} from "./types.ts";

/**
 * Fetch the stat-validation proof from TxLINE and map it into the args our
 * `resolve` instruction forwards to the validate_stat CPI (backend-plan §2.8).
 *
 *   GET /api/scores/stat-validation?fixtureId=X&seq=Y&statKey=Z&statKey2=W
 *
 * VERIFIED live 2026-07-04 (docs/OpenAPI were wrong):
 *   - `seq` is REQUIRED (404 without it) — take it from the score event that
 *     ended the match (`Seq` field, or HistoryClient.findMatchEnd);
 *   - the response is FLAT camelCase JSON:
 *       { ts, statToProve, eventStatRoot, summary{ fixtureId,
 *         updateStats{updateCount,minTimestamp,maxTimestamp},
 *         eventStatsSubTreeRoot }, statProof, subTreeProof, mainTreeProof,
 *         statToProve2?, statProof2? }
 *     with hashes as number[32]. Final stats carry `period: 100`.
 *   - mapping to ResolveProofArgs:
 *       statA          = { statToProve, eventStatRoot, statProof }
 *       statB (if statKey2) = { statToProve2, eventStatRoot (SHARED root), statProof2 }
 *       fixtureSummary = { summary.fixtureId, summary.updateStats,
 *                          eventsSubTreeRoot: summary.eventStatsSubTreeRoot }
 *       fixtureProof   = subTreeProof
 *       mainTreeProof  = mainTreeProof
 *       ts             = ts (MILLISECONDS; epochDay = ts / 86_400_000)
 */
export interface StatValidationQuery {
  fixtureId: bigint;
  /** REQUIRED — the Seq of the score event that finalised the match. */
  seq: number;
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
    params.set("seq", String(query.seq));
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
    log.debug(
      { fixtureId: query.fixtureId.toString(), seq: query.seq },
      "fetched stat proof",
    );
    return this.mapResponse(json, query);
  }

  /** Map the (verified-flat) response into typed ResolveProofArgs. */
  private mapResponse(
    json: Record<string, unknown>,
    query: StatValidationQuery,
  ): ResolveProofArgs {
    const ts = BigInt((json.ts ?? json.timestamp ?? 0) as string | number);
    // TxLINE ts is MILLISECONDS -> epoch days (verified vs devnet binary).
    const epochDay = Number(ts / 86_400_000n);

    // Both stat terms share the SAME eventStatRoot (one root per fixture batch).
    const eventStatRoot = this.toBytes(json.eventStatRoot);
    const statA: StatTerm = {
      statToProve: this.mapStat(json.statToProve),
      eventStatRoot,
      statProof: this.mapProof(json.statProof),
    };
    const hasStatB =
      query.statKey2 !== undefined &&
      json.statToProve2 !== undefined &&
      json.statToProve2 !== null;
    const statB: StatTerm | undefined = hasStatB
      ? {
          statToProve: this.mapStat(json.statToProve2),
          eventStatRoot,
          statProof: this.mapProof(json.statProof2),
        }
      : undefined;

    return {
      ts,
      epochDay,
      fixtureSummary: this.mapSummary(json.summary, query.fixtureId),
      fixtureProof: this.mapProof(json.subTreeProof), // <-- subTreeProof on the wire
      mainTreeProof: this.mapProof(json.mainTreeProof),
      statA,
      statB,
      op: query.op ?? (json.op as BinaryExpression | undefined),
    };
  }

  private mapProof(raw: unknown): ProofNode[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((n) => {
      const o = n as Record<string, unknown>;
      return {
        hash: this.toBytes(o.hash),
        isRightSibling: Boolean(o.isRightSibling ?? o.is_right_sibling),
      };
    });
  }

  private mapStat(raw: unknown): ScoreStat {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      key: Number(o.key ?? 0),
      value: Number(o.value ?? 0),
      period: Number(o.period ?? 0), // final stats carry period 100
    };
  }

  private mapSummary(raw: unknown, fixtureId: bigint): ScoresBatchSummary {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      fixtureId:
        o.fixtureId !== undefined && o.fixtureId !== null
          ? BigInt(o.fixtureId as string | number)
          : fixtureId,
      updateStats: this.mapUpdateStats(o.updateStats),
      eventsSubTreeRoot: this.toBytes(o.eventStatsSubTreeRoot),
    };
  }

  /** Typed `ScoresUpdateStats` — forwarded verbatim into the resolve ix. */
  private mapUpdateStats(raw: unknown): ScoresUpdateStats {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      updateCount: Number(o.updateCount ?? o.update_count ?? 0),
      minTimestamp: BigInt(
        (o.minTimestamp ?? o.min_timestamp ?? 0) as string | number,
      ),
      maxTimestamp: BigInt(
        (o.maxTimestamp ?? o.max_timestamp ?? 0) as string | number,
      ),
    };
  }

  /** Coerce a hash field (number[32] on the wire; hex/base64 tolerated). */
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
