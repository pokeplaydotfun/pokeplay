/**
 * Addresses that cannot be confused between chains.
 *
 * WHY THIS FILE EXISTS. Every address in this codebase was a bare `string`, and twice that let
 * a Robinhood Chain address reach code that wanted a Solana one:
 *
 *   - `cc.buildBuyback(mint, chain.operatorAddress)` sent the EVM operator address to
 *     Collector Crypt's Solana API. CC answered `400 Invalid altRecipient address` and the
 *     first live sell-back failed.
 *   - `owner !== chain.operatorAddress` compared a Solana owner against the EVM address. Those
 *     can never be equal, so every sell failure was read as a completed sale — production
 *     alerted "the card has LEFT our custody" while naming our own custody wallet.
 *
 * Both typechecked perfectly. Both passed the whole suite, because the fixtures held whichever
 * value the buggy line expected. Fixing the two instances does not stop the third: the shapes
 * are identical to the compiler, so nothing prevents the next one.
 *
 * Branding makes the mistake unrepresentable rather than merely absent. `EvmAddress` and
 * `SolanaAddress` are both strings at runtime and carry no cost, but they are not assignable
 * to one another, so handing either to the wrong side is now a compile error.
 */

declare const EVM_BRAND: unique symbol;
declare const SOLANA_BRAND: unique symbol;

/** A 0x-prefixed Robinhood Chain address. */
export type EvmAddress = string & { readonly [EVM_BRAND]: true };

/** A base58 Solana address. CASE-SENSITIVE — never lowercase one to compare it. */
export type SolanaAddress = string & { readonly [SOLANA_BRAND]: true };

/**
 * Assert a string is an EVM address and brand it.
 *
 * Deliberately validating rather than casting: a brand applied without a check is a lie the
 * compiler then enforces everywhere downstream.
 */
export function asEvmAddress(value: string, context = "address"): EvmAddress {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${context} is not an EVM address: ${JSON.stringify(value)}`);
  }
  return value as EvmAddress;
}

/**
 * Assert a string is a Solana address and brand it.
 *
 * Base58 is 32–44 characters and excludes 0, O, I and l. A 0x prefix is the specific mistake
 * this exists to catch, so it is named in the error rather than lumped in with "invalid".
 */
export function asSolanaAddress(value: string, context = "address"): SolanaAddress {
  if (value.startsWith("0x")) {
    throw new Error(
      `${context} is an EVM address where a Solana one belongs: ${JSON.stringify(value)}. ` +
        `This is the mistake that broke the first live sell-back.`,
    );
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    throw new Error(`${context} is not a Solana address: ${JSON.stringify(value)}`);
  }
  return value as SolanaAddress;
}
