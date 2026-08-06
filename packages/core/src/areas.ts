/**
 * Service areas.
 *
 * DELIBERATE SCOPE DECISION: this file supports one page per area (19 pages),
 * not one page per service-and-area combination (24 x 19 = 456 pages).
 *
 * The 456-page version is the obvious "programmatic SEO" move and it is a trap.
 * Those pages differ only by two substituted nouns, which is the textbook
 * definition of a doorway page: Google demotes them, and answer engines will not
 * cite a page that says nothing the service page did not already say. The
 * downside is not neutral either - a few hundred thin pages drag down the
 * crawl budget and perceived quality of the 24 pages that are genuinely good.
 *
 * So each area below carries content that is only true of that area: what the
 * building stock actually is, and which faults that stock actually produces.
 * `commonIssues` is the load-bearing field. If a new area cannot be given real
 * `commonIssues`, it does not get a page - it stays a name in the coverage list.
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
  /** Median emergency arrival, minutes. */
  readonly responseMinutes: number;
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
  { name: "Abu Dhabi", slug: "abu-dhabi", primary: false, lat: 24.4539, lng: 54.3773 },
  { name: "Sharjah", slug: "sharjah", primary: false, lat: 25.3463, lng: 55.4209 },
] as const;

export const areas: readonly Area[] = [
  // ── Dubai ──────────────────────────────────────────────────────────────────
  {
    slug: "business-bay",
    name: "Business Bay",
    city: "Dubai",
    summary:
      "Meridian Facilities provides 24-hour maintenance across Business Bay, covering high-rise apartments, offices and mixed-use towers along the Dubai Water Canal, with a median emergency arrival of 40 minutes.",
    builtEnvironment:
      "Dense high-rise, largely built between 2008 and 2016, mixing residential floors with office and retail podiums in the same tower. Most buildings run on district cooling with fan coil units in each unit rather than individual condensers.",
    commonIssues: [
      "Fan coil unit drain pan overflow staining ceilings, usually a blocked condensate line rather than a leak from above",
      "Weak cooling on higher floors where the chilled water balancing was never corrected after handover",
      "Mixed-use towers where an office floor's after-hours AC shutdown leaves residential floors under-cooled",
      "Service riser access disputes between unit owners and building management delaying leak repairs",
    ],
    topServices: ["hvac-ac-maintenance", "plumbing", "electrical", "facility-management"],
    propertyTypes: ["Apartments", "Offices", "Retail units", "Mixed-use towers"],
    responseMinutes: 40,
  },
  {
    slug: "downtown-dubai",
    name: "Downtown Dubai",
    city: "Dubai",
    summary:
      "Meridian Facilities maintains apartments, penthouses and retail units across Downtown Dubai, including high-specification fit-outs around the Burj Khalifa and Dubai Mall district, on both call-out and annual contract.",
    builtEnvironment:
      "Premium residential towers and serviced apartments with high-specification fit-outs: stone floors, concealed lighting, smart controls and imported sanitaryware. District cooling throughout.",
    commonIssues: [
      "Imported sanitaryware and mixer cartridges with no local parts supply, where the repair depends on sourcing rather than labour",
      "Smart lighting and curtain systems installed at handover with no documentation, left unsupported when the original contractor moved on",
      "Marble and natural stone etched by the wrong cleaning products, needing honing rather than replacement",
      "Concealed cove lighting failures requiring ceiling access panels that were never formed",
    ],
    topServices: ["hvac-ac-maintenance", "smart-home", "handyman", "deep-cleaning"],
    propertyTypes: ["Apartments", "Penthouses", "Serviced apartments", "Retail units"],
    responseMinutes: 45,
  },
  {
    slug: "dubai-marina",
    name: "Dubai Marina",
    city: "Dubai",
    summary:
      "Meridian Facilities covers Dubai Marina 24 hours a day for apartments and waterfront towers, where salt-laden air accelerates corrosion in air conditioning condensers, balcony railings and aluminium glazing.",
    builtEnvironment:
      "Waterfront high-rise, much of it built 2005 to 2012 and now past the point where original plant reaches end of life. Proximity to open water is the defining maintenance factor.",
    commonIssues: [
      "Condenser coils corroding two to three times faster than inland, causing gradual cooling loss that is often misdiagnosed as low gas",
      "Aluminium window and balcony door tracks packed with salt and sand, making sliding doors heavy and eventually seizing them",
      "Balcony railing fixings rusting at the base plate where water sits after washdown",
      "Older buildings reaching the point where booster pumps and water heaters need replacement rather than repair",
    ],
    topServices: ["hvac-ac-maintenance", "glass-aluminium", "plumbing", "amc"],
    propertyTypes: ["Apartments", "Penthouses", "Retail units"],
    responseMinutes: 50,
  },
  {
    slug: "jumeirah-lakes-towers",
    name: "Jumeirah Lakes Towers",
    city: "Dubai",
    summary:
      "Meridian Facilities services apartments and offices across the Jumeirah Lakes Towers clusters, where much of the building stock dates from 2007 to 2010 and original mechanical plant is now reaching replacement age.",
    builtEnvironment:
      "Cluster-organised towers built largely 2007 to 2010, mixing residential and commercial. Ageing is the defining factor: most buildings are now beyond the design life of their original pumps, valves and fan coil units.",
    commonIssues: [
      "Original fan coil units at end of life, where continued repair costs more over two years than replacement",
      "Chilled water valve failures causing units that either cannot be cooled or cannot be warmed",
      "Corroded galvanised pipework in older risers producing recurring pinhole leaks in different places",
      "Owners associations discovering there is no asset register, so budgeting for plant replacement is guesswork",
    ],
    topServices: ["hvac-ac-maintenance", "plumbing", "building-maintenance", "facility-management"],
    propertyTypes: ["Apartments", "Offices", "Whole buildings"],
    responseMinutes: 50,
  },
  {
    slug: "palm-jumeirah",
    name: "Palm Jumeirah",
    city: "Dubai",
    summary:
      "Meridian Facilities maintains villas, apartments and beachfront properties across Palm Jumeirah, covering pool plant, private beach frontage and the accelerated corrosion that comes with direct sea exposure.",
    builtEnvironment:
      "Signature villas on the fronds, apartment buildings on the trunk, and beachfront properties throughout. Almost every villa has a private pool and landscaped irrigation. Sea exposure is more severe than anywhere else we cover.",
    commonIssues: [
      "Pool plant corrosion and salt chlorinator cell failure, often needing replacement rather than service",
      "Split AC condensers on villa roofs failing early from direct salt exposure, where coil coating pays for itself",
      "Irrigation solenoid valves seizing from hard water and sand, showing as dead landscape zones",
      "Beach-facing glazing and aluminium requiring gasket renewal far sooner than manufacturer intervals suggest",
    ],
    topServices: ["hvac-ac-maintenance", "plumbing", "glass-aluminium", "amc"],
    propertyTypes: ["Villas", "Apartments", "Beachfront properties"],
    responseMinutes: 55,
  },
  {
    slug: "arabian-ranches",
    name: "Arabian Ranches",
    city: "Dubai",
    summary:
      "Meridian Facilities provides villa maintenance across Arabian Ranches, covering ducted air conditioning, private pools, landscaped irrigation and the roof-mounted plant typical of the community's villa stock.",
    builtEnvironment:
      "Established low-rise villa community with mature landscaping. Ducted split air conditioning with roof-mounted condensers, private pools on many plots, and irrigation across every garden.",
    commonIssues: [
      "Ducted AC delivering uneven cooling between rooms because dampers were never balanced and have since drifted",
      "Flexible duct runs in roof voids sagging or disconnecting, dumping cold air into the ceiling space",
      "Irrigation leaks under mature landscaping that show first as an unexplained water bill",
      "Roof-mounted condensers with no maintenance access route, turning a routine service into a work-at-height job",
    ],
    topServices: ["hvac-ac-maintenance", "plumbing", "painting", "amc"],
    propertyTypes: ["Villas", "Townhouses"],
    responseMinutes: 60,
  },
  {
    slug: "dubai-hills-estate",
    name: "Dubai Hills Estate",
    city: "Dubai",
    summary:
      "Meridian Facilities covers Dubai Hills Estate villas, townhouses and apartments, including newer handovers still within their developer defect liability period where the right first step is often a warranty claim.",
    builtEnvironment:
      "Recent development, much of it handed over from 2019 onward. A meaningful proportion of properties are still inside the developer's defect liability period, which changes what the correct action is.",
    commonIssues: [
      "Snagging defects that remain the developer's responsibility, where paying a contractor is the wrong move",
      "Newly commissioned AC systems never balanced after handover, producing hot rooms in an otherwise sound installation",
      "Grout and silicone failure in wet areas within the first two years, indicating original workmanship rather than wear",
      "Smart home systems handed over with no configuration documentation or app account ownership",
    ],
    topServices: ["hvac-ac-maintenance", "handyman", "smart-home", "amc"],
    propertyTypes: ["Villas", "Townhouses", "Apartments"],
    responseMinutes: 55,
  },
  {
    slug: "deira",
    name: "Deira",
    city: "Dubai",
    summary:
      "Meridian Facilities maintains older Dubai building stock across Deira, where ageing galvanised pipework, undersized distribution boards and window or package AC units are the dominant maintenance issues.",
    builtEnvironment:
      "The oldest stock we cover, much of it from the 1980s and 1990s. Window and package air conditioning is still common, plumbing is frequently original galvanised steel, and electrical distribution predates modern load expectations.",
    commonIssues: [
      "Galvanised pipework corroded internally, producing recurring pinhole leaks that appear in a new place after each repair",
      "Distribution boards without RCD protection and with insufficient ways for modern appliance loads",
      "Window and package AC units where spares are no longer manufactured, making replacement the only honest recommendation",
      "Original waterproofing at end of life, showing as damp on the top floor and in bathrooms",
    ],
    topServices: ["plumbing", "electrical", "waterproofing", "hvac-ac-maintenance"],
    propertyTypes: ["Apartments", "Offices", "Retail units", "Whole buildings"],
    responseMinutes: 45,
  },
  {
    slug: "al-barsha",
    name: "Al Barsha",
    city: "Dubai",
    summary:
      "Meridian Facilities services Al Barsha villas, low-rise apartments and commercial units, a mixed area where the same street can hold a 1990s villa and a recent apartment block with entirely different maintenance needs.",
    builtEnvironment:
      "Mixed and uneven: older independent villas alongside low-rise apartment blocks and commercial units. Split AC dominates rather than district cooling. Building age varies by more than twenty years within a single street.",
    commonIssues: [
      "Villa subdivisions where the original single-family electrical and plumbing design now serves several households",
      "Split AC condensers crowded into light wells with insufficient airflow, causing repeated high-pressure cut-outs",
      "Water tanks on older villas needing municipality-compliant cleaning that has never been scheduled",
      "Extensions and additions built without drawings, so nobody knows where services run until something is cut",
    ],
    topServices: ["hvac-ac-maintenance", "electrical", "plumbing", "handyman"],
    propertyTypes: ["Villas", "Apartments", "Commercial units"],
    responseMinutes: 45,
  },
  {
    slug: "jumeirah-village-circle",
    name: "Jumeirah Village Circle",
    city: "Dubai",
    summary:
      "Meridian Facilities covers Jumeirah Village Circle apartments and townhouses, a high-density area where build quality varies sharply between developers and the correct diagnosis often depends on which building you are in.",
    builtEnvironment:
      "High-density, rapidly built, and unusually variable. Two adjacent buildings completed a year apart by different developers can have entirely different plant, standards and failure patterns.",
    commonIssues: [
      "Wet-area waterproofing omitted or applied over an untested substrate, showing as leaks into the unit below within two to three years",
      "Undersized AC selection producing units that run continuously without reaching setpoint in summer",
      "Common-area plant with no maintenance contract in the first years after handover, so first failures arrive together",
      "Drainage stacks undersized or poorly vented, causing gurgling and slow drainage across several units at once",
    ],
    topServices: ["plumbing", "waterproofing", "hvac-ac-maintenance", "building-maintenance"],
    propertyTypes: ["Apartments", "Townhouses"],
    responseMinutes: 50,
  },

  // ── Abu Dhabi ──────────────────────────────────────────────────────────────
  {
    slug: "al-reem-island",
    name: "Al Reem Island",
    city: "Abu Dhabi",
    summary:
      "Meridian Facilities maintains high-rise apartments and offices on Al Reem Island, Abu Dhabi, where reclaimed-land towers combine district cooling with waterfront exposure on most elevations.",
    builtEnvironment:
      "High-rise towers on reclaimed land, largely completed from 2011 onward, on district cooling with fan coil units. Most towers have water on at least two elevations.",
    commonIssues: [
      "Fan coil unit and chilled water valve failures presenting as a room that will not cool while neighbouring rooms are fine",
      "Condensate drain blockages in ceiling voids, discovered only once the ceiling stains",
      "Facade and balcony sealant degrading faster on the seaward elevations",
      "Building management systems where alarms are generated but nobody is assigned to act on them",
    ],
    topServices: ["hvac-ac-maintenance", "plumbing", "facility-management", "building-maintenance"],
    propertyTypes: ["Apartments", "Offices", "Whole buildings"],
    responseMinutes: 75,
  },
  {
    slug: "yas-island",
    name: "Yas Island",
    city: "Abu Dhabi",
    summary:
      "Meridian Facilities provides maintenance and facility management on Yas Island, Abu Dhabi, covering residential communities, hotels and leisure venues where event schedules dictate when work can be carried out.",
    builtEnvironment:
      "Mixed leisure, hospitality and residential. Hotels and venues operate to event calendars, so access windows are narrow and often out of hours.",
    commonIssues: [
      "Hotel and venue plant that can only be serviced in specific windows between events",
      "Kitchen extract and grease management in food and beverage venues requiring scheduled deep cleaning",
      "High-occupancy swings loading AC and plumbing far beyond design assumptions on event weekends",
      "Back-of-house areas deferred during peak season and needing catch-up maintenance afterwards",
    ],
    topServices: ["facility-management", "hvac-ac-maintenance", "deep-cleaning", "workforce-supply"],
    propertyTypes: ["Hotels", "Apartments", "Villas", "Leisure venues"],
    responseMinutes: 80,
  },
  {
    slug: "khalifa-city",
    name: "Khalifa City",
    city: "Abu Dhabi",
    summary:
      "Meridian Facilities services villas and low-rise properties across Khalifa City, Abu Dhabi, covering split and ducted air conditioning, water tanks, generators and landscaped irrigation typical of the area's villa stock.",
    builtEnvironment:
      "Established low-rise villa area with generous plots. Individual water tanks and, on many compounds, standby generators. Split and ducted AC rather than district cooling.",
    commonIssues: [
      "Water tanks that have never been cleaned to municipality standard, affecting water quality and appliance life",
      "Standby generators that start on test but fail to take load, because the transfer switch is never exercised",
      "Long external pipe runs losing insulation, driving up cooling cost and causing condensation",
      "Compound-wide irrigation controllers left on factory schedules through winter",
    ],
    topServices: ["hvac-ac-maintenance", "plumbing", "generator-maintenance", "amc"],
    propertyTypes: ["Villas", "Townhouses", "Compounds"],
    responseMinutes: 85,
  },
  {
    slug: "al-raha-beach",
    name: "Al Raha Beach",
    city: "Abu Dhabi",
    summary:
      "Meridian Facilities covers Al Raha Beach apartments and waterfront properties in Abu Dhabi, where canal-side and beachfront exposure accelerates wear on external plant, glazing and balcony finishes.",
    builtEnvironment:
      "Waterfront apartment developments along the canal and shoreline, largely completed from 2010 onward, on district cooling with landscaped podium levels.",
    commonIssues: [
      "Balcony drainage falls set incorrectly at construction, ponding water and lifting tiles over time",
      "Podium-level landscaping irrigation leaking into parking structures below",
      "Salt exposure degrading external light fittings and door hardware on seaward elevations",
      "Fan coil filters loading faster than the standard schedule assumes, from a mix of humidity and dust",
    ],
    topServices: ["hvac-ac-maintenance", "waterproofing", "plumbing", "building-maintenance"],
    propertyTypes: ["Apartments", "Townhouses", "Retail units"],
    responseMinutes: 80,
  },
  {
    slug: "saadiyat-island",
    name: "Saadiyat Island",
    city: "Abu Dhabi",
    summary:
      "Meridian Facilities maintains high-specification villas and apartments on Saadiyat Island, Abu Dhabi, where beachfront exposure and premium finishes both raise the standard a repair has to meet.",
    builtEnvironment:
      "Low-density premium residential alongside cultural and hotel developments. High-specification finishes, private pools on many villas, and direct beach exposure on much of the island.",
    commonIssues: [
      "Premium finishes where a visible repair is not acceptable, so matching and making good is most of the work",
      "Pool plant and beach-facing equipment corroding faster than inland equivalents",
      "Large glazed elevations where sealed unit failure shows as permanent internal fogging",
      "Landscape irrigation on sandy substrate requiring more frequent head and filter service",
    ],
    topServices: ["hvac-ac-maintenance", "glass-aluminium", "painting", "amc"],
    propertyTypes: ["Villas", "Apartments", "Beachfront properties"],
    responseMinutes: 85,
  },

  // ── Sharjah ────────────────────────────────────────────────────────────────
  {
    slug: "al-majaz",
    name: "Al Majaz",
    city: "Sharjah",
    summary:
      "Meridian Facilities services apartments and commercial units across Al Majaz, Sharjah, where corniche-facing towers of varying age combine older mechanical plant with high residential occupancy.",
    builtEnvironment:
      "Corniche-facing residential towers spanning a wide age range, from 1990s stock to recent buildings, with high occupancy density throughout.",
    commonIssues: [
      "Older package and split AC systems at end of life, where parts availability decides repair or replace",
      "Drainage stacks under sustained heavy load from high occupancy, producing recurring blockages",
      "Common-area lighting and lift lobby finishes deferred by owners associations working to tight budgets",
      "Water pressure falling off on upper floors as booster pumps age",
    ],
    topServices: ["hvac-ac-maintenance", "plumbing", "electrical", "cleaning"],
    propertyTypes: ["Apartments", "Offices", "Retail units"],
    responseMinutes: 70,
  },
  {
    slug: "al-nahda-sharjah",
    name: "Al Nahda",
    city: "Sharjah",
    summary:
      "Meridian Facilities covers Al Nahda, Sharjah, a dense residential area on the Dubai border where high-occupancy apartment blocks generate steady demand for plumbing, AC and pest control work.",
    builtEnvironment:
      "Very high density residential on the Dubai border, dominated by mid-rise apartment blocks with high occupancy per unit.",
    commonIssues: [
      "Kitchen and bathroom drainage blockages driven by occupancy well above original design assumptions",
      "Cockroach and general pest pressure from shared risers and refuse areas, needing building-wide rather than unit-by-unit treatment",
      "AC units running continuously through summer with servicing intervals stretched past the point of efficiency",
      "Electrical circuits loaded beyond original design as unit occupancy increased",
    ],
    topServices: ["plumbing", "pest-control", "hvac-ac-maintenance", "electrical"],
    propertyTypes: ["Apartments", "Whole buildings"],
    responseMinutes: 65,
  },
  {
    slug: "muwaileh",
    name: "Muwaileh",
    city: "Sharjah",
    summary:
      "Meridian Facilities provides maintenance across Muwaileh, Sharjah, covering newer residential developments and the university district, where recently handed-over buildings show early-life defects rather than wear.",
    builtEnvironment:
      "Newer residential development alongside the university district, with a mix of apartments, townhouses and student-oriented accommodation. Much of the stock is recent enough that faults are commissioning defects, not wear.",
    commonIssues: [
      "Early-life defects in recently handed-over buildings that should be pursued as warranty claims first",
      "Student and shared accommodation with occupancy turnover driving frequent make-good and deep cleaning",
      "AC systems commissioned but never balanced, giving uneven cooling in an otherwise sound installation",
      "Common areas without a maintenance contract in place during the first year after handover",
    ],
    topServices: ["hvac-ac-maintenance", "deep-cleaning", "handyman", "building-maintenance"],
    propertyTypes: ["Apartments", "Townhouses", "Student accommodation"],
    responseMinutes: 70,
  },
  {
    slug: "al-khan",
    name: "Al Khan",
    city: "Sharjah",
    summary:
      "Meridian Facilities maintains lagoon-side apartments and mixed-use properties in Al Khan, Sharjah, where proximity to the lagoon brings humidity-driven problems that inland buildings do not see.",
    builtEnvironment:
      "Lagoon-side residential and mixed-use, mid-rise, with humidity consistently higher than inland Sharjah because of the water on one side and the sea on the other.",
    commonIssues: [
      "Mould in bathrooms and on external-wall corners driven by sustained humidity rather than a leak",
      "AC condensate volumes above design, overwhelming drain lines that were sized for drier conditions",
      "External paintwork and sealants degrading faster on lagoon-facing elevations",
      "Persistent damp smell in ground-floor units where ventilation was never adequate",
    ],
    topServices: ["hvac-ac-maintenance", "painting", "deep-cleaning", "waterproofing"],
    propertyTypes: ["Apartments", "Retail units", "Mixed-use buildings"],
    responseMinutes: 70,
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
