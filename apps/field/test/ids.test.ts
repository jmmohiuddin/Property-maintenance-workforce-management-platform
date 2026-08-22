import { check, equal, done } from "./_harness";
import { createUlidFactory, clientIdTime, isClientId, ULID_PATTERN } from "../src/domain/ids";

const ulid = createUlidFactory();

const a = ulid();
equal("a ULID is 26 characters", a.length, 26);
check("a ULID matches the Crockford alphabet", ULID_PATTERN.test(a));
check("isClientId accepts one", isClientId(a));
check("isClientId rejects a UUID", !isClientId("3f2504e0-4f89-11d3-9a0c-0305e82c3301"));

// Monotonicity is the property the outbox ordering depends on.
const burst = Array.from({ length: 500 }, () => ulid());
const sorted = [...burst].sort();
check("500 IDs minted in a burst sort into creation order", JSON.stringify(burst) === JSON.stringify(sorted));
check("500 IDs minted in a burst are all distinct", new Set(burst).size === 500);

// A clock that goes backwards must not break the ordering.
let fakeNow = 1_700_000_000_000;
const originalNow = Date.now;
Date.now = () => fakeNow;
try {
  const withMovingClock = createUlidFactory();
  const before = withMovingClock();
  fakeNow -= 3 * 60 * 60 * 1000; // technician sets the clock back three hours
  const after = withMovingClock();
  check("an ID minted after the clock goes backwards still sorts later", after > before,
    `${before} then ${after}`);
} finally {
  Date.now = originalNow;
}

const time = clientIdTime(a);
check("the encoded time round-trips within a second of now",
  time !== null && Math.abs(time - Date.now()) < 1000, String(time));
equal("clientIdTime refuses a non-ULID", clientIdTime("not-a-ulid"), null);

done("ids");
