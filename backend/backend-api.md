# Backend API

The root `package.json` starts `render-backend/server.js`; that service serves the static site and same-origin APIs. Account, deposit, withdrawal, and ledger state is PostgreSQL-backed. There is no browser mock or localStorage account fallback.

## Fund Operations

- `GET /api/deposit-addresses` returns the configured receiving addresses.
- `POST /api/deposits` submits amount, network, address, and transaction hash. A unique network/hash pair prevents duplicate requests.
- `POST /api/admin/deposits/:id/approve` atomically records the verified USDT credit and deposit ledger row; `/reject` records rejection without credit.
- `POST /api/withdrawal-wallet` submits an initial wallet link or a change request. Initial links and changes await staff review.
- `PUT /api/auth/withdrawal-password` stores a separate six-digit scrypt hash after rechecking the login password.
- `POST /api/withdrawals` verifies the PIN and linked wallet, then atomically reserves the amount from the deposit balance.
- `POST /api/admin/withdrawals/:id/complete` records the actual payout asset amount and unique network transaction hash after an external transfer has been sent.
- `POST /api/admin/withdrawals/:id/reject` atomically returns reserved funds to the user's deposit balance.
- `POST /api/admin/wallet-change` approves or rejects a pending wallet change.

Admin and selected staff actions are authenticated server-side. Add a verified staff email to `STAFF_EMAILS`, then grant that existing account the staff role using the admin account screen. Both checks are required. Admins manage account status and staff roles; allowlisted staff can process fund and wallet-review queues. Balance edits through the general account endpoint are rejected.

Deposits are enabled by default to the configured addresses. BTC-network transfers are denominated in BTC; the staff member manually verifies the transfer and enters a USDT credit. Withdrawals reserve a USDT value; staff sends the external payout and records the actual asset amount and hash. The server never holds signing keys or broadcasts a payment, and it cannot independently verify chain confirmations. See `render-backend/README.md` for operational requirements.

## Other Features

Password recovery, investment contracts, earnings, rewards, custom plans, and account deletion remain unimplemented as production APIs. Investment screens are illustrative only. These are not presented as actual on-chain or investment operations.
