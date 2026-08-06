CREATE TABLE "rate_limits" (
	"bucket" varchar(200) PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL
);
