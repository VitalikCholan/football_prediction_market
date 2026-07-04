import { z } from 'zod';

/**
 * Indexer chain-subscription config, parsed from the environment. AMM_PROGRAM_ID
 * defaults to the compiled-in constant from `@fpm/shared`; RPC endpoints are
 * comma-separated (primary first, fallbacks after).
 */
const schema = z.object({
  // Comma-separated http(s) RPC URLs; the ws:// subscription URL is derived.
  RPC_URLS: z.string().default('https://api.devnet.solana.com'),
  RPC_WS_URL: z.string().optional(),
  AMM_PROGRAM_ID: z.string().optional(),
  // Toggle the live subscriber on/off (off by default until the IDL is final).
  INDEXER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});

export type IndexerConfig = {
  rpcUrls: string[];
  rpcWsUrl: string;
  ammProgramId?: string;
  enabled: boolean;
};

export function loadIndexerConfig(env: NodeJS.ProcessEnv): IndexerConfig {
  const parsed = schema.parse(env);
  const rpcUrls = parsed.RPC_URLS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const primary = rpcUrls[0] ?? 'https://api.devnet.solana.com';
  const rpcWsUrl =
    parsed.RPC_WS_URL ?? primary.replace(/^http/, 'ws');
  return {
    rpcUrls,
    rpcWsUrl,
    ammProgramId: parsed.AMM_PROGRAM_ID,
    enabled: Boolean(parsed.INDEXER_ENABLED),
  };
}
