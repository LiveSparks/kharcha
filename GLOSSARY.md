# Glossary

## Alias
A user-given friendly name bound to a Payee or an Account. Once given, the alias is applied
everywhere the underlying key appears, including historical transactions.

## Schedule
A transaction pattern that repeats at a regular interval (weekly, monthly, quarterly, …),
tolerating a margin of a few days either side. Detected from ledger history and offered
as a suggestion. It becomes a Schedule only when the user confirms it (*Track it*), and from
then on new transactions match it to advance its expected date.

## Pattern
A recurring tendency to pay the same payee (or counterparty) similar amounts at irregular
intervals. Surfaces spending habits that are not regular bills. Weaker claim than a Schedule.

## Payee
The counterparty of a transaction: a merchant name, or a masked counterparty account
(e.g. `**5280`) where the bank provides no name. Identified by structured parser fields, not
by re-reading raw SMS.

## Account
A bank account or card, keyed by the issuing bank plus its last digits (e.g. HDFC `*3391`,
ICICI card `*6119`). A card is its own account even when a bank account funds it.

## Duplicate pair
Two ledger rows that look like notifications of one transaction (same amount and direction,
compatible account and payee, close in time). The later row is flagged, never dropped. The
user merges the pair (one survives, the other is kept as `merged` and can be unmerged) or
keeps both.
