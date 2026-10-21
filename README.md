# expense-tracker-api

Private sync backend for the Expense Tracker app. NestJS + MongoDB, self-hosted, one account.

The app stays offline-first. This is a sync *peer*, not a dependency — if this box is down,
slow or gone, the app is indistinguishable from normal use.

## Running it

```bash
cp .env.example .env          # then fill in MONGO_USER, MONGO_PASSWORD, and two JWT secrets
docker compose up -d --build
```

`GET /health` returns `{"status":"ok"}` and nothing else.

### Accounts

There is no signup form that anyone can reach. An account is created by handing someone
the `SIGNUP_CODE` from `.env`:

```bash
# on the VPS
echo 'your-password' | docker compose run --rm -T api \
  node dist/users/bootstrap-user.js --email you@example.com
```

`-T` matters: without it Docker allocates a TTY and silently discards the piped password.

Then in the app: **Settings → Sync → Sign in or create an account**. Use **Create** with
the same code to make a new account, or **Sign in** for an existing one.

Locked out is an email now, not a code from the owner. `POST /auth/forgot-password` sends the
address an 8-digit code; `POST /auth/reset-password` takes that code with the new password.
The code expires after 15 minutes, works once, and the reset revokes every session that
account had.

Sending it needs `RESEND_API_KEY` and `MAIL_FROM` in `.env`, and Resend needs a sending
domain you have verified. Leave either unset and both routes still answer normally — no mail
goes out and nothing says so.

## Tests

```bash
pnpm test          # contract tests against a real mongod (mongodb-memory-server)
npx tsc --noEmit
```

## The API

| | |
|---|---|
| `GET /health` | Liveness only. No version, no uptime, no DB round trip. |
| `POST /auth/register` | `{ email, password, code }` — closed unless `SIGNUP_CODE` is set |
| `POST /auth/forgot-password` | `{ email }` — always 200; mails a code if mail is configured |
| `POST /auth/reset-password` | `{ email, code, newPassword }` — 204, or 401 on a bad, expired or used code |
| `POST /auth/login` | `{ email, password, deviceId?, deviceName?, platform? }` |
| `POST /auth/refresh` | `{ refreshToken }` — rotating; the old one stops working |
| `POST /auth/logout` | `{ refreshToken }` — idempotent |
| `POST /sync` | `{ deviceId, cursor?, expenses[], budgets[], exclusions[] }` |
| `POST /sms` | `{ body, receivedAt? }` — raw bank SMS from an iOS Shortcut |

`register` answers 401 when `SIGNUP_CODE` is not configured, so an outsider cannot tell
whether an operator ever enabled it. The reset routes answer identically for a known and an
unknown address — `forgot-password` is always 200 — so neither can be used to find out who
has an account.

The emailed code is 8 digits, expires after 15 minutes, and is consumed the first time it
works. Only `sha256(userId + ':' + code)` is stored, so it cannot be looked up and re-sent;
one per address per 60 seconds is allowed, which is a throttle on the inbox rather than on
the guessing.

### SMS without the app

`POST /sms` takes a raw bank SMS body, parses it with the same rules as the phone
(`src/sms/parse.ts`), dedupes on `(body, day)`, and writes an ordinary expense row that the
next `/sync` pulls to any device. It exists for an iOS Shortcut, since iOS gives no app
access to the inbox. A credit is stored with `isIncome` and never counts as a spend.

Authenticate it with `SMS_INGEST_TOKEN` (`Authorization: Bearer …`) rather than an access
token: those last 15 minutes and a Shortcut cannot refresh them. The token maps to the
account in `SMS_USER_EMAIL`. Both are optional; without them the route accepts only a
normal access token, which is fine for testing but not for an automation.

### Bulk statement SMS

A message holding several transactions (`Rs.500 debited at A; Rs.250 debited at B`) is
stored as one expense per transaction, not as one wrong row. Each transaction parsed
completely is its own row; rows after the first carry an indexed dedupe key (`body|day|n`)
— `src/sms/bulk.ts` names the scheme and `src/sms/parse.ts` must stay byte-identical to
the phone's copy. Rows pushed by a phone running the older single-transaction parser are
mended on the `/sync` push itself: the first transaction's fields are corrected in place
and the missing ones are minted, idempotently, so a re-push adds nothing. History already
in the database gets the same treatment once:

```bash
pnpm exec ts-node src/sms/repair-bulk.ts --email you@example.com   # dry run: counts only
pnpm exec ts-node src/sms/repair-bulk.ts --email you@example.com --apply
```

## How sync works

One cursor-based endpoint, not CRUD per resource.

- **Identity is `clientId`**, a UUID minted on the phone at insert time. The phone's local
  `id` is an autoincrement integer and two devices each mint id 5 for different expenses,
  so syncing on that would silently write one phone's merchant over the other's row.
- **Last write wins**, and it falls out of the server stamping `updatedAt` from its own
  clock on every write. A phone cannot set `updatedAt` — the DTO rejects it. A phone with a
  wrong clock therefore cannot win.
- **Idempotent.** Push is an upsert on `(userId, clientId)`, so re-pushing a row rewrites
  it with identical values. `(userId, dedupeKey)` is also unique, which makes a re-scanned
  SMS a no-op; when two devices capture the *same* SMS, the second push is reported in
  `duplicates` rather than 500-ing on the index.
- **Deletes are tombstones.** A row that vanished would break the cursor, so `deletedAt`
  is set and the row stays.
- **Echo suppression.** Rows pushed by this request are excluded from its own pull.
- **A device with no cursor gets its own history back**, which is how a reinstall recovers.

## Layout

```
src/
  config/env.ts          validated once at boot; a missing secret stops the process
  logging/               SafeLogger — rawSms is never logged
  health/
  users/                 schema, service, bootstrap-user script
  devices/               one doc per phone; bounds a leaked token's blast radius
  auth/                  argon2id, JWT, rotating refresh tokens, hand-rolled guard
  sync/                  the one endpoint, its schemas, and the contract tests
  sms/                   POST /sms: a ported parser for the no-app iOS Shortcut path
```

## Security notes

- Argon2id at the OWASP baseline (19 MiB / 2 passes).
- The signup code is compared with `crypto.timingSafeEqual`, and **before** the password is
  ever hashed. Checking it afterwards would make `/auth/register` a free ~50ms-CPU
  password-hashing endpoint for anyone who can reach the URL.
- Resetting a password revokes every session that account had. Otherwise a refresh token
  stolen beforehand survives for its full 30 days and the reset bought nothing.
- Refresh tokens stored as SHA-256 digests. They are random values, so there is nothing to
  brute-force; a database leak cannot be replayed as a token.
- `rawSms` is never logged — `SafeLogger` redacts by key name, so a new call site cannot
  leak a message body by accident.
- `SMS_INGEST_TOKEN` is compared with `crypto.timingSafeEqual` and stays valid until it is
  rotated. It only opens `/sms`, not `/sync` or the auth routes.
- Helmet, an explicit CORS allowlist, a 4 MB body cap, and a global `ValidationPipe` with
  `forbidNonWhitelisted`.
- `/health` is public and says nothing.

### Known limits

- **No rate limiting.** `/auth/login` was already unthrottled, and the reset code space is 8
  digits with a 15-minute window as the only thing bounding a guess. The 60-second cooldown
  keeps an inbox from filling up; it is not a limiter. Caddy adds no limiter by default.
- **No email verification.** Anyone holding `SIGNUP_CODE` can register an address that
  someone else wants, including yours, and the unique index then blocks the real owner.
  Give the code only to people you would hand your server to.
- **The owner has no override.** `RESET_CODE` was removed rather than kept as a back door, so
  a wrong address or a Resend outage leaves the account unreachable without hand-editing the
  database. That was the deliberate trade for not holding a second secret.

## Deploying

One box, two containers, TLS in front.

```bash
cp .env.example .env
# MONGO_USER, MONGO_PASSWORD, JWT_SECRET, JWT_REFRESH_SECRET — four openssl rand -hex 32
# plus SIGNUP_CODE, one more, so accounts can be made. RESEND_API_KEY and MAIL_FROM are
# optional, but without both, password reset sends nothing and says 200 anyway
docker compose up -d --build
echo 'the password' | docker compose run --rm -T api \
  node dist/users/bootstrap-user.js --email you@example.com
sudo cp ops/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

- The API is published to `127.0.0.1:3000` only. Caddy is the only thing that reaches it.
- Mongo auth is on and its port is never published. The healthcheck carries credentials,
  because an unauthenticated ping reports a dead database.
- Firewall: 22, 80, 443. Nothing else.

### Backups

```bash
ops/backup.sh          # nightly via cron
ops/restore-test.sh    # restores into a throwaway container and checks it
```

**Run the restore test on a schedule, not once.** It compares row counts *and* index specs
against the live database, because a restore that brings back the rows but not the unique
indexes produces a database that looks healthy and quietly accepts the same bank SMS
twice. It never touches the live database or the `mongo-data` volume.

Sync `backups/` off the box. A backup on the same disk as the database is not a backup.

### Verified, and verified how

`verify-ops.ps1` runs the exact mongo commands both scripts use, against two authenticated
mongods — because the bash scripts themselves cannot run on Windows. It caught four real
problems: MongoDB 8 dropped the positional `mongodump <db>` form, `mongorestore` deprecates
`--db` in favour of `--nsInclude`, `getIndexes()` throws on a collection that does not
exist, and PowerShell's `>` silently corrupts a binary gzip stream.

## Not built yet

A Caddyfile and backup scripts are written but **have never run on a Linux host** — there
is no VPS here. First deploy is where those get their real test.