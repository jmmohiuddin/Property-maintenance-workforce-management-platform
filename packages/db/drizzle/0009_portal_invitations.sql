-- POR-8 — portal access granted and revoked from the customer record.
--
-- Staff can grant, revoke and re-invite portal access. Until now this required
-- SQL, which meant in practice it never happened — and a portal that exists to
-- deflect phone calls was reachable by almost nobody.
--
-- An invitation may now carry the customer it grants access to. Nullable,
-- because a staff invitation has no customer and a NOT NULL with a sentinel
-- value would be a lie about what the row means. `app_invite_accept` reads it
-- and creates a `customer` membership WITH a `customer_id` — both halves
-- matter: the role keeps them out of the staff application, and the
-- `customer_id` is what withCustomerScope() sets so the RESTRICTIVE policies
-- narrow every query. A `customer` membership with a null `customer_id` would
-- be a portal login scoped to nothing.
ALTER TABLE "user_invitations" ADD COLUMN "customer_id" uuid;
--> statement-breakpoint
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
