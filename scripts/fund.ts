/**
 * fund.ts - fund a testnet account with native QOR from the deployer.
 *
 * Usage (testnet only):
 *   tsx --env-file=.env scripts/fund.ts <cosmos-address> <amount-uqor>
 *
 * Example: 1 QOR = 1000000 uqor.
 * Prints the transaction hash and exits non-zero unless accepted (code 0).
 */
import { deriveAccount, fundNative } from "./qore.js";

async function main(): Promise<void> {
  const network = process.env.QORE_NETWORK ?? "testnet";
  if (network !== "testnet") throw new Error(`Refusing to run on network "${network}": this script is testnet-only.`);
  const to = process.argv[2]?.trim();
  const amount = process.argv[3]?.trim();
  if (!to || !/^qor1[0-9a-z]{38}$/.test(to)) throw new Error("Usage: fund.ts <qor1... address> <amount-uqor>");
  if (!amount || !/^[0-9]+$/.test(amount)) throw new Error("Usage: fund.ts <qor1... address> <amount-uqor>");
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("Set QORE_MNEMONIC in .env");

  const acc = await deriveAccount(mnemonic);
  console.log(`from: ${acc.evm} (${acc.cosmos})`);
  console.log(`to:   ${to} (${(Number(amount) / 1_000_000).toFixed(6)} QOR)`);
  const hash = await fundNative(acc, to, BigInt(amount));
  console.log(`fund tx: ${hash}`);
  console.log("code: 0");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
