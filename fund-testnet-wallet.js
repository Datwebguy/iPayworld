import { readFileSync } from "node:fs";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const wallet = JSON.parse(readFileSync(".data/circle-wallet.json", "utf8"));
try {
  const client = initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET,
  });
  const response = await client.requestTestnetTokens({
    address: wallet.address,
    blockchain: "ARC-TESTNET",
    native: true,
    usdc: true,
  });
  console.log(`Circle faucet request accepted for ${wallet.address} (HTTP ${response.status}).`);
} catch (error) {
  const detail = error?.message || "Unknown faucet error";
  if (error?.status === 403) {
    throw new Error(`Circle's API faucet is not enabled for this API key. Fund ${wallet.address} at https://faucet.circle.com/ with Arc Testnet USDC and native gas, then rerun this command only if needed.`);
  }
  throw new Error(`Faucet request failed: ${detail}`);
}
