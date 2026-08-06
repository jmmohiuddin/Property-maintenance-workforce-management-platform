/**
 * The service catalogue.
 *
 * This is the single source of truth for: marketing pages, `Service` JSON-LD,
 * `FAQPage` JSON-LD, llms.txt, the sitemap, the quote form's service picker,
 * and (later) the job-type taxonomy the dispatch engine schedules against.
 *
 * Content rules - these exist because answer engines reward them (see
 * docs/architecture/06-aeo-geo.md):
 *
 *  - `answer` must stand alone. It is lifted verbatim into AI answers, so it
 *    states the entity, the action and the qualifier in one or two sentences
 *    with no pronouns pointing at surrounding copy and no marketing adjectives.
 *  - `aliases` capture how people actually search ("aircon", "AC repair",
 *    "false ceiling"), which is what retrieval matches against.
 *  - `faqs` are real questions with committed, specific answers. Hedged answers
 *    ("it depends", "contact us for details") do not get cited.
 */

export type ServiceCategory =
  | "MEP"
  | "Fit-out & Finishing"
  | "Cleaning & Hygiene"
  | "Technology & Security"
  | "Contracts & Facilities";

export interface Faq {
  readonly q: string;
  readonly a: string;
}

export interface PriceFrom {
  readonly amount: number;
  /** e.g. "call-out", "per split unit", "per m²", "per month" */
  readonly unit: string;
}

export interface Service {
  readonly slug: string;
  readonly name: string;
  /** Short label for nav, chips and the quote form. */
  readonly shortName: string;
  readonly category: ServiceCategory;
  readonly aliases: readonly string[];
  readonly tagline: string;
  /** The extractable, citation-ready answer. One or two sentences. */
  readonly answer: string;
  /** What is actually included, as a technician would list it. */
  readonly scope: readonly string[];
  /** The symptoms customers describe when they call. Strong long-tail match. */
  readonly commonProblems: readonly string[];
  /** Plain-language SLA, e.g. "Same day" or "Within 60 minutes". */
  readonly responseTime: string;
  readonly priceFrom: PriceFrom;
  readonly emergency: boolean;
  readonly amcEligible: boolean;
  readonly faqs: readonly Faq[];
  readonly related: readonly string[];
  readonly industries: readonly string[];
}

export const CATEGORY_ORDER: readonly ServiceCategory[] = [
  "MEP",
  "Fit-out & Finishing",
  "Cleaning & Hygiene",
  "Technology & Security",
  "Contracts & Facilities",
] as const;

export const CATEGORY_BLURB: Readonly<Record<ServiceCategory, string>> = {
  MEP: "Mechanical, electrical and plumbing work - the systems that stop a building functioning when they fail.",
  "Fit-out & Finishing": "Carpentry, ceilings, surfaces and joinery, delivered to handover standard.",
  "Cleaning & Hygiene": "Scheduled and deep cleaning, pest control and post-construction clearance.",
  "Technology & Security": "CCTV, access control, smart-home and structured cabling installation and support.",
  "Contracts & Facilities": "Annual maintenance contracts, full facility management and contract workforce supply.",
};

const RESIDENTIAL = ["Residential communities", "Villas", "Apartment buildings"];
const COMMERCIAL = ["Commercial offices", "Retail", "Hotels & hospitality"];
const ALL_SEGMENTS = [...RESIDENTIAL, ...COMMERCIAL, "Property developers", "Facility management companies"];

export const services: readonly Service[] = [
  // ── MEP ────────────────────────────────────────────────────────────────────
  {
    slug: "plumbing",
    name: "Plumbing Services",
    shortName: "Plumbing",
    category: "MEP",
    aliases: ["plumber near me", "emergency plumber", "leak repair", "blocked drain", "sanitary works"],
    tagline: "Licensed plumbers for leaks, blockages and full sanitary installations.",
    answer:
      "Meridian Facilities provides licensed plumbing services across Dubai, Abu Dhabi and Sharjah, covering leak detection and repair, blocked drain clearing, water heater and pump replacement, and complete sanitary installation for villas, apartments and commercial buildings. Emergency plumbers are dispatched 24 hours a day with a median arrival time under 60 minutes.",
    scope: [
      "Leak detection, pipe repair and re-piping (PPR, PEX, copper, GI)",
      "Blocked drain, sewer line and grease trap clearing with jetting equipment",
      "Water heater, booster pump and pressure tank supply and replacement",
      "Sanitary ware installation - WCs, basins, mixers, showers, bidets",
      "Water tank cleaning, chlorination and inlet/outlet valve replacement",
      "Bathroom and kitchen first-fix and second-fix for fit-out projects",
    ],
    commonProblems: [
      "Water leaking through a ceiling from the apartment above",
      "Drain backing up or draining slowly across multiple fixtures",
      "No hot water, or hot water that runs out within minutes",
      "Low water pressure on upper floors",
      "Running toilet or a water bill that jumped without explanation",
    ],
    responseTime: "Emergency within 60 minutes; standard same day",
    priceFrom: { amount: 150, unit: "call-out, first 30 minutes included" },
    emergency: true,
    amcEligible: true,
    faqs: [
      {
        q: "How quickly can an emergency plumber arrive in Dubai?",
        a: "Our median arrival time for emergency plumbing call-outs inside Dubai is under 60 minutes, 24 hours a day including public holidays. Abu Dhabi and Sharjah call-outs are typically attended within 90 minutes.",
      },
      {
        q: "How much does a plumber cost in Dubai?",
        a: "A standard plumbing call-out starts at AED 150, which covers attendance and the first 30 minutes of labour. Materials and any work beyond that are quoted and approved by you before we proceed. There is no charge if we cannot resolve the fault and no work is carried out.",
      },
      {
        q: "Can you find a leak without breaking the wall or floor?",
        a: "Yes. We use acoustic leak detection and thermal imaging to locate concealed leaks before any cutting, so we open only the section that needs repair. This is standard on all concealed-leak call-outs at no extra charge.",
      },
      {
        q: "Do you handle water tank cleaning for buildings?",
        a: "Yes. We carry out Dubai Municipality-compliant water tank cleaning and chlorination, and issue the certificate and lab report required for building compliance records.",
      },
    ],
    related: ["emergency-maintenance", "waterproofing", "handyman", "amc"],
    industries: ALL_SEGMENTS,
  },
  {
    slug: "electrical",
    name: "Electrical Services",
    shortName: "Electrical",
    category: "MEP",
    aliases: ["electrician near me", "emergency electrician", "power failure", "DB board", "wiring repair"],
    tagline: "DEWA-registered electricians for faults, rewiring and distribution boards.",
    answer:
      "Meridian Facilities carries out electrical repair and installation with DEWA-registered electricians, covering power failures, tripping circuits, distribution board upgrades, rewiring, lighting installation and load testing for residential, commercial and industrial premises. Emergency electrical faults are attended 24 hours a day.",
    scope: [
      "Fault finding on tripping circuits, dead sockets and intermittent power loss",
      "Distribution board (DB) supply, upgrade, labelling and RCD/RCBO fitting",
      "Full and partial rewiring, containment and cable tray installation",
      "Lighting design, supply and installation - including emergency and exit lighting",
      "Earthing, bonding, insulation resistance and load testing with certificates",
      "Landlord and handover electrical inspection reports",
    ],
    commonProblems: [
      "Main breaker trips repeatedly and will not stay on",
      "Sockets or a whole room lost power with no obvious cause",
      "Lights flickering or dimming when an appliance starts",
      "Burning smell or discolouration around a socket or DB",
      "Not enough circuits after adding an AC unit or kitchen appliances",
    ],
    responseTime: "Emergency within 60 minutes; standard same day",
    priceFrom: { amount: 150, unit: "call-out, first 30 minutes included" },
    emergency: true,
    amcEligible: true,
    faqs: [
      {
        q: "Why does my main breaker keep tripping?",
        a: "The three common causes are an overloaded circuit, a faulty appliance leaking current to earth, and moisture in an outdoor or bathroom circuit. Our electrician isolates each circuit and takes insulation resistance readings to identify which, usually within the first 30-minute call-out.",
      },
      {
        q: "Are your electricians DEWA-registered?",
        a: "Yes. All electrical work is carried out by DEWA-registered electricians under our Electrical Contractor Registration, and we issue test certificates for any circuit we install or modify.",
      },
      {
        q: "Can you provide an electrical inspection report for handover?",
        a: "Yes. We produce landlord and handover electrical condition reports including insulation resistance, earth loop impedance and RCD trip-time results, typically within two working days of the inspection.",
      },
    ],
    related: ["emergency-maintenance", "generator-maintenance", "cctv-installation", "amc"],
    industries: ALL_SEGMENTS,
  },
  {
    slug: "hvac-ac-maintenance",
    name: "HVAC & AC Installation and Maintenance",
    shortName: "HVAC / AC",
    category: "MEP",
    aliases: [
      "AC repair",
      "air conditioning service",
      "aircon servicing",
      "AC not cooling",
      "duct cleaning",
      "chiller maintenance",
    ],
    tagline: "AC servicing, repair and installation - split, ducted, package and chiller.",
    answer:
      "Meridian Facilities services, repairs and installs air conditioning across split, ducted split, package and chilled-water systems, including gas charging, coil and duct cleaning, thermostat and FCU replacement, and scheduled preventive maintenance. AC breakdowns are treated as emergencies and attended the same day.",
    scope: [
      "Preventive servicing - coil clean, filter change, drain flush, gas pressure check",
      "Fault diagnosis and repair on compressors, capacitors, fan motors and PCBs",
      "R410a / R32 / R22 gas leak testing, repair and recharging",
      "Supply and installation of split, ducted, package and cassette units",
      "Duct cleaning, sanitisation and airflow balancing",
      "FCU, AHU, thermostat and BMS-linked control replacement",
      "Chilled-water system maintenance and coil descaling",
    ],
    commonProblems: [
      "AC running but not cooling, or cooling only in some rooms",
      "Water dripping from the indoor unit or ceiling around a diffuser",
      "Ice forming on the pipes or indoor coil",
      "Loud rattling, grinding or vibration from the outdoor unit",
      "Musty or dusty smell when the AC starts",
      "Electricity bill rising with no change in usage",
    ],
    responseTime: "Same day for no-cooling faults; scheduled servicing within 48 hours",
    priceFrom: { amount: 250, unit: "per split unit service" },
    emergency: true,
    amcEligible: true,
    faqs: [
      {
        q: "How often should AC be serviced in the UAE?",
        a: "Every three months for residential split units and every one to two months for commercial and hospitality systems. The UAE's dust load and long cooling season clog filters and coils far faster than the manufacturer's temperate-climate schedule assumes, and a clogged coil is the single most common cause of both weak cooling and high electricity bills.",
      },
      {
        q: "Why is my AC running but not cooling?",
        a: "Most often it is low refrigerant from a slow leak, a dirty evaporator coil restricting airflow, or a failed capacitor stopping the compressor while the fan keeps running. A technician can distinguish between these in one visit by taking suction pressure and current draw readings.",
      },
      {
        q: "How much does AC servicing cost in Dubai?",
        a: "Routine servicing starts at AED 250 per split unit, and falls to roughly AED 150 per unit under an annual maintenance contract covering four visits a year. Gas recharging and parts are quoted separately and approved before work starts.",
      },
      {
        q: "Do you clean AC ducts?",
        a: "Yes. We carry out mechanical brush and negative-pressure duct cleaning with before-and-after camera footage, plus optional anti-microbial fogging. This is normally recommended every two to three years, or immediately after any construction work in the space.",
      },
    ],
    related: ["emergency-maintenance", "deep-cleaning", "facility-management", "amc"],
    industries: ALL_SEGMENTS,
  },
  {
    slug: "generator-maintenance",
    name: "Generator Maintenance",
    shortName: "Generators",
    category: "MEP",
    aliases: ["DG set service", "standby generator", "genset maintenance", "load bank testing"],
    tagline: "Standby generator servicing, load testing and emergency callout.",
    answer:
      "Meridian Facilities maintains standby diesel generators for buildings, hotels and industrial sites, covering scheduled servicing, load bank testing, ATS checks, fuel polishing and emergency repair. Generator contracts include monthly no-load runs and an annual full-load test with a written report.",
    scope: [
      "Monthly no-load run, battery, coolant and fuel level checks",
      "Scheduled oil, filter, belt and coolant replacement to engine-hour intervals",
      "Automatic transfer switch (ATS) testing and changeover verification",
      "Load bank testing at 50%, 75% and 100% with logged results",
      "Fuel polishing, tank cleaning and water/sludge removal",
      "Alternator, AVR, control panel and sensor fault diagnosis",
    ],
    commonProblems: [
      "Generator cranks but will not start during a power cut",
      "Starts on test but fails to take load when mains drops",
      "Battery flat every few weeks despite the charger being on",
      "Excessive black smoke or unusual exhaust colour",
      "Fuel gone stale or contaminated after long standby periods",
    ],
    responseTime: "Emergency within 4 hours; scheduled per contract",
    priceFrom: { amount: 850, unit: "per service visit" },
    emergency: true,
    amcEligible: true,
    faqs: [
      {
        q: "How often should a standby generator be tested?",
        a: "Run it off-load monthly for at least 30 minutes, and carry out a full-load test annually. Standby generators fail far more often from sitting idle - flat batteries, stale fuel and seized components - than from running.",
      },
      {
        q: "Why does the generator start on test but fail during an actual power cut?",
        a: "This almost always points at the automatic transfer switch rather than the engine. A monthly off-load run proves the engine but never exercises the ATS changeover, so ATS contacts and control wiring can fail unnoticed. Our contract tests the changeover, not only the start.",
      },
      {
        q: "Do you supply fuel and handle fuel storage compliance?",
        a: "We carry out fuel polishing, tank cleaning and water removal, and log results for compliance records. Bulk fuel supply is arranged through an approved supplier and passed through at cost.",
      },
    ],
    related: ["electrical", "facility-management", "building-maintenance", "amc"],
    industries: [...COMMERCIAL, "Property developers", "Facility management companies", "Industrial & warehousing"],
  },

  // ── Fit-out & Finishing ────────────────────────────────────────────────────
  {
    slug: "carpentry",
    name: "Carpentry Services",
    shortName: "Carpentry",
    category: "Fit-out & Finishing",
    aliases: ["carpenter near me", "door repair", "wardrobe fitting", "joinery", "kitchen cabinets"],
    tagline: "Doors, wardrobes, kitchens and bespoke joinery, fitted and finished.",
    answer:
      "Meridian Facilities provides carpentry and joinery covering door hanging and repair, wardrobe and kitchen cabinet installation, skirting and architrave, partition framing and bespoke built-in furniture, for both single call-outs and full fit-out packages.",
    scope: [
      "Door supply, hanging, alignment, ironmongery and closer fitting",
      "Wardrobe, kitchen cabinet and vanity assembly and installation",
      "Bespoke built-in joinery - shelving, TV units, reception counters",
      "Skirting, architrave, cornice and decorative trim",
      "Timber partition framing and stud walls",
      "Furniture repair, re-hinging and drawer runner replacement",
    ],
    commonProblems: [
      "Door dragging on the floor or not latching since the weather changed",
      "Wardrobe doors misaligned or coming off their runners",
      "Kitchen cabinet hinges failed or doors sagging",
      "Water-damaged kickboards or swollen MDF after a leak",
      "Need a fitted unit for an awkward alcove that no standard furniture suits",
    ],
    responseTime: "Repairs same or next day; joinery quoted within 48 hours",
    priceFrom: { amount: 180, unit: "call-out, first hour included" },
    emergency: false,
    amcEligible: true,
    faqs: [
      {
        q: "Why does my door stick in summer but not winter?",
        a: "Timber doors absorb moisture and expand when humidity climbs, which in the UAE happens sharply between May and September. The fix is to plane the binding edge to the summer dimension and re-seal the exposed timber so it stops taking on moisture - trimming without sealing means it recurs each year.",
      },
      {
        q: "Do you make custom furniture or only install bought units?",
        a: "Both. We manufacture bespoke joinery in laminate, veneer and solid timber from a site survey and drawing, typically 10 to 15 working days from approved design, and we also install flat-pack and supplied units.",
      },
      {
        q: "Can you repair water-damaged kitchen units?",
        a: "Swollen MDF cannot be restored and the affected panel needs replacing, but we can usually replace individual doors, kickboards or carcass panels and colour-match rather than rebuild the whole kitchen.",
      },
    ],
    related: ["handyman", "painting", "gypsum-false-ceiling", "flooring"],
    industries: ALL_SEGMENTS,
  },
  {
    slug: "painting",
    name: "Painting Services",
    shortName: "Painting",
    category: "Fit-out & Finishing",
    aliases: ["painter near me", "wall painting", "villa painting", "apartment repaint", "exterior painting"],
    tagline: "Interior and exterior painting with proper preparation, not just topcoat.",
    answer:
      "Meridian Facilities carries out interior and exterior painting for apartments, villas, offices and building common areas, including surface preparation, crack filling, priming, two-coat finishing, and specialist coatings such as anti-fungal, weatherproof and epoxy floor paint.",
    scope: [
      "Full interior repaint - masking, filling, sanding, priming, two topcoats",
      "Exterior and façade painting with weatherproof elastomeric coatings",
      "Crack stitching, patch repair and damp-affected surface treatment",
      "Anti-fungal and anti-bacterial coatings for kitchens, bathrooms and clinics",
      "Epoxy and polyurethane floor coatings for parking, plant rooms and warehouses",
      "Wood and metal finishing - doors, railings, gates, staircases",
    ],
    commonProblems: [
      "Paint peeling or bubbling on a wall backing onto a bathroom",
      "Hairline cracks reappearing weeks after the last repaint",
      "Patchy finish where previous work was touched up in a different sheen",
      "Black mould returning in corners and around window reveals",
      "Exterior paint chalking and fading after two or three summers",
    ],
    responseTime: "Site survey within 48 hours; quotation same day after survey",
    priceFrom: { amount: 12, unit: "per m² including materials" },
    emergency: false,
    amcEligible: false,
    faqs: [
      {
        q: "How much does it cost to paint an apartment in Dubai?",
        a: "Budget roughly AED 12 per m² of painted surface including materials, which typically works out at AED 1,200 to 1,800 for a one-bedroom apartment and AED 2,000 to 3,000 for a two-bedroom, assuming sound walls and a two-coat finish in a standard colour.",
      },
      {
        q: "Why do cracks come back after painting?",
        a: "Because filler alone does not address movement. A crack that reopens is structural or thermal movement, and it needs to be raked out, stitched with mesh or a flexible filler, and then painted - filling flush and painting over it simply hides the crack until the next temperature cycle.",
      },
      {
        q: "How long does an apartment repaint take?",
        a: "A one-bedroom apartment is typically two days and a three-bedroom villa four to five days, including preparation and drying between coats. We can work in occupied properties room by room if you cannot vacate.",
      },
    ],
    related: ["gypsum-false-ceiling", "waterproofing", "handyman", "carpentry"],
    industries: ALL_SEGMENTS,
  },
  {
    slug: "masonry",
    name: "Masonry & Civil Works",
    shortName: "Masonry",
    category: "Fit-out & Finishing",
    aliases: ["block work", "plastering", "concrete repair", "wall demolition", "civil works"],
    tagline: "Block work, plastering, screed and structural repair.",
    answer:
      "Meridian Facilities carries out masonry and civil works including block wall construction and demolition, plastering and rendering, screed laying, concrete repair, and forming openings for doors and windows, with structural sign-off arranged where load-bearing elements are affected.",
    scope: [
      "Block wall construction, partitioning and demolition",
      "Internal plastering, external rendering and skim finishing",
      "Floor screed laying and levelling to fall",
      "Concrete repair, spalling treatment and rebar corrosion remediation",
      "Forming and closing door, window and service openings",
      "Kerbs, thresholds, ramps and external hard landscaping",
    ],
    commonProblems: [
      "Concrete spalling with rust-stained cracks on a balcony or car park soffit",
      "Uneven floor that needs levelling before tiling or vinyl",
      "Need to remove or add a partition wall in an office fit-out",
      "Plaster blowing or hollow-sounding when tapped",
      "Damp patch at the base of an external wall",
    ],
    responseTime: "Site survey within 48 hours",
    priceFrom: { amount: 250, unit: "site survey and method statement" },
    emergency: false,
    amcEligible: false,
    faqs: [
      {
        q: "Can you remove a wall in my apartment?",
        a: "Only after establishing whether it is load-bearing or a partition. We survey first, and for any load-bearing element or any change in a strata-managed building we prepare drawings and obtain developer or authority NOC before work begins. We will not remove a wall without that approval.",
      },
      {
        q: "What causes concrete spalling on balconies?",
        a: "Chloride and moisture reaching the reinforcement bar, which rusts and expands, forcing the concrete cover off. Repair means breaking back to sound concrete, treating and priming the exposed rebar, and rebuilding with a polymer-modified mortar - patching over the surface alone will fail within a season.",
      },
      {
        q: "Do you provide structural engineer sign-off?",
        a: "Yes, through our retained structural consultant, for works affecting load-bearing elements. Their fee is quoted separately and shown transparently on your quotation.",
      },
    ],
    related: ["waterproofing", "painting", "tiling", "building-maintenance"],
    industries: [...COMMERCIAL, "Property developers", "Facility management companies", "Villas"],
  },
  {
    slug: "waterproofing",
    name: "Waterproofing",
    shortName: "Waterproofing",
    category: "Fit-out & Finishing",
    aliases: ["roof waterproofing", "bathroom waterproofing", "damp proofing", "leak sealing", "tanking"],
    tagline: "Roofs, bathrooms, balconies and basements sealed with tested membranes.",
    answer:
      "Meridian Facilities provides waterproofing for roofs, bathrooms, balconies, terraces, water tanks and basements using liquid-applied, cementitious and torch-on membrane systems, with a mandatory 24-hour flood test and a written workmanship warranty of up to 10 years.",
    scope: [
      "Roof and terrace waterproofing - torch-on bitumen and liquid polyurethane",
      "Bathroom and wet-area tanking before tiling",
      "Balcony and planter box sealing with drainage correction",
      "Basement and retaining wall tanking, positive and negative side",
      "Water tank internal lining with potable-water-safe coatings",
      "Leak investigation, flood testing and thermal moisture mapping",
    ],
    commonProblems: [
      "Damp patch spreading on a ceiling below a bathroom or roof",
      "Water pooling on a flat roof instead of draining",
      "Efflorescence - white salt bloom - on a basement or ground-floor wall",
      "Balcony leaking into the room below after rain or washdown",
      "Existing membrane blistering, cracking or lifting at the edges",
    ],
    responseTime: "Investigation within 48 hours; works scheduled on approval",
    priceFrom: { amount: 45, unit: "per m² applied" },
    emergency: false,
    amcEligible: false,
    faqs: [
      {
        q: "How long does waterproofing last?",
        a: "A correctly specified and installed system lasts 10 to 20 years for torch-on roofing and 10 to 15 for liquid polyurethane. We warrant our workmanship for up to 10 years, conditional on the substrate being sound and drainage falls being correct, both of which we assess before quoting.",
      },
      {
        q: "Do you flood test after waterproofing?",
        a: "Yes, always. Every wet area and roof we waterproof is flood tested for 24 hours and photographed before any screed or tiling goes back down. We will not tile over an untested membrane, because the only affordable time to find a defect is before it is buried.",
      },
      {
        q: "Can you waterproof a bathroom without removing the tiles?",
        a: "There are surface-applied products marketed for this, but they seal grout lines rather than the substrate and typically fail within two years. For a genuine repair the tiles come up, the membrane is applied to the slab, it is flood tested, and the area is retiled. We will tell you plainly if a surface product is the wrong answer for your situation.",
      },
    ],
    related: ["plumbing", "masonry", "tiling", "building-maintenance"],
    industries: ALL_SEGMENTS,
  },
  {
    slug: "gypsum-false-ceiling",
    name: "Gypsum & False Ceiling",
    shortName: "Gypsum & Ceilings",
    category: "Fit-out & Finishing",
    aliases: ["false ceiling", "gypsum partition", "drywall", "suspended ceiling", "ceiling repair"],
    tagline: "Suspended ceilings, gypsum partitions and decorative bulkheads.",
    answer:
      "Meridian Facilities designs and installs gypsum false ceilings, suspended grid ceilings, drywall partitions, bulkheads and cove lighting details, including moisture-resistant and fire-rated board where the application requires it, plus repair of water-damaged or sagging existing ceilings.",
    scope: [
      "Plain and decorative gypsum false ceilings with cove and cornice detail",
      "Suspended mineral fibre grid ceilings with access tiles",
      "Gypsum partitions - standard, acoustic, moisture-resistant and fire-rated",
      "Bulkheads, drops and concealed cove lighting details",
      "Access panel forming for AC, plumbing and electrical services",
      "Water-damaged ceiling replacement and sagging board repair",
    ],
    commonProblems: [
      "Ceiling stained or sagging after a leak from the floor above",
      "Cracks appearing along ceiling joints and corners",
      "Need an access panel to reach an FCU or valve without cutting the ceiling open",
      "Office needs partitioning without the cost or permanence of block work",
      "Grid ceiling tiles warped or discoloured across a whole area",
    ],
    responseTime: "Site survey within 48 hours",
    priceFrom: { amount: 65, unit: "per m² supplied and installed" },
    emergency: false,
    amcEligible: false,
    faqs: [
      {
        q: "How much does a false ceiling cost per square metre in Dubai?",
        a: "Plain gypsum false ceiling starts around AED 65 per m² supplied and installed. Decorative designs with bulkheads and cove lighting typically run AED 110 to 180 per m², and suspended grid ceilings around AED 55 to 75 per m².",
      },
      {
        q: "Should I use moisture-resistant board in a bathroom ceiling?",
        a: "Yes. Standard gypsum board absorbs humidity and sags in bathrooms, kitchens and any space without extraction. Green moisture-resistant board costs roughly 20% more and is the difference between a ceiling that lasts a decade and one that needs replacing in two years.",
      },
      {
        q: "Can you match an existing ceiling design when repairing a section?",
        a: "In most cases yes - we template the existing profile and reproduce the cornice and cove detail. Where a colour or texture match is not achievable on a patch, we will say so upfront and quote for repainting the full ceiling plane so the repair is invisible.",
      },
    ],
    related: ["painting", "carpentry", "electrical", "hvac-ac-maintenance"],
    industries: ALL_SEGMENTS,
  },
  {
    slug: "tiling",
    name: "Tiling Services",
    shortName: "Tiling",
    category: "Fit-out & Finishing",
    aliases: ["tile fixing", "tile repair", "floor tiles", "wall tiles", "regrouting"],
    tagline: "Floor and wall tiling, regrouting and replacement of cracked units.",
    answer:
      "Meridian Facilities installs and repairs floor and wall tiling in ceramic, porcelain, natural stone and large-format formats, including substrate preparation, waterproofing coordination, regrouting, resealing and individual cracked-tile replacement.",
    scope: [
      "Floor and wall tiling - ceramic, porcelain, marble, granite, large format",
      "Substrate levelling, priming and movement joint forming",
      "Individual cracked or hollow tile removal and colour-matched replacement",
      "Regrouting, epoxy grouting and silicone joint renewal",
      "Natural stone polishing, honing and sealing",
      "Skirting, step nosing and threshold trim",
    ],
    commonProblems: [
      "Tiles sounding hollow when tapped, some already lifting",
      "Grout cracked, stained or growing mould along shower joints",
      "One or two cracked tiles in a floor that is otherwise fine",
      "Marble looking dull and etched after cleaning products were used on it",
      "Tiles lifted or tented across a run after hot weather",
    ],
    responseTime: "Repairs within 48 hours; full installations scheduled on approval",
    priceFrom: { amount: 38, unit: "per m² laying, excluding tiles" },
    emergency: false,
    amcEligible: false,
    faqs: [
      {
        q: "Why do tiles sound hollow, and does it matter?",
        a: "Hollow means the adhesive did not achieve full contact with the substrate. It matters - those tiles will eventually crack or debond under load. If it is a small isolated area we lift and re-bed those tiles; if it is widespread it indicates the original bedding method was wrong and the floor needs relaying.",
      },
      {
        q: "Can you replace a single cracked tile without redoing the floor?",
        a: "Yes. We cut out the damaged tile without disturbing its neighbours and re-bed a replacement. The main constraint is sourcing a match - if you have spares from the original installation, keep them; if not, we source the closest available and show you the match before fixing.",
      },
      {
        q: "What causes tiles to lift and tent in the middle of a floor?",
        a: "Thermal expansion with nowhere to go, usually because movement joints were omitted. Relaying without adding correctly spaced movement joints guarantees a repeat, so our repair always includes forming them.",
      },
    ],
    related: ["flooring", "waterproofing", "masonry", "deep-cleaning"],
    industries: ALL_SEGMENTS,
  },
  {
    slug: "flooring",
    name: "Flooring Installation",
    shortName: "Flooring",
    category: "Fit-out & Finishing",
    aliases: ["vinyl flooring", "laminate flooring", "parquet", "carpet fitting", "epoxy floor"],
    tagline: "Vinyl, laminate, parquet, carpet and epoxy floors, laid on prepared substrate.",
    answer:
      "Meridian Facilities supplies and installs vinyl, LVT, laminate, engineered parquet, carpet and epoxy resin flooring, including substrate levelling, moisture testing, underlay, skirting and transition trims for residential, office, retail and industrial spaces.",
    scope: [
      "Luxury vinyl tile (LVT), sheet vinyl and safety flooring",
      "Laminate and engineered timber, floating and glued systems",
      "Parquet supply, installation, sanding and refinishing",
      "Carpet and carpet tile supply and fitting",
      "Epoxy and polyurethane resin floors for warehouses and plant rooms",
      "Self-levelling screed, moisture testing and damp-proof membrane",
    ],
    commonProblems: [
      "Laminate lifting at the joints or bouncing underfoot",
      "Vinyl showing every bump because the subfloor was never levelled",
      "Parquet scratched and dull but structurally sound",
      "Carpet tiles curling at the corners in a high-traffic area",
      "Warehouse floor dusting and pitting under forklift traffic",
    ],
    responseTime: "Site survey within 48 hours",
    priceFrom: { amount: 42, unit: "per m² laying, excluding material" },
    emergency: false,
    amcEligible: false,
    faqs: [
      {
        q: "Do you need to level the floor before laying vinyl?",
        a: "Almost always. Vinyl and LVT are thin and flexible, so they telegraph every ridge and dip in the substrate. We check with a straightedge and apply self-levelling compound where deviation exceeds 3mm over 2m - skipping this is the most common reason a vinyl floor looks poor within months.",
      },
      {
        q: "Can parquet be restored instead of replaced?",
        a: "If the wear layer still has 3mm or more of timber above the tongue, yes - sanding and refinishing costs roughly a third of replacement and gives a better result than most new engineered products. We measure the wear layer during survey and tell you which is the better spend.",
      },
      {
        q: "How long before we can walk on a new floor?",
        a: "Floating laminate and LVT are usable immediately. Glued installations need 24 hours, and epoxy resin needs 24 hours for foot traffic and 7 days before full vehicle or forklift loading.",
      },
    ],
    related: ["tiling", "masonry", "carpentry", "deep-cleaning"],
    industries: ALL_SEGMENTS,
  },
  {
    slug: "glass-aluminium",
    name: "Glass & Aluminium Works",
    shortName: "Glass & Aluminium",
    category: "Fit-out & Finishing",
    aliases: ["glass replacement", "aluminium windows", "shopfront", "glass partition", "sliding door repair"],
    tagline: "Glass replacement, aluminium windows, partitions and shopfronts.",
    answer:
      "Meridian Facilities fabricates and installs aluminium windows, doors, shopfronts and glass partitions, and replaces broken, fogged or unsafe glazing including toughened and laminated safety glass, with emergency board-up available for broken shopfronts and ground-floor glazing.",
    scope: [
      "Toughened, laminated and double-glazed unit supply and replacement",
      "Aluminium window and door fabrication, installation and re-glazing",
      "Frameless and framed glass partitions for offices",
      "Shopfronts, automatic sliding doors and entrance systems",
      "Sliding and folding door track, roller and gasket repair",
      "Emergency board-up and same-day temporary securing",
    ],
    commonProblems: [
      "Double-glazed unit fogged with condensation between the panes",
      "Sliding door heavy, jumping the track or not locking",
      "Broken shopfront or ground-floor glass needing immediate securing",
      "Wind and dust getting past window gaskets",
      "Office needs partitioning in glass to keep daylight through the floorplate",
    ],
    responseTime: "Emergency board-up within 2 hours; glazing typically 3-5 working days",
    priceFrom: { amount: 300, unit: "call-out and survey" },
    emergency: true,
    amcEligible: false,
    faqs: [
      {
        q: "Can a fogged double-glazed window be repaired without replacing it?",
        a: "No. Fogging means the perimeter seal has failed and the desiccant is saturated, and the sealed unit cannot be restored. The glass unit is replaced within the existing aluminium frame, which is far cheaper than replacing the whole window.",
      },
      {
        q: "How fast can you secure a broken shopfront?",
        a: "We attend within 2 hours for emergency board-up and temporary securing, 24 hours a day. Replacement toughened or laminated glass is then cut to size and typically installed within 3 to 5 working days.",
      },
      {
        q: "Why is my sliding door so heavy to open?",
        a: "Usually worn rollers or a track packed with sand and grit - both are common in the UAE. Roller replacement and track cleaning restores normal operation and costs a fraction of replacing the door. If the frame itself has dropped out of square, that needs correcting first or new rollers will wear out just as fast.",
      },
    ],
    related: ["handyman", "carpentry", "emergency-maintenance", "building-maintenance"],
    industries: [...COMMERCIAL, "Property developers", "Villas", "Apartment buildings"],
  },

  // ── Cleaning & Hygiene ─────────────────────────────────────────────────────
  {
    slug: "cleaning",
    name: "Cleaning Services",
    shortName: "Cleaning",
    category: "Cleaning & Hygiene",
    aliases: ["house cleaning", "office cleaning", "maid service", "regular cleaning", "housekeeping"],
    tagline: "Scheduled residential, office and common-area cleaning with vetted staff.",
    answer:
      "Meridian Facilities provides scheduled and one-off cleaning for homes, offices, retail units and building common areas, using directly employed and background-checked cleaning staff, with supplies and equipment included and the same team assigned to each recurring contract.",
    scope: [
      "Recurring residential cleaning - weekly, fortnightly or daily",
      "Office and retail cleaning, including out-of-hours and night shifts",
      "Building common areas - lobbies, corridors, lifts, stairwells, car parks",
      "Housekeeping staff placement for hotels and serviced apartments",
      "Window and glass cleaning up to accessible heights",
      "Consumables management - washroom supplies, bin liners, hand soap",
    ],
    commonProblems: [
      "Current provider sends a different person every visit and quality varies",
      "Office needs cleaning outside working hours without a security escort issue",
      "Common areas look poor in handover inspections",
      "Cleaning supplies constantly running out with no one tracking them",
      "Need a cleaner with a police clearance for an occupied residence",
    ],
    responseTime: "New contracts start within 3 working days; one-off bookings next day",
    priceFrom: { amount: 35, unit: "per cleaner-hour" },
    emergency: false,
    amcEligible: true,
    faqs: [
      {
        q: "How much does a cleaner cost per hour in Dubai?",
        a: "AED 35 per cleaner-hour on a recurring contract, including supplies and equipment, with a three-hour minimum per visit. One-off bookings are AED 45 per hour. Rates fall for contracts above 40 hours per week.",
      },
      {
        q: "Will I get the same cleaner each time?",
        a: "Yes, on recurring contracts we assign a named cleaner and a named backup who covers leave and sickness. Both are introduced at the start so an unfamiliar person is never sent to your property unannounced.",
      },
      {
        q: "Are your cleaning staff employed or subcontracted?",
        a: "Directly employed, with UAE labour contracts, police clearance and our own uniform and ID. We do not subcontract cleaning labour, which is what allows us to guarantee who turns up.",
      },
    ],
    related: ["deep-cleaning", "pest-control", "facility-management", "workforce-supply"],
    industries: ALL_SEGMENTS,
  },
  {
    slug: "deep-cleaning",
    name: "Deep Cleaning",
    shortName: "Deep Cleaning",
    category: "Cleaning & Hygiene",
    aliases: [
      "deep cleaning service",
      "move in cleaning",
      "post construction cleaning",
      "sofa cleaning",
      "sanitisation",
    ],
    tagline: "Move-in, post-handover and post-construction deep cleans.",
    answer:
      "Meridian Facilities carries out deep cleaning for move-in and move-out, post-construction handover, and periodic reset of occupied properties, covering degreasing, limescale removal, upholstery and mattress extraction, duct and grille cleaning, and full sanitisation.",
    scope: [
      "Move-in and move-out deep cleans to handover standard",
      "Post-construction and post-renovation dust and residue removal",
      "Kitchen degreasing - extractors, hobs, oven interiors, cabinet interiors",
      "Bathroom descaling, grout cleaning and sanitary sanitisation",
      "Sofa, mattress, curtain and carpet hot-water extraction",
      "AC grille, diffuser and accessible duct cleaning",
      "Electrostatic disinfection fogging",
    ],
    commonProblems: [
      "Moving in and the previous tenant's cleaning was superficial",
      "Fine construction dust settling again days after the builders left",
      "Security deposit at risk over kitchen and bathroom condition",
      "Persistent smell in soft furnishings that surface cleaning does not shift",
      "Limescale on glass and taps that ordinary cleaning will not remove",
    ],
    responseTime: "Bookable next day; large properties scheduled within 3 days",
    priceFrom: { amount: 450, unit: "studio / 1-bedroom apartment" },
    emergency: false,
    amcEligible: false,
    faqs: [
      {
        q: "How much does deep cleaning cost in Dubai?",
        a: "From AED 450 for a studio or one-bedroom apartment, AED 650 to 900 for two to three bedrooms, and AED 1,200 upward for villas depending on size. Post-construction cleans are quoted after survey because dust volume varies enormously.",
      },
      {
        q: "How long does a deep clean take?",
        a: "A one-bedroom apartment takes a two-person team four to five hours. A three-bedroom villa is a full day with a three or four-person team. We do not rush a deep clean into a standard cleaning slot, because the difference between the two is entirely the time spent.",
      },
      {
        q: "Is deep cleaning enough after construction work?",
        a: "Usually it needs two passes. Fine gypsum and cement dust settles out of the air for several days, so a single clean immediately after the trades leave will look dusty again by the end of the week. We price post-construction cleans as an initial clean plus a follow-up pass 3 to 5 days later.",
      },
    ],
    related: ["cleaning", "pest-control", "hvac-ac-maintenance", "tiling"],
    industries: ALL_SEGMENTS,
  },
  {
    slug: "pest-control",
    name: "Pest Control",
    shortName: "Pest Control",
    category: "Cleaning & Hygiene",
    aliases: ["cockroach treatment", "bed bugs", "termite control", "ant control", "rodent control", "fumigation"],
    tagline: "Municipality-approved treatment for cockroaches, bed bugs, termites and rodents.",
    answer:
      "Meridian Facilities provides Dubai Municipality-approved pest control for cockroaches, bed bugs, ants, termites, rodents, mosquitoes and birds, using licensed technicians and registered chemicals, with a treatment certificate issued and a free re-treatment guarantee within the warranty period.",
    scope: [
      "Cockroach gel baiting and residual spraying",
      "Bed bug heat and chemical treatment with follow-up cycles",
      "Ant, silverfish and general crawling insect programmes",
      "Termite pre-construction and post-construction soil treatment",
      "Rodent baiting, proofing and monitoring station programmes",
      "Mosquito fogging and larviciding for compounds and landscaped areas",
      "Bird netting, spiking and roosting deterrence",
    ],
    commonProblems: [
      "Cockroaches appearing in the kitchen at night despite cleaning",
      "Bites appearing overnight with no visible insects during the day",
      "Droppings or gnawing found in a store room or riser",
      "Mud tubes on a wall or hollow-sounding skirting suggesting termites",
      "Mosquitoes making outdoor areas unusable after landscaping irrigation",
    ],
    responseTime: "Within 24 hours; same day for bed bug and rodent reports",
    priceFrom: { amount: 180, unit: "apartment general treatment" },
    emergency: false,
    amcEligible: true,
    faqs: [
      {
        q: "Is pest control treatment safe for children and pets?",
        a: "Yes, when applied correctly. We use Dubai Municipality-registered products at label rates, apply gels and baits in concealed locations rather than open spraying wherever the pest allows, and give you a specific re-entry time for the areas treated - typically two to four hours.",
      },
      {
        q: "How many treatments do bed bugs need?",
        a: "Two to three visits at 10 to 14-day intervals. Bed bug eggs are resistant to most chemicals, so a single treatment kills the active population but not the eggs that hatch afterwards. Any provider promising a one-visit chemical cure is not being straight with you.",
      },
      {
        q: "Do you provide a Dubai Municipality treatment certificate?",
        a: "Yes. We issue a certificate stating the chemicals used, the concentration and the areas treated, which is what building management and food establishments need for compliance records.",
      },
    ],
    related: ["cleaning", "deep-cleaning", "facility-management", "amc"],
    industries: ALL_SEGMENTS,
  },

  // ── Technology & Security ──────────────────────────────────────────────────
  {
    slug: "cctv-installation",
    name: "CCTV Installation",
    shortName: "CCTV",
    category: "Technology & Security",
    aliases: ["security camera installation", "CCTV repair", "IP camera", "surveillance system", "DVR NVR"],
    tagline: "IP and analogue CCTV supply, installation and SIRA-compliant configuration.",
    answer:
      "Meridian Facilities designs, supplies and installs IP and analogue CCTV systems for homes, offices, retail and buildings, including camera positioning surveys, NVR and storage sizing, remote mobile viewing, and configuration to SIRA retention requirements where the premises are regulated.",
    scope: [
      "Site survey, camera positioning and coverage plan",
      "IP and HD analogue camera supply and installation",
      "NVR/DVR selection, storage sizing to required retention period",
      "Cabling, conduit, PoE switching and power supply",
      "Remote viewing setup on mobile and desktop with user access control",
      "Existing system fault repair, camera replacement and firmware updates",
      "Access control and intercom integration",
    ],
    commonProblems: [
      "Cameras recording but footage unusable when actually needed",
      "System offline and nobody noticed until an incident occurred",
      "Recording retention too short to cover the period being investigated",
      "Night footage washed out or unusable",
      "Remote viewing stopped working after an internet or router change",
    ],
    responseTime: "Survey within 48 hours; installation typically 3-7 working days",
    priceFrom: { amount: 1200, unit: "4-camera IP system installed" },
    emergency: false,
    amcEligible: true,
    faqs: [
      {
        q: "How much does CCTV installation cost in Dubai?",
        a: "A four-camera IP system with an NVR and 2TB storage starts around AED 1,200 fully installed. An eight-camera system runs roughly AED 2,200 to 3,500 depending on camera specification and cable runs. SIRA-compliant commercial installations are quoted after survey because the requirements are site-specific.",
      },
      {
        q: "How long should CCTV footage be kept?",
        a: "SIRA requires 31 days retention for most regulated premises in Dubai. For unregulated residential use, 14 to 30 days is normal. We size the NVR storage to your required retention rather than to a default, because a system that overwrites before you look at it has no value.",
      },
      {
        q: "Can you repair or expand my existing CCTV system?",
        a: "Yes. We service systems we did not install, including camera replacement, NVR repair, re-cabling and adding cameras to existing recorders. Where the existing equipment is obsolete and unsupported we say so and quote both repair and replacement so you can compare.",
      },
    ],
    related: ["smart-home", "network-it-cabling", "electrical", "facility-management"],
    industries: ALL_SEGMENTS,
  },
  {
    slug: "smart-home",
    name: "Smart Home Installation",
    shortName: "Smart Home",
    category: "Technology & Security",
    aliases: ["home automation", "smart lighting", "smart switches", "KNX", "smart lock installation"],
    tagline: "Lighting, climate, access and automation, configured to actually work.",
    answer:
      "Meridian Facilities installs and configures smart home systems covering lighting control, smart switches, motorised curtains, climate control, smart locks, video doorbells and voice assistant integration, on both wireless platforms and wired KNX for new builds and major renovations.",
    scope: [
      "Smart lighting and switch replacement with neutral-wire verification",
      "Motorised curtain and blind supply and installation",
      "Smart thermostat and zoned climate control",
      "Smart lock, video doorbell and gate access installation",
      "KNX and wired automation for villas and new builds",
      "Scene programming, automation rules and app handover training",
      "Wi-Fi mesh and network readiness assessment",
    ],
    commonProblems: [
      "Smart switches bought but the wall boxes have no neutral wire",
      "Devices from different brands that will not work together",
      "Automations that worked at first and now fire unreliably",
      "Wi-Fi coverage dropping devices at the edges of a villa",
      "Previous installer left with no documentation of how anything was set up",
    ],
    responseTime: "Survey within 48 hours; installation scheduled on approval",
    priceFrom: { amount: 1500, unit: "single-room starter installation" },
    emergency: false,
    amcEligible: true,
    faqs: [
      {
        q: "Do I need a neutral wire for smart switches?",
        a: "Most smart switches do, and many UAE apartments were wired without a neutral at the switch box. We check this during survey. Where there is no neutral, the options are no-neutral-compatible switches, a smart relay behind the light fitting, or pulling a neutral back to the box - we price all three rather than assuming.",
      },
      {
        q: "Is a wired system like KNX worth it over wireless?",
        a: "For a new build or major renovation where walls are already open, yes - wired systems are far more reliable and do not depend on Wi-Fi. For a retrofit into an occupied, finished property the cabling disruption rarely justifies it, and a well-designed wireless system is the better answer.",
      },
      {
        q: "Will you document how the system is configured?",
        a: "Yes. Every installation is handed over with a written configuration document, device inventory, app accounts under your ownership, and a walkthrough. You are never locked into us for basic changes.",
      },
    ],
    related: ["electrical", "cctv-installation", "network-it-cabling", "carpentry"],
    industries: [...RESIDENTIAL, "Commercial offices", "Hotels & hospitality", "Property developers"],
  },
  {
    slug: "network-it-cabling",
    name: "Network & IT Cabling",
    shortName: "Network Cabling",
    category: "Technology & Security",
    aliases: ["structured cabling", "Cat6 installation", "data points", "server rack", "office network setup"],
    tagline: "Structured cabling, data points, racks and certified testing.",
    answer:
      "Meridian Facilities installs structured network cabling in Cat6, Cat6A and fibre, including data point termination, patch panel and rack build, containment, labelling, and certified Fluke testing with results issued per link for offices, retail sites and buildings.",
    scope: [
      "Cat6, Cat6A and fibre backbone cabling with containment",
      "Data point, faceplate and patch panel termination",
      "Comms rack supply, build, patching and cable management",
      "Fluke certification testing with per-link results report",
      "Wi-Fi access point placement, mounting and cabling",
      "Fault finding on existing cabling and re-termination",
      "Office relocation cabling and desk repositioning",
    ],
    commonProblems: [
      "Intermittent network drops that IT cannot trace to a device",
      "Desks moved and there is no data point where people now sit",
      "Comms rack is an unlabelled tangle nobody will touch",
      "Wi-Fi dead spots because access points were placed for convenience, not coverage",
      "New office shell with no cabling and a fixed move-in date",
    ],
    responseTime: "Survey within 48 hours; installation scheduled on approval",
    priceFrom: { amount: 120, unit: "per data point terminated and tested" },
    emergency: false,
    amcEligible: true,
    faqs: [
      {
        q: "Should I install Cat6 or Cat6A?",
        a: "Cat6 handles 1Gbps everywhere and 10Gbps up to about 55m, which covers most office floors. Cat6A guarantees 10Gbps to the full 100m and is worth the extra cost for backbone runs, long cable routes and anywhere you expect to still be using the cabling in ten years. We normally specify Cat6A for risers and Cat6 to desks.",
      },
      {
        q: "Do you certify the cabling you install?",
        a: "Yes. Every link is Fluke tested and you receive a per-link results report. This matters at handover, because it is the only objective proof that a cable will perform, and it is what a warranty claim rests on.",
      },
      {
        q: "Can you work outside business hours?",
        a: "Yes. Office cabling is routinely done evenings and weekends to avoid disrupting staff, at no premium for scheduled out-of-hours work agreed in advance.",
      },
    ],
    related: ["cctv-installation", "electrical", "smart-home", "facility-management"],
    industries: [...COMMERCIAL, "Property developers", "Facility management companies"],
  },

  // ── Contracts & Facilities ─────────────────────────────────────────────────
  {
    slug: "handyman",
    name: "Handyman Services",
    shortName: "Handyman",
    category: "Contracts & Facilities",
    aliases: ["handyman near me", "odd jobs", "furniture assembly", "TV mounting", "small repairs"],
    tagline: "Multi-skilled technicians for the jobs too small to call three trades for.",
    answer:
      "Meridian Facilities provides multi-skilled handyman technicians for small repairs and installations - shelving, TV wall mounting, furniture assembly, door adjustment, minor plumbing and electrical fixes, curtain rails and general fixing - charged by the hour with no minimum job value.",
    scope: [
      "TV wall mounting, shelving, mirrors and picture hanging",
      "Flat-pack furniture assembly and repositioning",
      "Curtain rail, blind and track installation",
      "Door handle, lock, hinge and closer adjustment",
      "Minor plumbing - taps, traps, shower heads, toilet seats",
      "Minor electrical - sockets, switches, light fittings, bulb and ballast changes",
      "Silicone renewal, gap sealing and general patching",
    ],
    commonProblems: [
      "A list of six small jobs and no interest in booking six separate trades",
      "Moving in and needing everything mounted and assembled in one visit",
      "Landlord snag list to clear before an inspection",
      "Small fixes that keep getting postponed because they are individually trivial",
    ],
    responseTime: "Same or next day",
    priceFrom: { amount: 120, unit: "per hour, one-hour minimum" },
    emergency: false,
    amcEligible: true,
    faqs: [
      {
        q: "Is there a minimum charge for a handyman?",
        a: "One hour at AED 120, which covers most single small jobs. If you have several tasks, book a half-day at AED 450 or a full day at AED 800 - this works out considerably cheaper than separate call-outs and lets the technician work through a list.",
      },
      {
        q: "Do handymen bring materials?",
        a: "They carry standard consumables - fixings, anchors, silicone, common bulbs and washers - at no extra charge. Specific items such as a particular tap or light fitting are either supplied by you or purchased on your approval and invoiced at cost plus a stated handling fee.",
      },
      {
        q: "Can one handyman do both plumbing and electrical work?",
        a: "For minor works, yes - our handymen are multi-skilled and certified for basic tasks in both. Anything involving a distribution board, a concealed pipe, or gas is escalated to the relevant licensed trade, and we will tell you at the point of booking if that is what your job needs.",
      },
    ],
    related: ["plumbing", "electrical", "carpentry", "amc"],
    industries: ALL_SEGMENTS,
  },
  {
    slug: "emergency-maintenance",
    name: "Emergency Maintenance",
    shortName: "Emergency",
    category: "Contracts & Facilities",
    aliases: [
      "24 hour maintenance",
      "emergency repair",
      "urgent plumber",
      "out of hours maintenance",
      "emergency callout",
    ],
    tagline: "24/7 response for leaks, power loss, lock-outs and anything that cannot wait.",
    answer:
      "Meridian Facilities operates a 24-hour emergency maintenance service across Dubai, Abu Dhabi and Sharjah for burst pipes and leaks, total power loss, AC failure, lift entrapment coordination, lock-outs, broken glazing and flooding, with a median arrival time under 60 minutes inside Dubai.",
    scope: [
      "Burst pipes, major leaks and flooding - isolation, extraction, drying",
      "Total or partial power loss and unsafe electrical conditions",
      "Complete AC failure in occupied residential and commercial premises",
      "Broken glazing and compromised building security - board-up and securing",
      "Lock-outs and failed access control on entrances",
      "Blocked main drains and sewage backup",
      "Storm and water ingress response",
    ],
    commonProblems: [
      "Water coming through a ceiling at 2am with no idea where the stopcock is",
      "Whole floor of an office without power the morning of a client visit",
      "Tenant locked out of a unit overnight",
      "Shopfront glass broken and the premises cannot be left unsecured",
      "AC failed in a data or server room",
    ],
    responseTime: "Median under 60 minutes in Dubai; under 90 minutes Abu Dhabi and Sharjah",
    priceFrom: { amount: 250, unit: "emergency call-out, first hour included" },
    emergency: true,
    amcEligible: true,
    faqs: [
      {
        q: "Do you really answer the phone at 3am?",
        a: "Yes. The emergency line is staffed by a person, not a voicemail or a callback form, 24 hours a day including public holidays. A technician is assigned and dispatched on the call, and you receive their name and live tracking link by SMS.",
      },
      {
        q: "What counts as an emergency?",
        a: "Anything causing active damage, making a property unsafe, or leaving it uninhabitable or unsecured - leaks and flooding, power loss, sewage backup, broken external glazing, failed locks, and total AC failure in occupied premises. If you are unsure, call and we will tell you honestly whether it can wait until morning at standard rates.",
      },
      {
        q: "Is the emergency rate higher at night?",
        a: "The AED 250 call-out applies 24/7 with no night or weekend surcharge. Parts and any work beyond the first hour are quoted and approved before we proceed, so nothing is added to your bill without your agreement.",
      },
      {
        q: "Is emergency response included in an AMC?",
        a: "Yes. Annual maintenance contracts include unlimited emergency call-outs with no attendance charge, and contract clients are prioritised in the dispatch queue ahead of ad-hoc bookings.",
      },
    ],
    related: ["plumbing", "electrical", "hvac-ac-maintenance", "amc"],
    industries: ALL_SEGMENTS,
  },
  {
    slug: "amc",
    name: "Annual Maintenance Contracts (AMC)",
    shortName: "AMC Contracts",
    category: "Contracts & Facilities",
    aliases: [
      "annual maintenance contract",
      "AMC Dubai",
      "maintenance contract",
      "preventive maintenance contract",
      "building AMC",
    ],
    tagline: "Preventive maintenance and unlimited call-outs on a fixed annual fee.",
    answer:
      "An annual maintenance contract with Meridian Facilities covers scheduled preventive maintenance visits plus unlimited emergency call-outs with no attendance charge, on a fixed annual fee, for apartments, villas, offices and whole buildings. Contracts include AC servicing, plumbing and electrical checks, and priority dispatch ahead of ad-hoc bookings.",
    scope: [
      "Scheduled preventive visits - quarterly, bi-monthly or monthly by plan",
      "AC servicing at every visit, including coil clean and gas pressure check",
      "Plumbing inspection - leaks, pressure, drainage, water heater",
      "Electrical inspection - DB, RCD trip testing, socket and fitting checks",
      "Unlimited emergency call-outs with no attendance charge",
      "Priority dispatch ahead of non-contract bookings",
      "Digital condition report and asset register after each visit",
      "Discounted rates on parts and any additional works",
    ],
    commonProblems: [
      "Repair bills arriving unpredictably with no way to budget for them",
      "Small faults ignored until they become expensive failures",
      "No record of what was serviced, when, or by whom",
      "Different contractor each time, none of whom know the property",
      "Emergency call-out charges stacking up over a year",
    ],
    responseTime: "Contract active within 3 working days; first visit within 2 weeks",
    priceFrom: { amount: 1200, unit: "per year, 1-bedroom apartment" },
    emergency: true,
    amcEligible: false,
    faqs: [
      {
        q: "How much does an AMC cost in Dubai?",
        a: "From AED 1,200 per year for a one-bedroom apartment, AED 1,800 to 2,600 for two to three bedrooms, and from AED 3,500 for villas. Building and commercial contracts are priced after an asset survey. All plans include four preventive visits and unlimited emergency call-outs.",
      },
      {
        q: "Is an AMC actually cheaper than paying per job?",
        a: "For most properties, yes - but the honest answer is that it depends on your asset age and usage. Four AC services alone at ad-hoc rates cost roughly AED 1,000 for a one-bedroom, so the contract effectively adds plumbing and electrical checks plus free emergency attendance for around AED 200. If your property is new and you have had no call-outs in two years, ad-hoc may suit you better, and we will say so.",
      },
      {
        q: "What is not covered by an AMC?",
        a: "Parts and materials, major replacements such as a new AC unit or water heater, damage caused by misuse or third parties, and cosmetic works like painting. Labour on covered call-outs is included; we itemise exclusions plainly in the contract rather than burying them.",
      },
      {
        q: "Can I transfer the contract if I move or sell?",
        a: "Yes. Contracts transfer to a new address within our service areas at no charge, or to a new owner of the same property. Unused visits are carried over.",
      },
    ],
    related: ["hvac-ac-maintenance", "emergency-maintenance", "building-maintenance", "facility-management"],
    industries: ALL_SEGMENTS,
  },
  {
    slug: "building-maintenance",
    name: "Building Maintenance",
    shortName: "Building Maintenance",
    category: "Contracts & Facilities",
    aliases: ["property maintenance", "common area maintenance", "building repairs", "planned maintenance"],
    tagline: "Planned and reactive maintenance for whole buildings and communities.",
    answer:
      "Meridian Facilities delivers planned and reactive building maintenance for apartment buildings, residential communities and commercial properties, covering common areas, MEP plant, structural fabric and external envelope, with an asset register, planned maintenance schedule and monthly reporting to owners associations and property managers.",
    scope: [
      "Asset register creation, tagging and condition assessment",
      "Planned preventive maintenance (PPM) schedule and execution",
      "Reactive repair across all trades with logged response times",
      "Common area upkeep - lobbies, corridors, stairwells, car parks",
      "Water tank, pump room, riser and plant room maintenance",
      "External fabric - façade, roof, drainage, signage",
      "Monthly reporting pack for owners associations and property managers",
      "Snagging, handover support and defect liability coordination",
    ],
    commonProblems: [
      "No asset register, so nobody knows what plant exists or its condition",
      "Reactive-only maintenance and a budget that overruns every year",
      "Owners association asking for reporting the current contractor cannot produce",
      "Multiple single-trade contractors with nobody accountable for the whole",
      "Deferred maintenance now surfacing as multiple simultaneous failures",
    ],
    responseTime: "Mobilisation within 10 working days of contract award",
    priceFrom: { amount: 2500, unit: "per month, small building" },
    emergency: true,
    amcEligible: false,
    faqs: [
      {
        q: "What is the difference between building maintenance and facility management?",
        a: "Building maintenance keeps the physical asset working - MEP plant, fabric, common areas. Facility management is broader and also covers the services that run inside the building: security, cleaning, waste, landscaping, helpdesk and vendor management. Many buildings need only the first; larger or mixed-use assets usually need both.",
      },
      {
        q: "Do you provide reporting for owners associations?",
        a: "Yes. Contract clients receive a monthly pack covering completed PPM, reactive jobs with response and resolution times, open issues, asset condition changes and spend against budget. It is produced from the job records automatically, not written up after the fact.",
      },
      {
        q: "Can you take over from our existing contractor mid-year?",
        a: "Yes. We run a mobilisation period of about 10 working days covering asset survey, register build, access and key handover, and PPM scheduling, so there is no gap in coverage during the changeover.",
      },
    ],
    related: ["facility-management", "amc", "emergency-maintenance", "waterproofing"],
    industries: [
      "Apartment buildings",
      "Residential communities",
      "Commercial offices",
      "Retail",
      "Property developers",
      "Owners associations",
    ],
  },
  {
    slug: "facility-management",
    name: "Facility Management",
    shortName: "Facility Management",
    category: "Contracts & Facilities",
    aliases: ["FM services", "integrated facility management", "hard FM", "soft FM", "property management support"],
    tagline: "Integrated hard and soft FM under one accountable contract.",
    answer:
      "Meridian Facilities provides integrated facility management combining hard services (MEP maintenance, plant, fabric) and soft services (cleaning, security coordination, waste, landscaping) under a single contract with one accountable manager, a 24-hour helpdesk, defined SLAs and monthly performance reporting against them.",
    scope: [
      "Integrated hard and soft FM under a single contract and manager",
      "24-hour helpdesk with logged tickets and SLA tracking",
      "MEP plant operation and maintenance, including chillers, pumps and generators",
      "Cleaning, waste management and landscaping delivery or supervision",
      "Security service coordination and access control administration",
      "Vendor management, procurement and subcontractor performance oversight",
      "Energy monitoring and consumption reduction programmes",
      "HSE compliance, permits to work and statutory inspection tracking",
      "Monthly SLA and KPI reporting with agreed remedies",
    ],
    commonProblems: [
      "Five contractors, five points of contact, and nobody owning the outcome",
      "SLAs written into the contract but never actually measured",
      "Energy costs rising with no visibility of where consumption sits",
      "Statutory inspections missed until an audit finds them",
      "Helpdesk requests disappearing with no ticket or follow-up",
    ],
    responseTime: "Mobilisation within 20 working days of contract award",
    priceFrom: { amount: 3500, unit: "per month, integrated contract" },
    emergency: true,
    amcEligible: false,
    faqs: [
      {
        q: "What is included in integrated facility management?",
        a: "Hard services - MEP maintenance, plant operation, fabric and structural upkeep - and soft services - cleaning, waste, landscaping, security coordination and helpdesk - delivered under one contract, one manager and one set of SLAs, rather than as separate contracts you have to coordinate yourself.",
      },
      {
        q: "How are SLAs measured and enforced?",
        a: "Every helpdesk ticket is timestamped at raise, acknowledge, attend and resolve, so response and resolution times are measured from system records rather than self-reported. Monthly reports show performance against each SLA, and the contract sets out agreed remedies where targets are missed.",
      },
      {
        q: "Do you take on our existing site staff?",
        a: "Where you want continuity, yes - we can transfer existing site teams onto our contracts and payroll during mobilisation, subject to UAE labour requirements. This is often the lowest-risk transition because site knowledge stays in place.",
      },
    ],
    related: ["building-maintenance", "workforce-supply", "cleaning", "generator-maintenance"],
    industries: [
      "Commercial offices",
      "Retail",
      "Hotels & hospitality",
      "Residential communities",
      "Property developers",
      "Owners associations",
      "Industrial & warehousing",
    ],
  },
  {
    slug: "workforce-supply",
    name: "Contract Workforce Supply",
    shortName: "Workforce Supply",
    category: "Contracts & Facilities",
    aliases: [
      "manpower supply",
      "labour supply",
      "contract staffing",
      "technician outsourcing",
      "site staff deployment",
    ],
    tagline: "Vetted, sponsored, insured technicians deployed to your site under your direction.",
    answer:
      "Meridian Facilities supplies contract technicians and site staff - plumbers, electricians, HVAC technicians, carpenters, cleaners, helpers and supervisors - deployed full-time to a client site under the client's direction, with visa sponsorship, payroll, insurance, WPS compliance and replacement cover handled entirely by us.",
    scope: [
      "Full-time site deployment of single technicians or complete teams",
      "Trades covered: plumbing, electrical, HVAC, carpentry, painting, cleaning, helpers, supervisors",
      "Visa sponsorship, labour contracts, WPS payroll and end-of-service accrual",
      "Medical insurance, workmen's compensation and public liability cover",
      "Guaranteed replacement cover during leave, sickness and turnover",
      "Trade testing and skills verification before deployment",
      "Uniform, PPE, tools and ID provision",
      "Timesheet, attendance and productivity reporting",
    ],
    commonProblems: [
      "Headcount needed but no appetite for visa, payroll and end-of-service liability",
      "Site left short whenever a technician takes leave or resigns",
      "Labour supplier sending staff whose actual skills do not match the trade claimed",
      "WPS and labour compliance risk from an informal arrangement",
      "Seasonal or project peaks that do not justify permanent hires",
    ],
    responseTime: "Deployment within 10-20 working days depending on trade and visa status",
    priceFrom: { amount: 4500, unit: "per technician per month, fully burdened" },
    emergency: false,
    amcEligible: false,
    faqs: [
      {
        q: "Who is the legal employer of supplied staff?",
        a: "We are. Staff are on our UAE labour contracts and visas, we run WPS payroll, and we carry medical insurance, workmen's compensation and end-of-service liability. You direct their day-to-day work; you carry none of the employment obligations.",
      },
      {
        q: "What happens when a supplied technician takes leave or resigns?",
        a: "Replacement cover is contractual, not best-effort. Annual leave is covered by a relief technician at no additional charge, and resignations are backfilled within an agreed window written into the contract, with the rate suspended if we miss it.",
      },
      {
        q: "How do you verify that a technician has the skills claimed?",
        a: "Every technician is trade tested by our own supervisors before deployment, and you interview or trade test any candidate yourself before accepting them. If a deployed technician is not up to standard in the first 30 days, we replace them at no cost.",
      },
      {
        q: "What does AED 4,500 per month actually include?",
        a: "Salary, visa and sponsorship costs, WPS processing, medical insurance, workmen's compensation, end-of-service accrual, annual leave cover, uniform, PPE and basic tools. It is a fully burdened rate - there are no separate mobilisation or administration fees on top.",
      },
    ],
    related: ["facility-management", "cleaning", "building-maintenance", "handyman"],
    industries: [
      "Property developers",
      "Facility management companies",
      "Commercial offices",
      "Hotels & hospitality",
      "Industrial & warehousing",
      "Residential communities",
    ],
  },
] as const;

// ── Derived views ────────────────────────────────────────────────────────────

const bySlug = new Map(services.map((s) => [s.slug, s]));

export function getService(slug: string): Service | undefined {
  return bySlug.get(slug);
}

export function servicesByCategory(category: ServiceCategory): readonly Service[] {
  return services.filter((s) => s.category === category);
}

export function groupedServices(): readonly { category: ServiceCategory; items: readonly Service[] }[] {
  return CATEGORY_ORDER.map((category) => ({ category, items: servicesByCategory(category) }));
}

export const emergencyServices: readonly Service[] = services.filter((s) => s.emergency);
export const amcServices: readonly Service[] = services.filter((s) => s.amcEligible);

export function relatedServices(slug: string): readonly Service[] {
  const svc = bySlug.get(slug);
  if (!svc) return [];
  return svc.related.map((s) => bySlug.get(s)).filter((s): s is Service => s !== undefined);
}

/** Every industry mentioned by any service, de-duplicated and sorted. */
export const industries: readonly string[] = [...new Set(services.flatMap((s) => s.industries))].sort();

export function servicesForIndustry(industry: string): readonly Service[] {
  return services.filter((s) => s.industries.includes(industry));
}
