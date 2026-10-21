# Render backend: manual crypto deposits

This backend serves the app and its API from one Render web service, using PostgreSQL for persistent accounts and financial records. Connect the GitHub repository to Render, then use:

```sh
Build command: npm install && npm install pg && npm pkg set type=module
Start command: node render-backend/server.js
Health check path: /healthz
```

The build installs the PostgreSQL driver and ensures Node treats the existing ES-module server as a module. The repository already includes Express. Never commit a database URL, admin password, or private wallet key. `render.yaml` provides the same service configuration; its `sync: false` values must be set as Render environment variables. If the web service already exists, update its commands/environment instead of creating a duplicate service.

## Render environment

Set these in the Render service's Environment page:

- `DATABASE_URL`: link the Render PostgreSQL database to the service and use its **Internal Database URL**. The service ID `srv-db8j58ei0phs73frs08g` is not a connection URL.
- `ADMIN_EMAIL`: the admin login email.
- `ADMIN_PASSWORD_SALT`: random salt, at least 16 characters.
- `ADMIN_PASSWORD_HASH`: scrypt hash of the admin password, 128 lowercase hex characters.
- `DEPOSIT_ADDRESS_BNB_BEP20`, `DEPOSIT_ADDRESS_USDT_TRC20`, `DEPOSIT_ADDRESS_BTC`: required only when enabling deposits; set verified addresses for the corresponding networks.
- `ENABLE_CRYPTO_DEPOSITS`: defaults to `false`. Set to `true` only after the complete API, deposit review, and withdrawal/refund policy are ready; otherwise deposits stay disabled.
- `SESSION_TTL_HOURS` (optional; defaults to 168)

Generate an admin password salt and its scrypt hash locally with Node (replace the placeholder password; do not use this example password):

```sh
node --input-type=module -e 'import crypto from "node:crypto"; import {promisify} from "node:util"; const scrypt=promisify(crypto.scrypt); const password=process.argv[1]; const salt=crypto.randomBytes(24).toString("hex"); const hash=(await scrypt(password,salt,64)).toString("hex"); console.log(JSON.stringify({ADMIN_PASSWORD_SALT:salt,ADMIN_PASSWORD_HASH:hash},null,2));' 'YOUR_LONG_ADMIN_PASSWORD'
```

Set the two printed values as Render secrets. Use that same password to sign in with the configured admin email. User passwords are hashed with scrypt; sessions store only SHA-256 token digests.

## Deposit behavior

Supported assets are native BNB on BNB Smart Chain, USDT on TRON TRC-20, and BTC on Bitcoin. Requests are stored as `pending`; they do not change the account balance. The backend checks network-specific TXID shape and enforces a unique `(network, txid)`. This is an anti-duplicate check, not on-chain verification. The admin must independently verify destination, asset, amount, and confirmations using a trusted explorer.

The user enters the requested amount in USD (rounded to cents), selects a network and submits the transaction hash. New requests are marked as USD; historical requests keep their original crypto denomination. This is a requested USD value, not an on-chain conversion or verification. On approval the admin independently checks the transaction and enters the verified gross USDT amount. The API deducts the 1% platform fee, atomically credits the remaining 99%, records the net deposit-ledger amount, and writes the fee to `platform_fee_ledger`; duplicate reviews cannot credit twice. Rejected requests never credit a balance. The service does not hold signing keys or send cryptocurrency.

## Transaction and account behavior

The Render backend persists accounts, sessions, account activity, withdrawal-wallet changes, reward points, recovery keys and reset tokens in PostgreSQL. Passwords and recovery keys are scrypt-hashed; reset tokens are random, single-use, expire after 15 minutes, and revoke existing sessions. Balance-changing operations lock the account row and commit atomically. Administrator balance adjustments are recorded in the account activity history. Bulk account deletion is deliberately disabled to protect financial records.

Deposits stay pending until an administrator independently verifies the transaction, network, destination, amount and confirmations in a trusted explorer. The server validates transaction-hash shape and prevents duplicate `(network, txid)` submissions, but does not verify blockchain inclusion. An approved deposit records the verified gross USDT, deducts the 1% fee, and credits the net amount atomically. A withdrawal reserves the requested balance and remains pending until an administrator has sent the payout outside the app and records its transaction hash; rejection refunds the original balance bucket. Earnings withdrawals use a 4% fee; released plan capital uses a 20% fee. The service does not contain private signing keys and does not broadcast transfers.

Market prices are live reference quotes; plans are simulated portfolio valuations and do not place trades or acquire assets. Fees and account activity are persisted, but this is not a payment processor, exchange, bank, custody provider, or authorization to offer financial services. Crypto deposits remain disabled by default. Enable them only after setting verified wallet addresses in Render, deploying this backend, verifying the database and administrator account, and completing a controlled end-to-end test. Browser-local mock accounts and balances are not migrated. Never deploy the legacy mock backend as the production financial API.
