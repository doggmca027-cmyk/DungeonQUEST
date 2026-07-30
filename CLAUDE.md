# Rules for Claude: DungeonQuest

- **UI:** Amber background (`bg-theme-bg`), Light Beige Cards (`bg-theme-card`), rounded corners (`rounded-2xl`).
- **Stack:** React, Vite, Tailwind, Supabase, TON Connect (@tonconnect/ui-react), Telegram SDK (@twa-dev/sdk).
- **Wallet & Payments:**
  - Deposit TON to `VITE_PROJECT_WALLET_ADDRESS` via TON Connect transaction.
  - Convert TON to internal `gram_balance` in Supabase upon successful transaction payload.
- **Logic:**
  - Withdrawals: min 0.5 GRAM, 10% fee. Status `pending` for admin manual processing.
  - Dungeons: 1, 2, 5, 10, 15, 20, 25, 50 TON/GRAM.
  - Multi-expeditions grouped into 1 card per dungeon. Claim button active only when ALL 12h timers complete.
  - Season Reset: calls RPC `reset_season()`.
