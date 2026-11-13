# PostgreSQL and data engineering

Inspect the current schema, migrations, query layer and transaction conventions before changing data structures.

- Prefer explicit migrations; never silently mutate production schemas at application startup.
- Add indexes based on query patterns and verify foreign keys, uniqueness and nullability.
- Parameterize every query. Never concatenate untrusted input into SQL.
- Use transactions for multi-step state changes that must be atomic.
- Design ownership constraints so one user's records cannot be read or changed by another user.
- Paginate potentially large result sets and avoid N+1 query patterns.
- Consider retry safety and idempotency for jobs and external callbacks.
- Test migrations, rollback expectations, constraints and authorization-sensitive queries.
