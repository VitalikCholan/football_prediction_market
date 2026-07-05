import { Injectable, Logger } from '@nestjs/common';
import {
  address,
  createSolanaRpc,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';
import { AMM_PROGRAM_ID } from '@fpm/shared';
import { loadIndexerConfig, type IndexerConfig } from './ingest.config';

/**
 * Shared RPC access for the ingest pipeline (extracted from BackfillService):
 * owns the env-derived config, the endpoint pool (primary first, fallbacks
 * after) and the retry policy. Both the boot backfill and the live tail
 * consume it via DI.
 */
@Injectable()
export class RpcService {
  private readonly logger = new Logger(RpcService.name);
  private readonly config: IndexerConfig;
  private readonly rpcs: Rpc<SolanaRpcApi>[];
  readonly programId: Address;

  constructor() {
    this.config = loadIndexerConfig(process.env);
    this.rpcs = this.config.rpcUrls.map((url) => createSolanaRpc(url));
    this.programId = this.config.ammProgramId
      ? address(this.config.ammProgramId)
      : AMM_PROGRAM_ID;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get pollMs(): number {
    return this.config.pollMs;
  }

  /**
   * Run an RPC call with exponential backoff, rotating through the configured
   * endpoints (primary first) — public devnet 429s are expected.
   */
  async withRetry<T>(
    fn: (rpc: Rpc<SolanaRpcApi>) => Promise<T>,
  ): Promise<T> {
    const maxAttempts = 3 * this.rpcs.length;
    let delayMs = 500;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const rpc = this.rpcs[attempt % this.rpcs.length];
      try {
        return await fn(rpc);
      } catch (err) {
        lastErr = err;
        this.logger.debug(
          `rpc attempt ${attempt + 1}/${maxAttempts} failed: ${(err as Error).message}; retrying in ${delayMs}ms`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs = Math.min(delayMs * 2, 15_000);
      }
    }
    throw lastErr;
  }
}
