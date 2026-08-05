-- Full-text search for the public catalogue.
--
-- Hand-written after `prisma migrate dev --create-only`. Prisma generated a bare
-- `tsvector` column, which application code would then have to populate on every write -
-- going silently stale the moment one write path forgot. So Postgres owns the value.
--
-- It is maintained by a TRIGGER rather than GENERATED ALWAYS, which was the first
-- attempt. Prisma introspects a generated column as having a default and so emits
-- `ALTER COLUMN "searchVector" DROP DEFAULT` on every subsequent `migrate dev`, which
-- Postgres refuses outright:
--   ERROR: column "searchVector" of relation "Service" is a generated column
-- That makes every later migration in the project unapplyable. A plain column plus a
-- trigger gives the identical guarantee with no drift, so `migrate dev` keeps working
-- for the remaining phases.

-- AlterTable
ALTER TABLE "Service" ADD COLUMN "searchVector" tsvector;

CREATE OR REPLACE FUNCTION service_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    to_tsvector('english', coalesce(NEW."title", '') || ' ' || coalesce(NEW."description", ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- BEFORE, so the computed value is part of the row being written rather than a second
-- UPDATE. Fires on INSERT and on every UPDATE - narrowing it to `UPDATE OF title,
-- description` would be a micro-optimisation that breaks the day a column is renamed.
CREATE TRIGGER service_search_vector_trigger
  BEFORE INSERT OR UPDATE ON "Service"
  FOR EACH ROW EXECUTE FUNCTION service_search_vector_update();

-- Backfill any rows that predate the trigger. A no-op on a cold clone; required on a
-- database that already holds services, and harmless to run either way.
UPDATE "Service" SET "title" = "title";

-- CreateIndex
-- GIN, not GiST: a read-heavy catalogue wants fast lookups and tolerates slower writes.
-- Without this index `@@` degrades to a sequential scan and the column is decorative.
CREATE INDEX "Service_searchVector_idx" ON "Service" USING GIN ("searchVector");
