/**
 * Service areas.
 *
 * DELIBERATE SCOPE DECISION: this file supports one page per area (10 pages),
 * not one page per service-and-area combination (10 x 10 = 100 pages).
 *
 * The combinatorial version is the obvious "programmatic SEO" move and it is a
 * trap. Those pages differ only by two substituted nouns, which is the textbook
 * definition of a doorway page: Google demotes them, and answer engines will not
 * cite a page that says nothing the service page did not already say. The
 * downside is not neutral either - a hundred thin pages drag down the crawl
 * budget and perceived quality of the pages that are genuinely good.
 *
 * So each area below carries content that is only true of that area: what the
 * building stock actually is, and which faults that stock actually produces.
 * `commonIssues` is the load-bearing field. If a new area cannot be given real
 * `commonIssues`, it does not get a page - it stays a name in the coverage list.
 *
 * ── DUBAI ONLY, AND WHY (WEB-2, WEB-6) ──────────────────────────────────────
 *
 * This file previously listed nine areas across Abu Dhabi and Sharjah with
 * stated median arrival times of 75 to 90 minutes. The licence is a Dubai
 * **mainland** DET licence, nobody had measured those arrival times, and a
 * coverage promise a dispatcher cannot keep is not marketing — it is an SLA
 * breach generator, one page per area. Both are gone.
 *
 * The per-area `responseMinutes` field is gone for the same reason. Response
 * time is a *commitment* set by the SLA tier the job is raised at (`JOB-4`), it
 * is identical everywhere we travel, and it is stated once in
 * `RESPONSE_COMMITMENT` rather than invented per area.
 *
 * `WEB-6` narrows this list further, to the areas the company will genuinely
 * travel to inside that commitment. That needs the owner's answer, not a guess,
 * so the ten Dubai areas below stand until it arrives.
 */

export interface Area {
  readonly slug: string;
  readonly name: string;
  readonly city: string;
  /** Extractable answer for this area. Names the area and the company. */
  readonly summary: string;
  /** What the built environment is, in a technician's terms. */
  readonly builtEnvironment: string;
  /**
   * Faults this area produces more than others, because of its stock, age or
   * environment. This is what stops the page being a template fill.
   */
  readonly commonIssues: readonly string[];
  /** Catalogue slugs most requested here. Ordered by demand. */
  readonly topServices: readonly string[];
  readonly propertyTypes: readonly string[];
}

export interface City {
  readonly name: string;
  readonly slug: string;
  readonly primary: boolean;
  readonly lat: number;
  readonly lng: number;
}

export const cities: readonly City[] = [
  { name: "Dubai", slug: "dubai", primary: true, lat: 25.2048, lng: 55.2708 },
] as const;

export const areas: readonly Area[] = [
  // ── Dubai ──────────────────────────────────────────────────────────────────
  {
    slug: "business-bay",
    name: "Business Bay",
    city: "Dubai",
    summary:
      "Licensed maintenance across Business Bay, covering the high-rise apartments, offices and mixed-use towers along the Dubai Water Canal. Most run on district cooling with fan coil units in each unit, so the faults here are FCU and condensate faults rather than condenser ones.",
    builtEnvironment:
      "Dense high-rise, largely built between 2008 and 2016, mixing residential floors with office and retail podiums in the same tower. Most buildings run on district cooling with fan coil units in each unit rather than individual condensers.",
    commonIssues: [
      "Fan coil unit drain pan overflow staining ceilings, usually a blocked condensate line rather than a leak from above",
      "Weak cooling on higher floors where the chilled water balancing was never corrected after handover",
      "Mixed-use towers where an office floor's after-hours AC shutdown leaves residential floors under-cooled",
      "Service riser access disputes between unit owners and building management delaying leak repairs",
    ],
    topServices: ["hvac-installation-maintenance", "plumbing-sanitary", "electrical-fittings-repair", "building-cleaning"],
    propertyTypes: ["Apartments", "Offices", "Retail units", "Mixed-use towers"],
  },
  {
    slug: "downtown-dubai",
    name: "Downtown Dubai",
    city: "Dubai",
    summary:
      "Licensed maintenance for apartments, penthouses and retail units across Downtown Dubai, including high-specification fit-outs around the Burj Khalifa and Dubai Mall district, on both callout and annual contract.",
    builtEnvironment:
      "Premium residential towers and serviced apartments with high-specification fit-outs: stone floors, concealed lighting, smart controls and imported sanitaryware. District cooling throughout.",
    commonIssues: [
      "Imported sanitaryware and mixer cartridges with no local parts supply, where the repair depends on sourcing rather than labour",
      "Smart lighting and curtain systems installed at handover with no documentation, left unsupported when the original contractor moved on",
      "Marble and natural stone etched by the wrong cleaning products, needing honing rather than replacement",
      "Concealed cove lighting failures requiring ceiling access panels that were never formed",
    ],
    topServices: ["hvac-installation-maintenance", "electrical-fittings-repair", "carpentry", "building-cleaning"],
    propertyTypes: ["Apartments", "Penthouses", "Serviced apartments", "Retail units"],
  },
  {
    slug: "dubai-marina",
    name: "Dubai Marina",
    city: "Dubai",
    summary:
      "Licensed maintenance for apartments and waterfront towers in Dubai Marina, where salt-laden air accelerates corrosion in air conditioning condensers and external metalwork faster than anywhere inland.",
    builtEnvironment:
      "Waterfront high-rise, much of it built 2005 to 2012 and now past the point where original plant reaches end of life. Proximity to open water is the defining maintenance factor.",
    commonIssues: [
      "Condenser coils corroding two to three times faster than inland, causing gradual cooling loss that is often misdiagnosed as low gas",
      "Aluminium window and balcony door tracks packed with salt and sand, making sliding doors heavy and eventually seizing them",
      "Balcony railing fixings rusting at the base plate where water sits after washdown",
      "Older buildings reaching the point where booster pumps and water heaters need replacement rather than repair",
    ],
    topServices: ["hvac-installation-maintenance", "carpentry", "plumbing-sanitary"],
    propertyTypes: ["Apartments", "Penthouses", "Retail units"],
  },
  {
    slug: "jumeirah-lakes-towers",
    name: "Jumeirah Lakes Towers",
    city: "Dubai",
    summary:
      "Licensed maintenance for apartments and offices across the Jumeirah Lakes Towers clusters, where much of the building stock dates from 2007 to 2010 and the original mechanical plant is now reaching replacement age.",
    builtEnvironment:
      "Cluster-organised towers built largely 2007 to 2010, mixing residential and commercial. Ageing is the defining factor: most buildings are now beyond the design life of their original pumps, valves and fan coil units.",
    commonIssues: [
      "Original fan coil units at end of life, where continued repair costs more over two years than replacement",
      "Chilled water valve failures causing units that either cannot be cooled or cannot be warmed",
      "Corroded galvanised pipework in older risers producing recurring pinhole leaks in different places",
      "Owners associations discovering there is no asset register, so budgeting for plant replacement is guesswork",
    ],
    topServices: ["hvac-installation-maintenance", "plumbing-sanitary", "painting", "building-cleaning"],
    propertyTypes: ["Apartments", "Offices", "Whole buildings"],
  },
  {
    slug: "palm-jumeirah",
    name: "Palm Jumeirah",
    city: "Dubai",
    summary:
      "Licensed maintenance for villas, apartments and beachfront properties across Palm Jumeirah, where direct sea exposure accelerates corrosion in AC plant, fixings and external finishes on every elevation.",
    builtEnvironment:
      "Signature villas on the fronds, apartment buildings on the trunk, and beachfront properties throughout. Almost every villa has a private pool and landscaped irrigation. Sea exposure is more severe than anywhere else we cover.",
    commonIssues: [
      "Pool plant corrosion and salt chlorinator cell failure, often needing replacement rather than service",
      "Split AC condensers on villa roofs failing early from direct salt exposure, where coil coating pays for itself",
      "Irrigation solenoid valves seizing from hard water and sand, showing as dead landscape zones",
      "Beach-facing glazing and aluminium requiring gasket renewal far sooner than manufacturer intervals suggest",
    ],
    topServices: ["hvac-installation-maintenance", "plumbing-sanitary", "carpentry"],
    propertyTypes: ["Villas", "Apartments", "Beachfront properties"],
  },
  {
    slug: "arabian-ranches",
    name: "Arabian Ranches",
    city: "Dubai",
    summary:
      "Licensed villa maintenance across Arabian Ranches, covering the ducted air conditioning and roof-mounted plant typical of the community's villa stock, and the finishes and joinery that go with it.",
    builtEnvironment:
      "Established low-rise villa community with mature landscaping. Ducted split air conditioning with roof-mounted condensers, private pools on many plots, and irrigation across every garden.",
    commonIssues: [
      "Ducted AC delivering uneven cooling between rooms because dampers were never balanced and have since drifted",
      "Flexible duct runs in roof voids sagging or disconnecting, dumping cold air into the ceiling space",
      "Irrigation leaks under mature landscaping that show first as an unexplained water bill",
      "Roof-mounted condensers with no maintenance access route, turning a routine service into a work-at-height job",
    ],
    topServices: ["hvac-installation-maintenance", "plumbing-sanitary", "painting"],
    propertyTypes: ["Villas", "Townhouses"],
  },
  {
    slug: "dubai-hills-estate",
    name: "Dubai Hills Estate",
    city: "Dubai",
    summary:
      "Licensed maintenance for Dubai Hills Estate villas, townhouses and apartments, including newer handovers still inside their developer defect liability period — where the right first step is often a warranty claim rather than a paid repair, and we will say so.",
    builtEnvironment:
      "Recent development, much of it handed over from 2019 onward. A meaningful proportion of properties are still inside the developer's defect liability period, which changes what the correct action is.",
    commonIssues: [
      "Snagging defects that remain the developer's responsibility, where paying a contractor is the wrong move",
      "Newly commissioned AC systems never balanced after handover, producing hot rooms in an otherwise sound installation",
      "Grout and silicone failure in wet areas within the first two years, indicating original workmanship rather than wear",
      "Smart home systems handed over with no configuration documentation or app account ownership",
    ],
    topServices: ["hvac-installation-maintenance", "carpentry", "electrical-fittings-repair"],
    propertyTypes: ["Villas", "Townhouses", "Apartments"],
  },
  {
    slug: "deira",
    name: "Deira",
    city: "Dubai",
    summary:
      "Licensed maintenance for the older Dubai building stock across Deira, where ageing galvanised pipework, undersized distribution boards and window or package AC units are the dominant faults.",
    builtEnvironment:
      "The oldest stock we cover, much of it from the 1980s and 1990s. Window and package air conditioning is still common, plumbing is frequently original galvanised steel, and electrical distribution predates modern load expectations.",
    commonIssues: [
      "Galvanised pipework corroded internally, producing recurring pinhole leaks that appear in a new place after each repair",
      "Distribution boards without RCD protection and with insufficient ways for modern appliance loads",
      "Window and package AC units where spares are no longer manufactured, making replacement the only honest recommendation",
      "Original waterproofing at end of life, showing as damp on the top floor and in bathrooms",
    ],
    topServices: ["plumbing-sanitary", "electrical-fittings-repair", "tiling", "hvac-installation-maintenance"],
    propertyTypes: ["Apartments", "Offices", "Retail units", "Whole buildings"],
  },
  {
    slug: "al-barsha",
    name: "Al Barsha",
    city: "Dubai",
    summary:
      "Licensed maintenance for Al Barsha villas, low-rise apartments and commercial units — a mixed area where the same street can hold a 1990s villa and a recent apartment block with entirely different maintenance needs.",
    builtEnvironment:
      "Mixed and uneven: older independent villas alongside low-rise apartment blocks and commercial units. Split AC dominates rather than district cooling. Building age varies by more than twenty years within a single street.",
    commonIssues: [
      "Villa subdivisions where the original single-family electrical and plumbing design now serves several households",
      "Split AC condensers crowded into light wells with insufficient airflow, causing repeated high-pressure cut-outs",
      "Water tanks on older villas needing municipality-compliant cleaning that has never been scheduled",
      "Extensions and additions built without drawings, so nobody knows where services run until something is cut",
    ],
    topServices: ["hvac-installation-maintenance", "electrical-fittings-repair", "plumbing-sanitary", "carpentry"],
    propertyTypes: ["Villas", "Apartments", "Commercial units"],
  },
  {
    slug: "jumeirah-village-circle",
    name: "Jumeirah Village Circle",
    city: "Dubai",
    summary:
      "Licensed maintenance for Jumeirah Village Circle apartments and townhouses — a high-density area where build quality varies sharply between developers, so the correct diagnosis often depends on which building you are in.",
    builtEnvironment:
      "High-density, rapidly built, and unusually variable. Two adjacent buildings completed a year apart by different developers can have entirely different plant, standards and failure patterns.",
    commonIssues: [
      "Wet-area waterproofing omitted or applied over an untested substrate, showing as leaks into the unit below within two to three years",
      "Undersized AC selection producing units that run continuously without reaching setpoint in summer",
      "Common-area plant with no maintenance contract in the first years after handover, so first failures arrive together",
      "Drainage stacks undersized or poorly vented, causing gurgling and slow drainage across several units at once",
    ],
    topServices: ["plumbing-sanitary", "tiling", "hvac-installation-maintenance", "painting"],
    propertyTypes: ["Apartments", "Townhouses"],
  },

] as const;

// ── Derived views ────────────────────────────────────────────────────────────

const areaBySlug = new Map(areas.map((a) => [a.slug, a]));

export function getArea(slug: string): Area | undefined {
  return areaBySlug.get(slug);
}

export function areasInCity(city: string): readonly Area[] {
  return areas.filter((a) => a.city === city);
}

export function groupedAreas(): readonly { city: City; items: readonly Area[] }[] {
  return cities.map((city) => ({ city, items: areasInCity(city.name) }));
}

/** Other areas in the same city, for internal linking. */
export function nearbyAreas(slug: string, limit = 4): readonly Area[] {
  const area = areaBySlug.get(slug);
  if (!area) return [];
  return areasInCity(area.city)
    .filter((a) => a.slug !== slug)
    .slice(0, limit);
}
