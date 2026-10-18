# Deployment

The repository root contains the static app and Node.js production service. Copy `.env.example` to `.env` for local use; the server loads it automatically. Use Node 20 or newer:

```sh
npm install
npm start
```

Express serves the app, account APIs, and live market-data APIs from one origin. PostgreSQL tables and migrations are applied at startup. Keep database and password secrets outside source control.

## Environment

Required: `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD_SALT`, and `ADMIN_PASSWORD_HASH`. `PORT` is supplied by the host. `SESSION_TTL_HOURS` defaults to 168.

Set `STAFF_EMAILS` to a comma-separated allowlist of selected staff email addresses. Public registration never grants staff access: first verify and register the person, add their email to this allowlist, then grant the staff role from the admin account-management screen. Both the database role and email allowlist are required for staff API access. Staff can review deposits, withdrawals, and withdrawal-wallet changes; only the admin can manage account status or grant/revoke staff roles. Remove an email from the allowlist to revoke staff API access.

Deposits are enabled by default. Set `ENABLE_CRYPTO_DEPOSITS=false` to pause them. Public receiving addresses default to the three addresses supplied for this project and can be overridden with:

- `DEPOSIT_ADDRESS_BNB_BEP20` for USDT on BNB Smart Chain (BEP-20)
- `DEPOSIT_ADDRESS_USDT_TRC20` for USDT on TRON
- `DEPOSIT_ADDRESS_BTC` for BTC on Bitcoin

The server validates these addresses at startup. The public addresses are not secrets. Never store a wallet seed phrase or private key in the repository or environment variables used by this app.

Generate the admin password hash locally with Node. Replace the example password and keep the output private:

```sh
node --input-type=module -e 'import crypto from "node:crypto"; import {promisify} from "node:util"; const scrypt=promisify(crypto.scrypt); const password=process.argv[1]; const salt=crypto.randomBytes(24).toString("hex"); const hash=(await scrypt(password,salt,64)).toString("hex"); console.log(JSON.stringify({ADMIN_PASSWORD_SALT:salt,ADMIN_PASSWORD_HASH:hash},null,2));' 'REPLACE_WITH_A_LONG_PASSWORD'
```

User login passwords and withdrawal PINs are scrypt-hashed. Session tokens are random and only SHA-256 digests are stored in PostgreSQL. The admin account is provisioned on its first successful sign-in.

## Fund Operations

Deposits are real requests tied to the configured receiving address and a unique network transaction hash. The account is credited only after an authorized admin/staff member independently verifies the on-chain transfer and enters the verified USDT credit. Each credit is committed atomically to the account and immutable deposit ledger.

Withdrawals reserve the requested USDT value from the user's deposit balance inside a database transaction. First-time withdrawal wallets and all wallet changes require staff review. Users authorize requests with a separate six-digit PIN; five incorrect attempts lock the PIN for 30 minutes. Staff must send the transfer from the relevant wallet outside this app, then record the actual sent asset amount and on-chain payout hash. Rejecting a request refunds the reserved balance atomically. The app does not custody signing keys or broadcast transactions itself.

Bitcoin-network requests are BTC transfers. The user requests a USDT value; the staff member enters the actual BTC amount sent when recording the payout. BNB Chain and TRON payouts use USDT. The app checks transaction-hash format and uniqueness but does not independently verify chain confirmations, token contract, amount, or destination. Staff must verify these using trusted network tooling before approving or recording any transfer.

## Remaining API Scope

Registration/login/logout, password change, account/preferences, wallet/PIN security, deposit requests/review, withdrawal requests/review/refund, account status management, wallet-change review, and market quotes/history use real server APIs and PostgreSQL. Arbitrary admin balance edits are blocked; balance changes only occur through audited fund operations.

Investment plans, earnings accrual/redemption, rewards, custom plans, account recovery, and account deletion are not implemented as production APIs. The investment catalog remains illustrative and does not buy or hold assets. Do not describe those operations as real investments or returns.

## Hosting

Set the repository root as the Node service directory, use `npm install` to install and `npm start` to run, attach PostgreSQL, and configure the environment above. Runtime API calls are same-origin `/api/*`; no external service URL is hard-coded in the frontend.
