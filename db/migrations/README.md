# Migrations

Files are named `NNNN_description.sql` and never edited once created. Use `/new-migration`.

`pnpm db:migrate` applies pending files in order, each in its own transaction, and records them in `schema_migrations`.
