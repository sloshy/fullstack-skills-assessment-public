# PR-231 Review

**Request changes.** The report is a useful feature, but as written the BFF cache and the by-network breakdown both leak data across merchants, the totals won't match what the gateway deposits, and the date picker can't select the right day for anyone east of UTC. None of it is tested. Details below.

## Linter error
File: `bff/src/routes/reports.routes.ts:6`

The `get` function on the router expects a void function, not a promise. You should wrap it in `asyncHandler` like the other routes defined in the same folder to properly handle the promise and pass rejections on to `next`. This was caught due to a linter addition for INC-4493 so this should be adjusted to match. Your handler already has its own `try`/`catch`, so it won't crash today, but it fails lint and wrapping it keeps every route consistent.

## Settlement cache keying and necessity
File: `bff/src/controllers/reports.controller.ts:12`

The PR description says the settlement report is cached because the payments API query in `ReportsController` is slow. If we fix the query to be faster, that will likely remove the need for the cache entirely and make the whole thing simpler.

The other issue with the cache is that it keys on the original URL and does not take the current merchant or the API key into account at all, so any next request could get the current cached result. If we're going to keep the cache at all, it should be changed to key on at least the merchant ID + the normalized date + a hash of the API key (never the raw key). That way, merchants making individual requests won't conflict with each other, and a wrong or rotated key can never read another key's entries. `listCacheKey` in `bff/src/controllers/payments.controller.ts` already does exactly this for the payments list; it was the fix for INC-4486, which was this same bug.

The cache also goes stale. The comment says a day's settlement doesn't change once the day is over, but the page defaults to today, which changes with every payment, and refunds change past days too (see the questions at the end). Nothing clears the cache on a new payment or refund, so a report can be up to 5 minutes out of date. If the cache stays, clear the merchant's entries on writes the way the payments list does.

Personally I'd drop the cache until we know we need it, since it adds complexity and security concerns we could do without. Happy to get a second opinion from another team member.

## ReportsController grouping by wrong collection and loading every merchant's payments into memory
File: `payments-api/src/InterPayments.Payments.Web.Api/Controllers/ReportsController.cs:23-36`

As mentioned in the comment about the cache, this query is not efficient and can be sped up by not loading everything into memory. A simple improvement would be combining `payments` into `settled` by using the `Where` clauses on the initial database call rather than when it's loaded into memory. Filtering by merchant and date lets the database use the existing `IX_Payment_MerchantId_CreatedAtUtc` index, which should be fast enough on its own, but we can go even further and group by network in the SQL query, letting the database do all of that work for us. Then, the gross and refunds are just the sums of the grouped results. However, in the interest of moving this along, that is an optimization we can revisit later in a separate ticket or PR.

The other thing this would fix is that we're using `payments` in the in-memory grouping when you really meant to use `settled`. By getting rid of `payments` entirely that kills two birds with one stone and fixes the grouping issue.

One thing I'll note here: you can't use `.ToLocalTime().Date` in the SQL filter the way we're using it in memory. You need to instead change the query to a date range using something like this:

```csharp
// A UTC range instead of ToLocalTime().Date, which can't be translated to SQL
var dayStart = DateTime.SpecifyKind(day.Date, DateTimeKind.Utc);
var dayEnd = dayStart.AddDays(1);
```

And then using those values in the query like so:

```csharp
var settled = query // Fill in the rest of the query here
    .Where(x => x.CreatedAtUtc >= dayStart && x.CreatedAtUtc < dayEnd)
```

Added bonus: `ToLocalTime()` buckets by the server's time zone, so the day depends on where the API happens to run. A fixed UTC range makes it deterministic.

## ReportsController totals are not summed properly
File: `payments-api/src/InterPayments.Payments.Web.Api/Controllers/ReportsController.cs:38-42`

Both `Total` and `RefundedAmount` are `double`, which is not only an imprecise type, but also those values are not what the gateway captured and should not be used for computing accurate totals. `PaymentService.cs:17` converts the receipt total with `(long)(quote.Total * 100)`, which truncates, so the captured amount can be a cent short of the receipt (INC-4478). I think you're looking for `GatewayAmountMinor` which is always an integer value in the lowest denomination of the current currency (i.e. cents). To get the refunded amount, you would check if the payment status is refunded and then use that same value, since we only support full refunds today. Then, convert into the current currency by applying the proper number of decimal places, rather than using the pre-converted doubles.

As a note: currency like `JPY` has no decimals, and that same line also multiplies JPY by 100 (like `USD` would be to convert dollars to cents), so JPY payments are captured at 100× today. Summing `GatewayAmountMinor` will still match what the gateway took, but the JPY figures won't be what the merchant meant to charge until the INC-4478 fix to `PaymentService.cs:17` lands. Worth checking the JPY numbers again once it does.

## SettlementPage date UTC clashes with date picker
File: `web/src/pages/SettlementPage.tsx:10` and `:29`

Like how in the payments API there's a small `ToLocalTime()` time zone bug, a similar bug appears in `SettlementPage`. For `:10` use `dayjs().format('YYYY-MM-DD')` and for `:29` use `value.format('YYYY-MM-DD')`.

The reason for this is the date picker sends back midnight local time, and then it gets converted to UTC, which is the previous day for anyone east of UTC. Because the picker then displays that date, each pick walks back another day, so those users can never select the day they want. At `:10`, `new Date()` is the current time rather than midnight, so the default date can be wrong on either side of UTC depending on the time of day: tomorrow's date from late afternoon in California, or yesterday's from early morning in Tokyo.

## No Tests

While relatively small, the behavior changes enough here to warrant tests for the frontend and backend code alike on the BFF and payments service. Saying you tested it locally is not enough.

At a minimum I would test that merchants cannot get each others' data, test the UTC date boundaries for the frontend and backend, and ensure that captured amounts are accurate.

## ReportsController and SettlementPage have incorrect and inconsistent figures
Files: `ReportsController.cs:31-36` vs `:38-42`, `SettlementPage.tsx:38`

Even with the fixes above, the numbers on the page don't agree with each other:

- "Surcharge collected" (`:42`) includes the surcharge on refunded payments. A refund returns the whole total, surcharge included, so that surcharge wasn't collected.
- The by-network table and the Gross card both include refunded payments, but only Net subtracts them, so nothing in the table adds up to Net. Label the table as gross, or add a refunds column.
- "Net" is gross minus refunds, but the model has no fees, chargebacks or reserves, so it isn't what lands in the bank. Something like "Sales less refunds" would be more accurate.

## SettlementPage can show the wrong day's report
File: `web/src/pages/SettlementPage.tsx:14-18`

The effect has no guard against out-of-order responses, so changing the date quickly can let an older response overwrite a newer one. It also never clears `report` or `error`, so if a fetch fails, the previous date's report stays on screen under the newly picked date, next to the error. For a page people use to reconcile, showing figures for the wrong day is worse than showing nothing.

`PaymentDetailPage.tsx:26-37` already has the pattern to follow: an `active` flag cleared in the effect's cleanup, and resetting the error (and here the report) when the date changes. A loading state would help too.

## Questions
- Which day should "settlement day" be: UTC, the merchant's local day, or the gateway's cut-off? The UTC range I suggested above is a placeholder until that's decided.
- Should refunds count on the day they happen? Right now a refund on Tuesday changes Monday's report after the fact, since payments only record when they were created.
- Is this for reconciling deposits (captured amounts, less fees) or a sales summary (receipts)? The description says the former, but the code computes the latter.
