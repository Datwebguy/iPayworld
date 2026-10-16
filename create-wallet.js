import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const required = ["CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET"];
for (const name of required) {
  if (!process.env[name]?.trim()) throw new Error(`Missing ${name} in .env.`);
}

const client = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
});

const walletSetResponse = await client.createWalletSet({ name: "iPay Arc Testnet" });
const walletSet = walletSetResponse.data?.walletSet;
if (!walletSet?.id) throw new Error("Circle did not return a wallet-set ID.");

const walletResponse = await client.createWallets({
  walletSetId: walletSet.id,
  blockchains: ["ARC-TESTNET"],
  count: 1,
  accountType: "EOA",
});
const wallet = walletResponse.data?.wallets?.[0];
if (!wallet?.id || !wallet?.address) throw new Error("Circle did not return a wallet address.");

const record = {
  createdAt: new Date().toISOString(),
  walletSetId: walletSet.id,
  walletId: wallet.id,
  address: wallet.address,
  blockchain: wallet.blockchain ?? "ARC-TESTNET",
};
writeFileSync(resolve(".data", "circle-wallet.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });

const envPath = resolve(".env");
const env = readFileSync(envPath, "utf8");
const assignment = `CIRCLE_WALLET_ADDRESS=${wallet.address}`;
const nextEnv = /^CIRCLE_WALLET_ADDRESS=.*$/m.test(env)
  ? env.replace(/^CIRCLE_WALLET_ADDRESS=.*$/m, assignment)
  : `${env.trimEnd()}\n${assignment}\n`;
writeFileSync(envPath, nextEnv, { mode: 0o600 });

console.log(JSON.stringify(record, null, 2));
console.log("Saved CIRCLE_WALLET_ADDRESS to .env and .data/circle-wallet.json.");