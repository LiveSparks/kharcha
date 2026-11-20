# WF-1 — Data model for accounts and aliases

label: `wayfinder:grilling`
status: closed
blocked-by: (none — frontier ticket)

## Question

How do Account and Alias map onto the existing ledger schema, concretely?

- An Account is keyed by issuing bank + last digits. Where does it live: a new `accounts`
  table, or inferred lazily from distinct (sender-family, account_last4) pairs in the ledger?
  A card (e.g. ICICI `*6119`) is its own account even though a bank account funds it — how is
  that modeled so balance tracking per card works?
- An Alias binds a friendly name to a Payee key (`merchant` string or `counterpartyLast4`) or
  to an Account. One table or two? What is the canonical join key, given last-4 collisions are
  possible within one bank?
- Retroactive renaming: when the user names a payee "Zomato food" after 50 rows exist, do old
  rows resolve via alias on read (cheap, no write) or via one-time backfill (materialized)?
- How does the masked-counterparty association work in practice: user pays `a/c **5280`
  monthly — what does the user see and name before any alias exists?
- Composite-key collision policy when two counterparties share a last-4 at the same bank.

Resolution is a written decision (schema shape + read/write semantics), ready to implement.

## Decision (closed 2026-11-20)

Grilled with the operator; all four options below were chosen explicitly.

### Facts found in the code (mobile/src/lib)

- `transactions` has no bank/issuer column: only the raw `sender` address and `account_last4`.
  Bank identity has to be derived from the matching sender rule at ingest.
- `counterpartyMasked` is produced by the parser but **not persisted**. The row mapper in
  `database.ts` hard-codes it to `null`; only `counterparty_last4` is stored.
- Masked-transfer shapes return `merchant: null`, so the payee key for those rows is the
  counterparty, not the merchant string.
- Schema setup is `CREATE TABLE IF NOT EXISTS` with no versioning. Adding columns needs a
  migration step (`PRAGMA user_version`).
- Reconciliation evidence: 20 SMS rows on `*8812` didn't match because `*8812` is the
  HDFC debit card whose POS spends post to account `*3391` ("POS 400000XXXXXX8812 …" in the
  3391 statement).

### Schema

```sql
CREATE TABLE accounts (
  id          TEXT PRIMARY KEY,
  bank        TEXT NOT NULL,            -- bank family code from the sender rule (HDFC, ICICI, PNB, SBI)
  last4       TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('bank','credit_card','debit_card','unknown')),
  funded_by   TEXT REFERENCES accounts(id),  -- debit_card → its bank account; NULL otherwise
  name        TEXT,                     -- alias; NULL = show default label
  created_at  INTEGER NOT NULL,
  UNIQUE (bank, last4)
);

CREATE TABLE payees (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('merchant','masked')),
  bank        TEXT NOT NULL DEFAULT '', -- masked: bank family of the debited/credited account; merchant: ''
  key         TEXT NOT NULL,            -- merchant: normalized merchant string; masked: counterparty last4
  masked      TEXT,                     -- verbatim mask as first seen ("**5280"), for display
  name        TEXT,                     -- alias; NULL = show default label
  created_at  INTEGER NOT NULL,
  UNIQUE (kind, bank, key)
);

-- transactions gains:
--   account_id          TEXT REFERENCES accounts(id)   -- NULL when the SMS carries no last4
--   payee_id            TEXT REFERENCES payees(id)     -- resolved at ingest from the parser key
--   payee_override_id   TEXT REFERENCES payees(id)     -- per-row user reassignment (collision escape hatch)
--   counterparty_masked TEXT                           -- persist what the parser already emits
-- `merchant`, `account_last4`, `counterparty_last4` stay as the parser's raw output, never rewritten.
```

There are two alias tables rather than one polymorphic `aliases` table, because accounts carry
structure that payees don't (`kind`, `funded_by`, and balance state later in WF-4). The alias is
the `name` column on each table.

### Read/write semantics

- **Ingest:** derive `bank` from the matched sender rule, upsert `accounts(bank, last4)` with
  `kind` inferred from the SMS shape (card-spend shapes → card, else `bank`, else
  `unknown`), and upsert the payee under the key from `normalize(merchant)`, or under
  `('masked', bank, counterparty_last4)` when merchant is null. Write both ids on the row.
- **Renaming past rows: resolved on read.** Display name =
  `COALESCE(override_payee.name, payee.name, default_label)`. A rename is a single `UPDATE`
  on `payees`/`accounts` and covers past and future rows alike. Nothing is backfilled, and
  `merchant` keeps the parser's value, so a rename can always be undone.
- **Default labels before any alias exists:** merchant payee → the merchant string; masked
  payee → `a/c **5280 · HDFC`; account → `HDFC ••3391` / `ICICI card ••6119`. Where the
  "name this" prompt appears is WF-3's call.
- **Debit cards:** `kind='debit_card'` with `funded_by` → the bank account. Balance (WF-4)
  rolls card spends into the funding account, and the transaction still shows the card. The
  link is user-confirmed, because SMS doesn't state it. The app may suggest it (same bank,
  card spends with no matching bank-account SMS), but never sets it silently. Credit cards
  are standalone accounts.
- **Last-4 collisions:** same `(kind, bank, key)` means the same payee by default. The user
  can reassign a single transaction via `payee_override_id`, either to an existing payee or
  to a new one created with the same key plus a disambiguating name. Because of this, the
  `UNIQUE` constraint applies only to auto-resolved payees. Payees created by an override get
  `key = '<last4>#<n>'` so they never capture new ingests. Later ingests still resolve to the
  default payee, and the duplicate/review flow (WF-5) is where any mis-assignment surfaces.
- **Migration:** add `PRAGMA user_version` versioning. v1→v2 creates both tables, adds the
  columns, and backfills `account_id`/`payee_id` from existing rows in one transaction. This is
  a one-time build of the identity tables, not a rewrite of display data.

### Hand-offs

- WF-3: where naming surfaces (default labels above are the pre-alias state).
- WF-4: balance per `accounts` row; debit cards roll up through `funded_by`.
- WF-5: duplicate review and payee overrides share the same review surface.
- WF-6/7: Schedule/Pattern detection groups by the *effective* payee
  (`COALESCE(payee_override_id, payee_id)`), not the raw merchant string.
