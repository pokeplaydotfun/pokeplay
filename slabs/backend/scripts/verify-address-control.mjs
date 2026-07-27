#!/usr/bin/env node
/**
 * Prove that a given address is controlled by whoever holds its key, BEFORE we hand it
 * irreversible ownership of the contracts.
 *
 * These contracts use single-step OpenZeppelin Ownable. transferOwnership takes effect the
 * instant it lands, with no acceptOwnership step to catch a mistake. So the one failure that
 * matters — pointing ownership at an address nobody can sign from (a typo, a wrong-chain
 * address, a watch-only import) — has to be ruled out here, not discovered later when it is
 * unfixable.
 *
 * The cold wallet signs the exact challenge below. This script recovers the signer from that
 * signature and confirms it equals the address we are about to transfer to. A match proves
 * both that the address is real and that its key is in hand. No private key is entered here.
 *
 *   node script/verify-address-control.mjs <address> <signature>
 *
 * Get the signature from the cold wallet itself — a hardware wallet's "sign message", a
 * wallet app's personal_sign, or:  cast wallet sign --ledger "<challenge>"
 */

import { recoverMessageAddress, isAddress, getAddress } from "viem";

// A fixed, purpose-specific challenge. It names what signing it authorises, so it can never be
// a signature the user was tricked into producing for something else.
const CHALLENGE = "PWA: I control this wallet and intend it to own the PWA contracts.";

const [, , addrArg, signature] = process.argv;

if (!addrArg || !signature) {
  console.error("usage: node script/verify-address-control.mjs <address> <signature>");
  console.error(`\nHave the cold wallet sign this exact message:\n  ${CHALLENGE}`);
  process.exit(2);
}

if (!isAddress(addrArg)) {
  console.error(`not a valid address: ${addrArg}`);
  process.exit(1);
}

const claimed = getAddress(addrArg);

let recovered;
try {
  recovered = await recoverMessageAddress({ message: CHALLENGE, signature });
} catch (err) {
  console.error(`could not recover a signer from that signature: ${err.message}`);
  console.error("Make sure it signed the challenge EXACTLY, with no trailing newline.");
  process.exit(1);
}

if (getAddress(recovered) !== claimed) {
  console.error("MISMATCH — do NOT transfer ownership to this address.");
  console.error(`  you gave:        ${claimed}`);
  console.error(`  signature is by: ${getAddress(recovered)}`);
  console.error("Either the address is wrong or the signature came from a different wallet.");
  process.exit(1);
}

console.log("VERIFIED — this address signed the challenge, so its key is in hand.");
console.log(`  ${claimed}`);
console.log("Safe to use as the new contract owner.");
