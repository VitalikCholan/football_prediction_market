import { z } from 'zod';

/**
 * Indexer chain-subscription config, parsed from the environment. AMM_PROGRAM_ID
 * defaults to the compiled-in constant from `@fpm/shared`; RPC endpoints are
 * comma-separated (primary first, fallbacks after). If HELIUS_RPC_URL is set it
 * is used as the primary endpoint (never hardcode API keys — env only).
 */
const schema = z.object({
  // Single preferred endpoint (e.g. a keyed Helius URL) — takes priority.
  HELIUS_RPC_URL: z.string().optional(),
  // Comma-separated http(s) RPC URLs; the ws:// subscription URL is derived.
  RPC_URLS: z.string().default('https://api.devnet.solana.com'),
  RPC_WS_URL: z.string().optional(),
  AMM_PROGRAM_ID: z.string().optional(),
  // Toggle backfill + live tail on/off.
  INDEXER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  // Poll interval for the signature tail (ms).
  INDEXER_POLL_MS: z.coerce.number().int().min(1000).default(15_000),
});

export type IndexerConfig = {
  rpcUrls: string[];
  rpcWsUrl: string;
  ammProgramId?: string;
  enabled: boolean;
  pollMs: number;
};

export function loadIndexerConfig(env: NodeJS.ProcessEnv): IndexerConfig {
  const parsed = schema.parse(env);
  const rpcUrls = [
    ...(parsed.HELIUS_RPC_URL ? [parsed.HELIUS_RPC_URL.trim()] : []),
    ...parsed.RPC_URLS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ];
  const primary = rpcUrls[0] ?? 'https://api.devnet.solana.com';
  const rpcWsUrl = parsed.RPC_WS_URL ?? primary.replace(/^http/, 'ws');
  return {
    rpcUrls,
    rpcWsUrl,
    ammProgramId: parsed.AMM_PROGRAM_ID,
    enabled: Boolean(parsed.INDEXER_ENABLED),
    pollMs: parsed.INDEXER_POLL_MS,
  };
}
