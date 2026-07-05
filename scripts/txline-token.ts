/**
 * One-shot, idempotent TxLINE API-token bootstrap for the keeper (DEVNET).
 *
 * Flow (documentation/quickstart.md + documentation/worldcup.md, verified
 * 2026-07-04 against live devnet):
 *   1. On-chain `subscribe(service_level_id=1, weeks=4)` — free World Cup
 *      tier (pricing matrix row 1 has price_per_week_token = 0, verified by
 *      decoding B4hHn1FpD1YPPrcM4yUrQhBPF18zFWgijHLTsumGzeKi). The ix is
 *      hand-built from the vendored IDL discriminator (same pattern as
 *      devnet-init.ts `request_devnet_faucet`). Account order verified
 *      against a live devnet subscribe tx
 *      (5cPpBSnduuDrKiY86o5u2821YQPQqC5rpMWqyQf8NMe5EKhBKKo98Ax3REW8deymAH92jSjeDVBT7qn28SCSsXSZ):
 *      the program CPIs Thaw -> TransferChecked(0) -> Freeze on the user's
 *      TxL ATA even on the free row, so we create that ATA idempotently in
 *      the same tx.
 *   2. POST {apiOrigin}/auth/guest/start -> guest JWT.
 *   3. ed25519-sign `${txSig}::${jwt}` (empty leagues) with the CLI wallet —
 *      node:crypto (PKCS8-wrapped 32-byte seed), no tweetnacl dep.
 *   4. POST {apiOrigin}/api/token/activate -> apiToken.
 *   5. Verify end-to-end (historical scores, stat-validation proof, ~20s of
 *      the SSE stream) and dump the REAL response shapes.
 *   6. Persist TXLINE_API_TOKEN (+ devnet TXLINE_BASE_URL) into
 *      apps/keeper/.env (created from .env.example if absent).
 *
 * DEVNET API origin is https://txline-dev.txodds.com — NOT txline.txodds.com
 * (mainnet). A devnet tx cannot be activated on the mainnet host
 * (quickstart.md "Select Your Network" warning).
 *
 * Idempotent: if apps/keeper/.env already has a TXLINE_API_TOKEN that still
 * authenticates, the subscribe/activate steps are skipped (FORCE=1 overrides)
 * and only the verification suite runs.
 *
 * Run (repo root):  pnpm txline:token
 *   or:             pnpm --filter @fpm/devnet-scripts txline:token
 */
import { createPrivateKey, createPublicKey, sign as ed25519Sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getUtf8Encoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { TXLINE } from "@fpm/shared";

/* ----------------------------------------------------------------- config */
const RPC_URLS = process.env.HELIUS_RPC_URL
  ? [process.env.HELIUS_RPC_URL, "https://api.devnet.solana.com"]
  : ["https://api.devnet.solana.com"];
const KEYPAIR_PATH =
  process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config", "solana", "id.json");

/** DEVNET API origin (quickstart.md network table). */
const API_ORIGIN = process.env.TXLINE_API_ORIGIN ?? "https://txline-dev.txodds.com";

const TXLINE_PROGRAM = TXLINE.devnet.txlineProgram;
const TXL_MINT = TXLINE.devnet.txlMint; // Token-2022
const TOKEN_2022_PROGRAM = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

// subscribe — discriminator + arg layout from programs/amm/idls/txline.json;
// byte-identical to live devnet subscribe txs (fe1cbf8a9cb3b735 || u16 || u8).
const SUBSCRIBE_DISCRIMINATOR = new Uint8Array([254, 28, 191, 138, 156, 179, 183, 53]);
const SERVICE_LEVEL_ID = 1; // free World Cup & Int Friendlies, 60s delay
const DURATION_WEEKS = 4;
const SELECTED_LEAGUES: number[] = []; // standard bundle -> `${txSig}::${jwt}`

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname));
const KEEPER_ENV = join(REPO_ROOT, "..", "apps", "keeper", ".env");
const KEEPER_ENV_EXAMPLE = join(REPO_ROOT, "..", "apps", "keeper", ".env.example");

/** Fallback if /api/fixtures/snapshot yields no started fixture. */
const FALLBACK_FIXTURE_ID = 18_179_549; // Colombia vs Ghana (WC, played 2026-07-01 on devnet feed)
const SSE_CAPTURE_MS = 20_000;
const FORCE = process.env.FORCE === "1";

const mask = (t: string) => `${t.slice(0, 8)}…(${t.length} chars)`;
const EXPLORER = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

/* ------------------------------------------------------------- rpc + retry */
const rpcs: Rpc<SolanaRpcApi>[] = RPC_URLS.map((u) => createSolanaRpc(u));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRpc<T>(
  label: string,
  fn: (rpc: Rpc<SolanaRpcApi>) => Promise<T>,
  attempts = 6,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(rpcs[i % rpcs.length]);
    } catch (e) {
      lastErr = e;
      const wait = 1_000 * (i + 1);
      console.warn(
        `    rpc retry ${i + 1}/${attempts} for ${label} in ${wait}ms — ${
          e instanceof Error ? e.message.slice(0, 160) : e
        }`,
      );
      await sleep(wait);
    }
  }
  throw new Error(
    `${label} failed after ${attempts} attempts: ${
      lastErr instanceof Error ? lastErr.message : lastErr
    }`,
  );
}

/* -------------------------------------------------------------- ix builders */
const utf8 = getUtf8Encoder();
const addressEncoder = getAddressEncoder();

async function findAta(
  owner: Address,
  mint: Address,
  tokenProgram: Address,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM,
    seeds: [
      addressEncoder.encode(owner),
      addressEncoder.encode(tokenProgram),
      addressEncoder.encode(mint),
    ],
  });
  return pda;
}

/** `CreateIdempotent` on the ATA program (single instruction byte 0x01). */
function buildCreateAtaIdempotentIx(
  payer: Address,
  ata: Address,
  owner: Address,
  mint: Address,
  tokenProgram: Address,
): Instruction {
  return {
    programAddress: ATA_PROGRAM,
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: ata, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: tokenProgram, role: AccountRole.READONLY },
    ],
    data: new Uint8Array([1]),
  };
}

/** Hand-built TxLINE `subscribe` (IDL account order, verified vs live tx). */
async function buildSubscribeIx(user: Address): Promise<Instruction> {
  const [pricingMatrix] = await getProgramDerivedAddress({
    programAddress: TXLINE_PROGRAM,
    seeds: [utf8.encode("pricing_matrix")],
  });
  const [treasuryPda] = await getProgramDerivedAddress({
    programAddress: TXLINE_PROGRAM,
    seeds: [utf8.encode("token_treasury_v2")],
  });
  const treasuryVault = await findAta(treasuryPda, TXL_MINT, TOKEN_2022_PROGRAM);
  const userTokenAccount = await findAta(user, TXL_MINT, TOKEN_2022_PROGRAM);

  const data = new Uint8Array(11);
  data.set(SUBSCRIBE_DISCRIMINATOR, 0);
  new DataView(data.buffer).setUint16(8, SERVICE_LEVEL_ID, true); // u16 LE
  data[10] = DURATION_WEEKS; // u8

  return {
    programAddress: TXLINE_PROGRAM,
    accounts: [
      { address: user, role: AccountRole.WRITABLE_SIGNER },
      { address: pricingMatrix, role: AccountRole.READONLY },
      { address: TXL_MINT, role: AccountRole.READONLY },
      { address: userTokenAccount, role: AccountRole.WRITABLE },
      { address: treasuryVault, role: AccountRole.WRITABLE },
      { address: treasuryPda, role: AccountRole.READONLY },
      { address: TOKEN_2022_PROGRAM, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: ATA_PROGRAM, role: AccountRole.READONLY },
    ],
    data,
  };
}

/* ----------------------------------------------- simulate + send + confirm */
async function simulateOrExplain(
  signer: KeyPairSigner,
  ixs: Instruction[],
  label: string,
): Promise<void> {
  const { value: latestBlockhash } = await withRpc(
    `${label}: getLatestBlockhash`,
    (rpc) => rpc.getLatestBlockhash({ commitment: "confirmed" }).send(),
  );
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  const sim = await withRpc(`${label}: simulateTransaction`, (rpc) =>
    rpc
      .simulateTransaction(wire, {
        encoding: "base64",
        commitment: "confirmed",
        replaceRecentBlockhash: false,
        sigVerify: true,
      })
      .send(),
  );
  if (sim.value.err) {
    console.error(`    ${label} SIMULATION FAILED: ${JSON.stringify(sim.value.err)}`);
    for (const l of sim.value.logs ?? []) console.error(`      ${l}`);
    await explainPricing();
    throw new Error(`${label} simulation failed: ${JSON.stringify(sim.value.err)}`);
  }
  console.log(
    `    ${label}: simulation OK (${sim.value.unitsConsumed ?? "?"} CU)`,
  );
}

/** On failure: decode the pricing matrix so the report shows what row 1 costs. */
async function explainPricing(): Promise<void> {
  try {
    const [pricingMatrix] = await getProgramDerivedAddress({
      programAddress: TXLINE_PROGRAM,
      seeds: [utf8.encode("pricing_matrix")],
    });
    const info = await withRpc("getAccountInfo(pricing_matrix)", (rpc) =>
      rpc.getAccountInfo(pricingMatrix, { encoding: "base64" }).send(),
    );
    if (!info.value) {
      console.error("    pricing_matrix account MISSING on devnet");
      return;
    }
    const bytes = getBase64Encoder().encode(info.value.data[0]);
    const view = new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
    // PricingMatrix: 8 disc | 32 admin | u32 vec len | ServiceRow[]
    // ServiceRow: u16 row_id | u64 price_per_week_token | u32 sampling | i16 | i16
    const len = view.getUint32(40, true);
    console.error(`    pricing_matrix rows (${len}):`);
    let off = 44;
    for (let i = 0; i < len; i++) {
      const rowId = view.getUint16(off, true);
      const price = view.getBigUint64(off + 2, true);
      const sampling = view.getUint32(off + 10, true);
      console.error(
        `      row_id=${rowId} price_per_week_token=${price} sampling_interval_sec=${sampling}`,
      );
      off += 18;
    }
  } catch (e) {
    console.error("    (could not decode pricing matrix)", e instanceof Error ? e.message : e);
  }
}

async function sendTx(
  signer: KeyPairSigner,
  ixs: Instruction[],
  label: string,
): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { value: latestBlockhash } = await withRpc(
      `${label}: getLatestBlockhash`,
      (rpc) => rpc.getLatestBlockhash({ commitment: "confirmed" }).send(),
    );
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const wire = getBase64EncodedWireTransaction(signed);
    const signature = getSignatureFromTransaction(signed);
    try {
      await withRpc(`${label}: sendTransaction`, (rpc) =>
        rpc
          .sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" })
          .send(),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("custom program error") || msg.includes("Custom")) throw e;
      if (attempt === 3) throw e;
      console.warn(`    ${label}: send attempt ${attempt} failed, rebuilding tx`);
      continue;
    }
    for (let i = 0; i < 75; i++) {
      const { value } = await withRpc(`${label}: getSignatureStatuses`, (rpc) =>
        rpc.getSignatureStatuses([signature]).send(),
      );
      const st = value[0];
      if (
        st &&
        (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")
      ) {
        if (st.err) throw new Error(`tx ${signature} failed: ${JSON.stringify(st.err)}`);
        console.log(`    tx ${label}: ${EXPLORER(signature)}`);
        return signature;
      }
      await sleep(1_000);
    }
    console.warn(`    ${label}: tx ${signature} expired unconfirmed, retrying`);
  }
  throw new Error(`${label}: could not land tx in 3 attempts`);
}

/* --------------------------------------------------------------- TxLINE API */
async function httpJson(
  method: "GET" | "POST",
  url: string,
  opts: { headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; json: unknown; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function jwtExpiry(jwt: string): string {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"),
    ) as { exp?: number };
    return payload.exp ? new Date(payload.exp * 1000).toISOString() : "unknown";
  } catch {
    return "unknown";
  }
}

async function getGuestJwt(): Promise<string> {
  const res = await httpJson("POST", `${API_ORIGIN}/auth/guest/start`);
  const token = (res.json as { token?: string } | null)?.token;
  if (res.status >= 300 || !token) {
    throw new Error(`guest/start failed (${res.status}): ${res.text.slice(0, 300)}`);
  }
  console.log(`    guest JWT ${mask(token)}, exp ${jwtExpiry(token)}`);
  return token;
}

/** ed25519 sign with node:crypto — PKCS8-wrap the keypair's 32-byte seed. */
function signActivationMessage(message: string, keypairBytes: Uint8Array): string {
  const seed = keypairBytes.slice(0, 32);
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(seed),
  ]);
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  // sanity: derived public key must equal the wallet pubkey (bytes 32..64)
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  const derivedPub = new Uint8Array(spki.subarray(spki.length - 32));
  const walletPub = keypairBytes.slice(32, 64);
  if (Buffer.compare(derivedPub, walletPub) !== 0) {
    throw new Error("derived ed25519 public key does not match wallet pubkey");
  }
  const sig = ed25519Sign(null, Buffer.from(message, "utf8"), key);
  return Buffer.from(sig).toString("base64");
}

async function activateToken(
  txSig: string,
  jwt: string,
  keypairBytes: Uint8Array,
): Promise<string> {
  const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
  const walletSignature = signActivationMessage(messageString, keypairBytes);
  const res = await httpJson("POST", `${API_ORIGIN}/api/token/activate`, {
    headers: { Authorization: `Bearer ${jwt}` },
    body: { txSig, walletSignature, leagues: SELECTED_LEAGUES },
  });
  if (res.status >= 300) {
    throw new Error(`token/activate failed (${res.status}): ${res.text.slice(0, 500)}`);
  }
  const j = res.json as { token?: string } | string | null;
  const apiToken = typeof j === "string" ? j : (j?.token ?? res.text);
  if (!apiToken || typeof apiToken !== "string") {
    throw new Error(`token/activate returned no token: ${res.text.slice(0, 300)}`);
  }
  console.log(`    apiToken ${mask(apiToken)}`);
  return apiToken;
}

/* ------------------------------------------------------------ verification */
function authHeaders(jwt: string, apiToken: string): Record<string, string> {
  return { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };
}

/** Recursively describe a JSON value's SHAPE (field names + types, no data). */
function shape(v: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (Array.isArray(v)) {
    return v.length === 0 ? "[] (empty)" : [`array(${v.length})`, shape(v[0], depth + 1)];
  }
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = shape(val, depth + 1);
    }
    return out;
  }
  if (typeof v === "string")
    return `string(${v.length})${v.length <= 24 ? `=${JSON.stringify(v)}` : `=${JSON.stringify(v.slice(0, 18))}…`}`;
  return `${typeof v}=${v}`;
}

/** Pick a fixture that has already kicked off (so historical/proof have data). */
async function discoverFixture(jwt: string, apiToken: string): Promise<number> {
  const res = await httpJson("GET", `${API_ORIGIN}/api/fixtures/snapshot`, {
    headers: authHeaders(jwt, apiToken),
  });
  if (res.status < 300 && Array.isArray(res.json)) {
    // Live devnet fields are PascalCase (FixtureId/StartTime/GameState) even
    // though the OpenAPI schemas are camelCase.
    const started = (res.json as Record<string, unknown>[])
      .filter((f) => Number(f.StartTime ?? f.startTime ?? Infinity) < Date.now())
      .sort((a, b) => Number(b.StartTime ?? 0) - Number(a.StartTime ?? 0));
    const pick = started[0];
    if (pick) {
      const id = Number(pick.FixtureId ?? pick.fixtureId);
      console.log(
        `    fixtures/snapshot: ${(res.json as unknown[]).length} fixtures; using started fixture ${id} (${pick.Participant1} vs ${pick.Participant2})`,
      );
      return id;
    }
  }
  console.log(
    `    fixtures/snapshot unusable (${res.status}) — falling back to ${FALLBACK_FIXTURE_ID}`,
  );
  return FALLBACK_FIXTURE_ID;
}

/**
 * `historical` answers as an SSE-framed TEXT body (`data:`/`id:` lines, one
 * JSON event per frame, PascalCase fields) — not a JSON array.
 * Returns { ok, lastSeq } (lastSeq feeds stat-validation's required `seq`).
 */
async function verifyHistorical(
  jwt: string,
  apiToken: string,
  fixtureId: number,
): Promise<{ ok: boolean; lastSeq: number }> {
  const url = `${API_ORIGIN}/api/scores/historical/${fixtureId}`;
  const res = await httpJson("GET", url, {
    headers: authHeaders(jwt, apiToken),
    timeoutMs: 60_000,
  });
  console.log(`    GET /api/scores/historical/${fixtureId} -> ${res.status}`);
  if (res.status >= 300) {
    console.log(`      body: ${res.text.slice(0, 300)}`);
    return { ok: false, lastSeq: -1 };
  }
  const events: Record<string, unknown>[] = [];
  for (const line of res.text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      events.push(JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }
  if (events.length === 0) {
    console.log(`      no events (body starts: ${res.text.slice(0, 120)})`);
    // 200 still proves the token authenticates.
    return { ok: true, lastSeq: -1 };
  }
  const last = events[events.length - 1];
  const lastSeq = Number(last.Seq ?? last.seq ?? -1);
  console.log(
    `      ${events.length} SSE-framed events, Seq 0..${lastSeq}, actions incl. ${[
      ...new Set(events.slice(-40).map((e) => e.Action)),
    ]
      .slice(0, 6)
      .join(", ")}`,
  );
  console.log("      last event shape:");
  console.log(JSON.stringify(shape(last), null, 2).replace(/^/gm, "      "));
  return { ok: true, lastSeq };
}

async function verifyStatValidation(
  jwt: string,
  apiToken: string,
  fixtureId: number,
  seq: number,
): Promise<void> {
  // `seq` is REQUIRED (OpenAPI /docs/docs.yaml) — omitting it 404s.
  const qs = `fixtureId=${fixtureId}&seq=${Math.max(seq, 0)}&statKey=1&statKey2=2`;
  const url = `${API_ORIGIN}/api/scores/stat-validation?${qs}`;
  const res = await httpJson("GET", url, { headers: authHeaders(jwt, apiToken) });
  console.log(`    GET /api/scores/stat-validation?${qs} -> ${res.status}`);
  if (res.status >= 300) {
    console.log(`      body: ${res.text.slice(0, 400)}`);
    return;
  }
  console.log("      response shape:");
  console.log(JSON.stringify(shape(res.json), null, 2).replace(/^/gm, "      "));
}

async function verifySse(jwt: string, apiToken: string): Promise<void> {
  const url = `${API_ORIGIN}/api/scores/stream`;
  console.log(`    GET /api/scores/stream (capture ${SSE_CAPTURE_MS / 1000}s)`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SSE_CAPTURE_MS);
  let frames = 0;
  try {
    const res = await fetch(url, {
      headers: { ...authHeaders(jwt, apiToken), accept: "text/event-stream" },
      signal: ctrl.signal,
    });
    console.log(`      status ${res.status}, content-type ${res.headers.get("content-type")}`);
    if (!res.ok || !res.body) {
      console.log(`      body: ${(await res.text()).slice(0, 300)}`);
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (!frame) continue;
        frames++;
        if (frames <= 2) {
          console.log(`      raw frame ${frames}:`);
          console.log(frame.slice(0, 1_500).replace(/^/gm, "        "));
        }
        if (frames >= 2) {
          ctrl.abort();
        }
      }
    }
  } catch (e) {
    if (!(e instanceof Error && e.name === "AbortError")) {
      console.log(`      stream error: ${e instanceof Error ? e.message : e}`);
    }
  } finally {
    clearTimeout(timer);
  }
  console.log(`      frames captured: ${frames}${frames === 0 ? " (quiet — likely off match hours, OK)" : ""}`);
}

/* -------------------------------------------------------------- .env write */
function upsertEnvVar(content: string, key: string, value: string): string {
  const line = `${key}="${value}"`;
  const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
  if (re.test(content)) return content.replace(re, line);
  return `${content.replace(/\n*$/, "\n")}${line}\n`;
}

async function persistEnv(apiToken: string, guestJwt: string): Promise<string> {
  let content: string;
  let created = false;
  if (existsSync(KEEPER_ENV)) {
    content = await readFile(KEEPER_ENV, "utf8");
  } else {
    content = await readFile(KEEPER_ENV_EXAMPLE, "utf8");
    created = true;
  }
  // devnet API origin — .env.example defaults to the MAINNET host.
  content = upsertEnvVar(content, "TXLINE_BASE_URL", API_ORIGIN);
  content = upsertEnvVar(content, "TXLINE_API_TOKEN", apiToken);
  // Guest JWT is fetched at runtime by the keeper (auth.ts); persisted only
  // as a convenience for curl debugging. Expiry noted below.
  content = upsertEnvVar(content, "TXLINE_GUEST_JWT", guestJwt);
  const note = `# TXLINE_GUEST_JWT expires ${jwtExpiry(guestJwt)} (keeper refreshes its own at runtime)`;
  if (!content.includes("# TXLINE_GUEST_JWT expires")) {
    content = content.replace(/^TXLINE_GUEST_JWT=/m, `${note}\nTXLINE_GUEST_JWT=`);
  } else {
    content = content.replace(/^# TXLINE_GUEST_JWT expires.*$/m, note);
  }
  await mkdir(dirname(KEEPER_ENV), { recursive: true });
  await writeFile(KEEPER_ENV, content, "utf8");
  return created ? `created ${KEEPER_ENV} from .env.example` : `updated ${KEEPER_ENV}`;
}

async function readExistingToken(): Promise<string | undefined> {
  if (!existsSync(KEEPER_ENV)) return undefined;
  const content = await readFile(KEEPER_ENV, "utf8");
  const m = content.match(/^\s*TXLINE_API_TOKEN="?([^"\n]+)"?\s*$/m);
  return m?.[1];
}

/* ------------------------------------------------------------------ main */
async function main() {
  const keypairBytes = new Uint8Array(JSON.parse(await readFile(KEYPAIR_PATH, "utf8")));
  const signer = await createKeyPairSignerFromBytes(keypairBytes);
  console.log(`wallet:     ${signer.address}`);
  console.log(`api origin: ${API_ORIGIN} (devnet)`);

  console.log("\n==> guest JWT");
  const jwt = await getGuestJwt();

  // ---- idempotency: reuse a still-working token ----
  let apiToken = FORCE ? undefined : await readExistingToken();
  if (apiToken) {
    console.log(`\n==> existing TXLINE_API_TOKEN ${mask(apiToken)} — verifying`);
    const probe = await httpJson("GET", `${API_ORIGIN}/api/fixtures/snapshot`, {
      headers: authHeaders(jwt, apiToken),
    });
    if (probe.status < 300) {
      console.log("    still valid — skipping subscribe/activate (FORCE=1 to redo)");
    } else {
      console.log(`    stale/invalid (${probe.status}) — redoing the full flow`);
      apiToken = undefined;
    }
  }

  if (!apiToken) {
    // ---- on-chain subscribe (free tier) ----
    console.log(`\n==> subscribe(service_level_id=${SERVICE_LEVEL_ID}, weeks=${DURATION_WEEKS}) on devnet`);
    const userTxlAta = await findAta(signer.address, TXL_MINT, TOKEN_2022_PROGRAM);
    const ixs: Instruction[] = [
      // subscribe CPIs Thaw/Transfer/Freeze on this ATA even at price 0 —
      // it must exist; CreateIdempotent is a no-op when it already does.
      buildCreateAtaIdempotentIx(
        signer.address,
        userTxlAta,
        signer.address,
        TXL_MINT,
        TOKEN_2022_PROGRAM,
      ),
      await buildSubscribeIx(signer.address),
    ];
    await simulateOrExplain(signer, ixs, "subscribe");
    const txSig = await sendTx(signer, ixs, "subscribe");
    console.log(`    subscribed: ${txSig}`);

    // ---- activate ----
    console.log("\n==> activate API token");
    apiToken = await activateToken(txSig, jwt, keypairBytes);
  }

  // ---- verify end-to-end ----
  console.log("\n==> verify: discover a played fixture");
  let fixtureId = await discoverFixture(jwt, apiToken);
  console.log("\n==> verify: historical scores");
  let { lastSeq } = await verifyHistorical(jwt, apiToken, fixtureId);
  if (lastSeq < 0 && fixtureId !== FALLBACK_FIXTURE_ID) {
    // In-play fixtures have an empty historical body; use a finished one.
    console.log(`    empty history (fixture likely in play) — retrying with ${FALLBACK_FIXTURE_ID}`);
    fixtureId = FALLBACK_FIXTURE_ID;
    ({ lastSeq } = await verifyHistorical(jwt, apiToken, fixtureId));
  }
  console.log("\n==> verify: stat-validation proof");
  await verifyStatValidation(jwt, apiToken, fixtureId, lastSeq);
  console.log("\n==> verify: SSE stream");
  await verifySse(jwt, apiToken);

  // ---- persist ----
  console.log("\n==> persist");
  const note = await persistEnv(apiToken, jwt);
  console.log(`    ${note}`);
  console.log(`    TXLINE_API_TOKEN=${mask(apiToken)}`);
  console.log(`    TXLINE_BASE_URL=${API_ORIGIN}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\naborted:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
