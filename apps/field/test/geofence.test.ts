import { check, equal, done } from "./_harness";
import { GEOFENCE_RADIUS_METRES, evaluateGeofence, haversineMetres } from "../src/domain/geofence";

// ── haversineMetres ──────────────────────────────────────────────────────────

equal("the same point is zero metres from itself", haversineMetres({ lat: 25.2, lng: 55.3 }, { lat: 25.2, lng: 55.3 }), 0);

check(
  "roughly a degree of latitude is roughly 111km",
  Math.abs(haversineMetres({ lat: 25.0, lng: 55.0 }, { lat: 26.0, lng: 55.0 }) - 111_195) < 500,
);

// ── evaluateGeofence: no point captured ─────────────────────────────────────

check(
  "no captured point is unknown, never false - permission refused or no fix",
  evaluateGeofence(null, [{ lat: 25.2, lng: 55.3 }]) === null,
);

check(
  "still unknown even when a site is right there",
  evaluateGeofence(null, [{ lat: 25.2048, lng: 55.2708 }]) === null,
);

// ── evaluateGeofence: no usable site ────────────────────────────────────────

check(
  "no site with coordinates is unknown, not false",
  evaluateGeofence({ lat: 25.2, lng: 55.3 }, []) === null,
);

check(
  "a site with only one coordinate present does not count as usable",
  evaluateGeofence({ lat: 25.2, lng: 55.3 }, [{ lat: 25.2, lng: null }, { lat: null, lng: 55.3 }]) === null,
);

// ── evaluateGeofence: real comparisons ──────────────────────────────────────

const site = { lat: 25.2048, lng: 55.2708 };

check(
  "standing on the site itself is within geofence",
  evaluateGeofence(site, [site]) === true,
);

const nearby = { lat: 25.2049, lng: 55.2709 }; // a few metres away
check(
  "a few metres away is still within the default radius",
  evaluateGeofence(nearby, [site]) === true,
);

const farAway = { lat: 25.3, lng: 55.4 }; // tens of kilometres away
check(
  "tens of kilometres away is outside the geofence, and it is a real false, not unknown",
  evaluateGeofence(farAway, [site]) === false,
);

check(
  "within geofence of ANY of several sites counts",
  evaluateGeofence(site, [farAway, site]) === true,
);

check(
  "outside geofence of every site in the set is false",
  evaluateGeofence(farAway, [site, { lat: 25.21, lng: 55.28 }]) === false,
);

// ── the radius parameter is honoured ────────────────────────────────────────

check(
  "a point just past the radius reads as outside",
  evaluateGeofence({ lat: site.lat + 0.01, lng: site.lng }, [site], 100) === false,
);

check(
  "the same point reads as inside with a radius wide enough to cover it",
  evaluateGeofence({ lat: site.lat + 0.001, lng: site.lng }, [site], 500) === true,
);

check("the default radius is a positive, sane number of metres", GEOFENCE_RADIUS_METRES > 0 && GEOFENCE_RADIUS_METRES < 5_000);

done("geofence");
