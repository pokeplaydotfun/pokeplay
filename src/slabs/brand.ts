/**
 * Brand identity, per deployment.
 *
 * One codebase now ships more than one product, so the name is configuration
 * rather than a literal. There are TWO distinct values here and conflating them
 * breaks things in different ways.
 *
 *  - BRAND_NAME is display copy. Safe to change at any time; the worst outcome
 *    of getting it wrong is that the page says the wrong word.
 *
 *  - SIGNING_NS is protocol. It is the prefix of messages the user signs with
 *    their wallet, and the backend re-derives the identical string to verify
 *    the signature. Frontend and backend must agree byte for byte.
 */

/** Display name. Appears in the nav, the footer, page titles and body copy. */
export const BRAND_NAME: string = import.meta.env.VITE_BRAND_NAME || "Slabs";

/**
 * The full name, for pages that title themselves with it.
 *
 * Separate from BRAND_NAME rather than replacing it: "Pokémon World Assets" is right as a
 * page heading and wrong in a nav bar or mid-sentence, and one string cannot be both.
 */
export const BRAND_FULL: string = import.meta.env.VITE_BRAND_FULL || "Slabs";

/**
 * Namespace for wallet-signed messages. NOT the display name, and deliberately
 * a separate variable rather than a reuse of BRAND_NAME.
 *
 * Two things depend on getting this right.
 *
 * 1. It must match the backend exactly. These messages are reconstructed
 *    server-side and checked against the signature:
 *
 *      backend/src/api/server.ts            set / read withdraw address
 *      backend/src/chains/solana-signature.ts   deposit -> mint the mirror
 *
 *    A mismatch is not a visible error. The signature simply fails to verify,
 *    so setting a withdraw address and depositing a card both break, and the
 *    UI has nothing useful to say about why. If you change this, change those
 *    three call sites in the same commit.
 *
 * 2. It must DIFFER between deployments. Two products sharing a prefix means a
 *    message signed for one verifies against the other — the signature carries
 *    no indication of which site asked for it. Domain separation is the whole
 *    reason this string exists rather than the messages starting bare.
 *
 * Defaults to "PWA" so the existing product keeps signing and verifying
 * exactly what it does today; the second product sets VITE_SIGNING_NS to its
 * own value and its backend .env must carry the matching one.
 */
export const SIGNING_NS: string = import.meta.env.VITE_SIGNING_NS || "Slabs";
