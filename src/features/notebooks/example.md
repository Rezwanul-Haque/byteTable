---
bytetable: notebook/1
title: Cancelled orders review
connection: byteshop_dev
schema: public
---

# Cancelled orders review

Support asked whether cancellations are spread evenly or coming from one place. This notebook keeps the queries and what each one told us.

## 1. How big is it?

Start with every order grouped by status, so cancellations can be compared with the rest.

```sql
SELECT status, COUNT(*) AS orders, SUM(total) AS revenue
FROM orders
GROUP BY status
ORDER BY orders DESC
```

<!-- bt:result rows=4 ms=4 at=2026-11-22T11:41Z -->
| status | orders | revenue |
| --- | --- | --- |
| delivered | 2 | 79 |
| shipped | 1 | 19.99 |
| pending | 1 | 99 |
| cancelled | 1 | 5 |
<!-- /bt:result -->

Cancelled is one order in five, and the smallest by value. Next: **who** is cancelling.

## 2. Where do they come from?

Join to `users` and count cancelled orders per country.

```sql
SELECT u.country, COUNT(*) AS cancelled, SUM(o.total) AS amount
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.status = 'cancelled'
GROUP BY u.country
ORDER BY cancelled DESC
```

<!-- bt:result rows=1 ms=3 at=2026-11-22T11:41Z -->
| country | cancelled | amount |
| --- | --- | --- |
| US | 1 | 5 |
<!-- /bt:result -->

A single country so far, so no market is behind it yet. Worth watching as orders grow.

## 3. The orders themselves

The list to hand to support.

```sql
SELECT id, user_id, total, method
FROM orders
WHERE status = 'cancelled'
ORDER BY total DESC
```

## Next steps

- Ask support for the cancellation reasons
- Run this notebook again next Monday and compare
- The statement below marks them as reviewed. It changes data, so **Run all** skips it.

```sql
UPDATE orders
SET status = 'reviewed'
WHERE status = 'cancelled'
```
