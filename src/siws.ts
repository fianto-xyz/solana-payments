import type { SolanaCluster } from './solana.constants.js';

/** The only SIWS message version that exists. */
export const SIWS_VERSION = '1';

/** Every field of a Sign In With Solana message. All strings, rendered verbatim. */
export interface SiwsMessageFields {
  /** host[:port] of the app asking for the sign-in — the wallet checks it against the page's origin. */
  domain: string;
  address: string;
  statement: string;
  /** The app's origin. */
  uri: string;
  version: string;
  chainId: string;
  nonce: string;
  /** ISO 8601, exactly as issued (milliseconds and `Z` included). */
  issuedAt: string;
  expirationTime: string;
}

/**
 * A rendered field may not be longer than this. A sanity bound on the caller's own values — the
 * longest real field (a URI or a statement) has no business anywhere near it — not a business
 * rule, so one shared limit is enough.
 */
const MAX_SIWS_FIELD_LENGTH = 2048;

/**
 * `renderSiwsMessage` refuses a field containing any of these: a literal newline, its `\r`
 * sibling, or the Unicode line/paragraph separators U+2028 and U+2029 — some string handling
 * (browsers among them) treats the latter two as line breaks even where only `\n` is checked
 * for. Any of them would corrupt the line-based format this function builds.
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const FORBIDDEN_SIWS_LINE_BREAK = new RegExp(`[\\r\\n${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`);

/**
 * Throws a developer error — never returned to a caller — for a field this function cannot
 * safely render. The caller controls every one of these values (config, or a value already
 * validated before it reaches here); a field that fails this check is a bug in the caller, not
 * bad input to be tolerated.
 */
function assertRenderable(field: keyof SiwsMessageFields, value: string): void {
  if (FORBIDDEN_SIWS_LINE_BREAK.test(value)) {
    throw new Error(`renderSiwsMessage: field "${field}" contains a line break`);
  }
  if (value.length > MAX_SIWS_FIELD_LENGTH) {
    throw new Error(`renderSiwsMessage: field "${field}" is longer than ${MAX_SIWS_FIELD_LENGTH} characters`);
  }
}

/**
 * The SIWS text, in the order and with the separators the Wallet Standard's
 * `createSignInMessageText` uses when every one of these fields is supplied: the header line,
 * the address, a blank line, the statement, a blank line, then one `Key: value` line per
 * field. `solana:signIn` wallets build this text themselves from the same input, so a
 * verifier can demand the signed bytes equal its own rendering — every field checked at once.
 *
 * An empty `statement` omits the statement block entirely (header, address, one blank line,
 * straight to `URI:`), matching `createSignInMessageText`'s own behaviour for a falsy
 * statement, rather than rendering an empty paragraph.
 */
export function renderSiwsMessage(fields: SiwsMessageFields): string {
  for (const field of Object.keys(fields) as (keyof SiwsMessageFields)[]) {
    assertRenderable(field, fields[field]);
  }
  const lines = [`${fields.domain} wants you to sign in with your Solana account:`, fields.address, ''];
  if (fields.statement !== '') {
    lines.push(fields.statement, '');
  }
  lines.push(
    `URI: ${fields.uri}`,
    `Version: ${fields.version}`,
    `Chain ID: ${fields.chainId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
    `Expiration Time: ${fields.expirationTime}`,
  );
  return lines.join('\n');
}

/** The SIWS `Chain ID` for a cluster (the Wallet Standard short names). */
export function siwsChainId(cluster: SolanaCluster): 'mainnet' | 'devnet' | 'localnet' {
  return cluster === 'mainnet-beta' ? 'mainnet' : cluster;
}

/**
 * The nonce a signed SIWS message names, read BEFORE anything is trusted, only so the
 * verifier knows which stored challenge to consume. Null for anything that is not a line of
 * exactly `Nonce: ` followed by 8–64 letters and digits (SIWS requires at least 8).
 */
export function nonceOfSiwsMessage(text: string): string | null {
  const match = /^Nonce: ([A-Za-z0-9]{8,64})$/m.exec(text);
  return match ? match[1] : null;
}
