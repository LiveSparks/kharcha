# WF-3 — Naming UX: where naming surfaces and how it propagates

label: `wayfinder:prototype`
status: closed
blocked-by: WF-1-data-model-accounts-aliases.md

## Question

How does the user actually name things? The operator's stated flow: "come in once in a while
and name a payee a more human friendly name and that name gets associated with that payee
everywhere". Decisions to settle:

- Where does naming surface: on the transaction detail screen, from the inbox, from a dedicated
  "unnamed counterparties" list, or all of these? What does the user see for an unnamed payee
  today (raw merchant, masked `**5280`, or "Unknown")?
- Bulk naming: from the transaction detail only, or also from a grouped "top payees" list where
  one action names many rows?
- Account naming: same flow as payees, or a separate accounts screen (needed for balance
  tracking anyway)?
- What the user confirms when creating an alias: name only, or name + category?

Prototype the flow as cheap UI stubs before locking the spec.

## Decision (closed 2026-11-20)

Prototyped as three UI stubs (transaction detail, name sheet, payees list) and grilled with
the operator. The operator chose the recommended option on three questions and asked for
both nudge styles on the fourth.

### Facts found in the code (mobile/src/app)

- `transaction/[id].tsx` has a free-text "Name or place" field that rewrites `merchant` on one
  row via `setTransaction`. That breaks WF-1's rule that raw parser fields are never rewritten,
  so the field is replaced by the payee row below.
- "Paid from" renders `Account ··<last4>` straight from `accountLast4`; there is no account
  entity behind it yet.
- The inbox tab list omits `duplicate_review` even though the card actions handle it. That
  belongs to WF-5, not this ticket.

### Where naming surfaces

1. **Transaction detail:** a *Payee* row shows the effective payee's display name (the WF-1
   default label when unnamed, e.g. `a/c **5280 · HDFC`) with a *Name* action, or *Rename*
   once it has a name. A *Wrong payee? Move this one* row sets `payee_override_id` (WF-1's
   collision escape hatch). *Paid from* shows the account display name and opens the
   Accounts screen.
2. **Payees list:** a new screen. Unnamed payees come first, sorted by total spend
   descending, with count and total per row. Named payees follow alphabetically. One *Name*
   action covers every row with that payee. Entry point: a *Payees and accounts* item on the
   You tab, labelled with the unnamed count.
3. **Accounts screen:** a new screen listing `accounts` rows by bank and showing kind. It's
   where accounts get named and where the debit-card link is confirmed (a suggestion card:
   "*8812 looks like a debit card on HDFC ••3391 · Link"). WF-4 adds balances here. Reached
   from the Payees list and from *Paid from*.

### The name sheet

- **Name:** required, trimmed, 1–40 chars. Saving it writes `payees.name` or `accounts.name`;
  nothing on `transactions` changes.
- **Category:** optional, payees only. When set, it becomes the payee's default category,
  and rows resolve their category on read as
  `COALESCE(user-set row category, payee.category, parser category)`. Rows the user
  categorized by hand keep their category.
- The sheet states its reach: "Applies to N past and all future transactions", where N is
  the count of rows whose effective payee is this one.
- Renaming and clearing a name use the same sheet. Clearing sets the name to NULL and the
  default label comes back.

### Nudges

- **Passive:** an "N unnamed" count on the *Payees and accounts* entry. No notification.
- **Prompt after repeats:** when an unnamed payee gets its 3rd effective transaction, Home
  shows a one-time card: "You've paid a/c **5280 · HDFC 3 times. Name it?", with *Name* and
  *Not now* buttons. Either choice stamps the payee so the card never comes back for that
  payee. At most one such card shows at a time, picking the highest-spend candidate. Manual
  entries count toward the 3 like any other transaction.

### Schema amendments to WF-1

```sql
ALTER TABLE payees ADD COLUMN category TEXT;            -- default category; NULL = parser's
ALTER TABLE payees ADD COLUMN nudged_at INTEGER;        -- set when the Home card is shown and answered
ALTER TABLE transactions ADD COLUMN category_by_user INTEGER NOT NULL DEFAULT 0;
-- category_by_user = 1 when the user picked the row's category; such rows ignore payees.category.
-- Migration: rows with status='manual' start at 1; all others start at 0.
```

`setTransaction` splits into `setTransactionStatus`, `setTransactionCategory` (which sets
`category_by_user = 1`) and `movePayee` (which sets `payee_override_id`). `renamePayee` and
`renameAccount` live on the ledger provider.

### Hand-offs

- WF-4: balances render on the Accounts screen; card link confirmation is defined here.
- WF-5: the Home nudge card and the review queue should share one Home slot pattern.
- WF-6/7: Schedule and Pattern views show effective payee display names, and naming a
  detected schedule's payee goes through this same sheet.
