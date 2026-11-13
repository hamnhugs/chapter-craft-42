// Coin packs sold in the Store. Server-side on purpose: the client names a
// pack id and nothing else — never an amount of money or a number of coins.
// Keep in step with COIN_PACKS in src/lib/coins.ts (display copy).

export interface CoinPack {
  id: string;
  name: string;
  coins: number;
  /** USD cents. */
  unit_amount: number;
}

export const COIN_PACKS: Record<string, CoinPack> = {
  pocketful: { id: "pocketful", name: "Pocketful of Coins", coins: 500, unit_amount: 299 },
  satchel: { id: "satchel", name: "Satchel of Coins", coins: 1200, unit_amount: 599 },
  chest: { id: "chest", name: "Chest of Coins", coins: 2800, unit_amount: 1199 },
  vault: { id: "vault", name: "Vault of Coins", coins: 6500, unit_amount: 2499 },
};
