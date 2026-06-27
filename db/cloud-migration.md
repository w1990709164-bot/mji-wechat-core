# Mji Cloud Migration Notes

This project keeps runtime data in PostgreSQL so a local Windows setup can move
to a cloud server by moving the database and `.env` configuration.

## Fresh Cloud Database

1. Install Node.js 22+ and PostgreSQL 15+ on the server.
2. Put `MJI_DATABASE_URL` or `DATABASE_URL` in `.env`.
3. Install dependencies with `npm install`.
4. Run all migrations:

```powershell
npm run db:migrate
```

Before moving traffic to the cloud server, run the non-secret readiness check:

```powershell
npm run cloud:check
```

It reports missing environment variables and required local state files without printing credentials.

The migration runner executes `db/migrations/*.sql` in filename order and stores
completed files in `schema_migrations`, so it is safe to run again.

To preview migration status without writing to the database, run:

```powershell
npm run db:migrate:dry-run
```

To verify the target database after migration without printing credentials, run:

```powershell
npm run db:status
```

## Existing Local Database

If the current database already has the old tables and only needs the new user
admin display name field, run:

```powershell
npm run db:migrate -- --only 007_app_user_admin_display_name.sql
```

## User Names

Operator-facing user names are stored in `app_users.admin_display_name`.
They move with the database and do not depend on local files, WeChat openids, or
desktop-only state.

## Identity Model

Mji users scan a code and talk to an AI bot instance through the WeChat channel.
The channel account identifier, such as an iLink bot account id, is a bot
instance and not the operator's personal desktop WeChat login.

Keep these identities separate when migrating or debugging:

- `app_users.id`: internal Mji user id.
- `channel_identities.provider_user_id`: the user's WeChat-side identity.
- `channel_accounts.provider_account_id`: the channel bot instance.
- `app_users.admin_display_name`: the operator-facing remark name.
