import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // DATABASE_ADMIN_URL first, matching `seed.ts` and what the README states
    // twice: "Seeds and migrations use the separate DATABASE_ADMIN_URL."
    //
    // This file read DATABASE_URL alone, which is the APPLICATION connection --
    // the one the README insists must never be a superuser, and which
    // `packages/db/src/index.ts` refuses at boot if it is. Migrations run as
    // that role cannot create a table. CI never caught it because CI applies
    // `drizzle/*.sql` by glob to a throwaway database and never calls
    // `drizzle-kit migrate` at all, so the documented deployment path was the
    // one path nothing executed.
    //
    // The fallback keeps a developer working from a single DATABASE_URL against
    // a database they own.
    url:
      process.env["DATABASE_ADMIN_URL"] ??
      process.env["DATABASE_URL"] ??
      "postgres://localhost:5432/meridian",
  },
  strict: true,
  verbose: true,
} satisfies Config;
