/**
 * The service catalogue.
 *
 * Single source of truth for: marketing pages, `Service` JSON-LD, `FAQPage`
 * JSON-LD, llms.txt, the sitemap, the quote form's service picker, and the job
 * taxonomy dispatch schedules against.
 *
 * ── WHAT CHANGED, AND WHY ───────────────────────────────────────────────────
 *
 * This file used to carry 24 services — pest control, CCTV, smart home,
 * network cabling, generator maintenance, waterproofing, workforce supply,
 * full facility management. **The DET licence permits ten activities.** Quoting
 * outside the licence is a licensing exposure, and a public page advertising
 * work the company is not licensed to do is the same exposure with a URL
 * attached. `WEB-1` rebuilds the catalogue one-to-one against the licence;
 * everything not on it is gone, not reworded.
 *
 * The old copy also carried claims nobody could evidence — a median arrival
 * time, a job count, an emirate-wide footprint on a Dubai mainland licence.
 * `WEB-2` deletes those rather than hedging them, on the principle that a claim
 * with no evidence is removed and the page is simply shorter and true.
 *
 * ── PRICING IS DELIBERATELY ABSENT ──────────────────────────────────────────
 *
 * There is no `priceFrom` on any service, and that is a decision rather than an
 * omission. The PRD is explicit that its market figures size the product's
 * numeric ranges and are *not* a pricing recommendation — pricing is a business
 * decision. Publishing an invented "from AED 150" would be the same class of
 * fabrication `WEB-2` exists to remove, and it would also be a schema.org
 * `Offer.price` claim made to Google.
 *
 * `WEB-16` is where prices belong: a published AED schedule of rates generated
 * from the system's own rate card (`QTE-4`), so the published number and the
 * quoted number cannot drift. Until that rate card exists, the pages say prices
 * are quoted per job. Research says a published price table is the single
 * highest-leverage asset available here, so this is a gap worth closing early —
 * with real numbers.
 *
 * ── CONTENT RULES ───────────────────────────────────────────────────────────
 *
 *  - `answer` must stand alone. It is lifted verbatim into AI answers, so it
 *    states the entity, the action and the qualifier in one or two sentences
 *    with no pronouns pointing at surrounding copy and no marketing adjectives.
 *  - `aliases` capture how people actually search ("aircon", "false ceiling"),
 *    which is what retrieval matches against.
 *  - `faqs` are real questions with committed, specific answers. Hedged answers
 *    ("it depends", "contact us for details") do not get cited — but a
 *    committed answer must be one the business can actually keep.
 */

import {
  LICENSED_ACTIVITY_REGISTER,
  licensedActivity,
  type LicensedActivity,
  type ServiceFamily,
} from "./company";

export interface Faq {
  readonly q: string;
  readonly a: string;
}

/**
 * How the work is shaped commercially. This is not cosmetic: a callout is a
 * `Job`, a project is a `Project` containing jobs, and recurring work is a
 * `Contract` that generates jobs. Getting it wrong at the catalogue level
 * produces the wrong object at the sharp end.
 */
export type JobArchetype = "callout" | "project" | "both" | "recurring";

/** Which SLA tier this work is normally raised at. Matches `JOB-4`. */
export type ResponseTier = "p1_emergency" | "p2_urgent" | "p3_standard" | "p4_planned";

export interface Service {
  readonly slug: string;
  readonly name: string;
  /** Short label for nav, chips and the quote form. */
  readonly shortName: string;
  /**
   * The licence line this service sits under.
   *
   * Every service must name one. This is the mechanism behind `JOB-17`: the
   * services reference data carries a licensed-activity reference, and the
   * quote builder warns when a line is categorised outside it (`QTE-9`).
   */
  readonly licensedActivity: LicensedActivity;
  readonly family: ServiceFamily;
  readonly archetype: JobArchetype;
  readonly aliases: readonly string[];
  readonly tagline: string;
  /** The extractable, citation-ready answer. One or two sentences. */
  readonly answer: string;
  /** What is actually included, as a technician would list it. */
  readonly scope: readonly string[];
  /** What is explicitly not included. Named up front, not discovered on site. */
  readonly exclusions: readonly string[];
  /** The symptoms customers describe when they call. Strong long-tail match. */
  readonly commonProblems: readonly string[];
  /** The tier this work is normally raised at, driving the stated commitment. */
  readonly defaultTier: ResponseTier;
  /** Can this be raised as a 24-hour emergency? */
  readonly emergency: boolean;
  /** Can this be covered by an annual maintenance contract? */
  readonly amcEligible: boolean;
  readonly faqs: readonly Faq[];
  readonly related: readonly string[];
}

export const CATEGORY_ORDER: readonly ServiceFamily[] = [
  "MEP",
  "Fit-out",
  "Finishes",
  "Soft services",
] as const;

export const CATEGORY_BLURB: Readonly<Record<ServiceFamily, string>> = {
  MEP: "Mechanical, electrical and plumbing — the systems that stop a building functioning when they fail.",
  "Fit-out": "Ceilings, tiling and joinery, built to handover standard.",
  Finishes: "Paint and wall coverings, from a touch-up to a whole villa.",
  "Soft services": "Scheduled building cleaning, by contract or by visit.",
};

/**
 * Response commitments, stated once and reused everywhere.
 *
 * These are the `JOB-4` tiers. They are the same numbers the SLA clock is
 * computed from, so a page cannot promise something dispatch is not measured
 * against — which is exactly how a 19-area, 60-minute promise turns into an SLA
 * breach generator.
 */
export const RESPONSE_COMMITMENT: Readonly<Record<ResponseTier, string>> = {
  p1_emergency: "Emergency — we respond within 30 to 60 minutes, 24 hours a day",
  p2_urgent: "Urgent — we respond within 2 to 4 hours during working hours",
  p3_standard: "Routine — we respond within 24 hours",
  p4_planned: "Planned — scheduled with you, by agreement",
};

export const services: readonly Service[] = [
  // ── MEP ────────────────────────────────────────────────────────────────────
  {
    slug: "plumbing-sanitary",
    name: "Plumbing and Sanitary Works",
    shortName: "Plumbing",
    licensedActivity: "plumbing-sanitary",
    family: "MEP",
    archetype: "both",
    aliases: [
      "plumber dubai",
      "emergency plumber",
      "leak repair",
      "blocked drain",
      "sanitary works",
      "water heater repair",
    ],
    tagline: "Leak repair, blocked drains and full sanitary installation.",
    answer:
      "Plumbing and sanitary works is a licensed activity on our Dubai DET trade licence, covering leak detection and pipe repair, blocked drain and sewer clearing, water heater and booster pump replacement, and complete sanitary installation for villas, apartments and commercial units. Leaks and burst pipes are treated as emergencies and attended 24 hours a day.",
    scope: [
      "Leak detection, pipe repair and re-piping in PPR, PEX, copper and GI",
      "Blocked drain, sewer line and grease trap clearing",
      "Water heater, booster pump and pressure vessel replacement",
      "Sanitary ware installation — WCs, basins, mixers, showers, bidets",
      "Water tank cleaning, chlorination and valve replacement",
      "First-fix and second-fix plumbing for fit-out work",
    ],
    exclusions: [
      "Work on the building's main incoming supply, which is the utility's responsibility",
      "Concealed pipework replacement requiring structural opening — quoted separately as a project",
      "Swimming pool circulation systems",
    ],
    commonProblems: [
      "Water coming through a ceiling from the unit above",
      "Drains backing up or emptying slowly across several fixtures",
      "No hot water, or hot water that runs out within minutes",
      "Low pressure on upper floors",
      "A running toilet, or a water bill that jumped without explanation",
    ],
    defaultTier: "p1_emergency",
    emergency: true,
    amcEligible: true,
    faqs: [
      {
        q: "Do you attend plumbing emergencies at night?",
        a: "Yes. A burst pipe or an active leak is treated as a P1 emergency and attended 24 hours a day, including public holidays. Our commitment is to respond within 30 to 60 minutes of the call.",
      },
      {
        q: "Are you licensed to carry out plumbing work in Dubai?",
        a: "Yes. Plumbing and sanitary works is one of the ten activities named on our Dubai Department of Economy and Tourism trade licence, number 930137. Ask to see it at any point.",
      },
      {
        q: "How is plumbing work priced?",
        a: "Reactive work is charged as a callout fee plus labour and materials, quoted and approved by you before we proceed. Installation and re-piping work is quoted as a fixed price against a written scope.",
      },
    ],
    related: ["hvac-installation-maintenance", "tiling", "electrical-fittings-repair"],
  },

  {
    slug: "electrical-fittings-repair",
    name: "Electrical Fittings Repair",
    shortName: "Electrical repair",
    licensedActivity: "electrical-fittings-repair",
    family: "MEP",
    archetype: "callout",
    aliases: [
      "electrician dubai",
      "socket not working",
      "light fitting repair",
      "tripping breaker",
      "electrical fault",
    ],
    tagline: "Faults, fittings and circuits inside the unit, put right.",
    answer:
      "Electrical fittings repair is a licensed activity on our Dubai DET trade licence, covering faulty sockets and switches, light fitting replacement, tripping circuits, and repair or replacement of fixed electrical accessories in villas, apartments and commercial units. Work touching the incoming supply, the meter or the main distribution board requires a DEWA-enrolled contractor and is outside this activity.",
    scope: [
      "Socket, switch and accessory replacement",
      "Light fitting repair and replacement, including recessed and track fittings",
      "Diagnosing a circuit that trips, and repairing the fault causing it",
      "Extractor fan, water heater and appliance connection faults",
      "Emergency and exit lighting fitting replacement",
    ],
    exclusions: [
      "Any work on the incoming supply, the meter or the main distribution board — this requires DEWA contractor enrolment",
      "New circuits or rewiring, which is electromechanical installation work",
      "Appliance internals — we repair the connection, not the appliance",
    ],
    commonProblems: [
      "A socket or switch that has stopped working, or is warm to the touch",
      "A breaker that trips as soon as it is reset",
      "Lights flickering on one circuit but not others",
      "Burning smell from a fitting — treated as an emergency",
      "An extractor fan or water heater that has no power",
    ],
    defaultTier: "p2_urgent",
    emergency: true,
    amcEligible: true,
    faqs: [
      {
        q: "Can you work on my distribution board or meter?",
        a: "No, and you should be careful of anyone who offers to. Work touching the supply, the meter, circuits or the main board requires company-level DEWA contractor enrolment. We will tell you when a job falls into that category rather than proceeding.",
      },
      {
        q: "Is a burning smell from a socket an emergency?",
        a: "Yes. Switch the circuit off at the board and call the emergency line. We treat it as a P1 and respond within 30 to 60 minutes.",
      },
    ],
    related: ["electromechanical-installation", "hvac-installation-maintenance"],
  },

  {
    slug: "hvac-installation-maintenance",
    name: "HVAC Installation and Maintenance",
    shortName: "HVAC / AC",
    licensedActivity: "hvac-installation-maintenance",
    family: "MEP",
    archetype: "both",
    aliases: [
      "ac repair dubai",
      "aircon service",
      "ac not cooling",
      "fcu maintenance",
      "split unit installation",
      "ac servicing contract",
    ],
    tagline: "AC that cools, on a callout or on a contract.",
    answer:
      "HVAC installation and maintenance is a licensed activity on our Dubai DET trade licence, covering split unit and fan coil unit servicing, gas charging, drain and coil cleaning, thermostat and control faults, and new installation. Preventive maintenance is normally sold as an annual contract with scheduled visits; a unit that has stopped cooling is attended as a callout.",
    scope: [
      "Split unit, ducted split and fan coil unit servicing",
      "Coil and drain pan cleaning, condensate line clearing",
      "Refrigerant leak diagnosis and gas charging",
      "Capacitor, contactor, fan motor and thermostat replacement",
      "New split and ducted split installation, including pipe runs and drainage",
      "Scheduled preventive maintenance under an annual contract",
    ],
    exclusions: [
      "Chiller plant and district cooling infrastructure, which belongs to the building operator",
      "Compressor and fan motor replacement under a comprehensive contract — quoted separately, as is standard in this market",
      "Duct replacement, which is quoted as a project",
    ],
    commonProblems: [
      "AC running but not cooling, or cooling only in some rooms",
      "Water dripping from an indoor unit or staining the ceiling below it",
      "Unit cutting out after a few minutes and restarting",
      "Ice forming on the pipework or the indoor coil",
      "A smell from the vents when the unit starts",
    ],
    defaultTier: "p2_urgent",
    emergency: true,
    amcEligible: true,
    faqs: [
      {
        q: "How often should AC be serviced in Dubai?",
        a: "Twice a year is the practical minimum in this climate and four visits a year is common for units running continuously. A maintenance contract schedules the visits so they happen before summer rather than during it.",
      },
      {
        q: "Is a compressor replacement covered by a maintenance contract?",
        a: "Not under a standard comprehensive contract. Compressors, fan motors and concealed pipework are the standard exclusions in this market and are quoted separately at the contract discount rate. Our contracts list every exclusion in writing rather than leaving it to be discovered.",
      },
      {
        q: "Can outdoor AC work be done at midday in summer?",
        a: "No, and not by anyone. Outdoor work in direct sun is prohibited between 12:30 and 15:00 from 15 June to 15 September. Our scheduling system refuses to place outdoor work in that window, so a visit will be offered outside it.",
      },
    ],
    related: ["electrical-fittings-repair", "electromechanical-installation", "building-cleaning"],
  },

  {
    slug: "electromechanical-installation",
    name: "Electromechanical Installation",
    shortName: "Electromechanical",
    licensedActivity: "electromechanical-installation",
    family: "MEP",
    archetype: "project",
    aliases: [
      "electromechanical contractor dubai",
      "mep installation",
      "new wiring",
      "pump installation",
      "mep fit out",
    ],
    tagline: "New MEP installation for fit-out and renovation.",
    answer:
      "Electromechanical installation is a licensed activity on our Dubai DET trade licence, covering new electrical and mechanical installation as part of a fit-out or renovation — circuits and containment, lighting and small power, pumps, extract and ventilation, and the mechanical services that go in behind the finishes. It is project work, priced against a written scope and billed against milestones.",
    scope: [
      "Containment, cable pulling, circuits and second-fix accessories",
      "Lighting and small power layouts for fit-out work",
      "Pump, tank and pressure system installation",
      "Extract, ventilation and associated ductwork",
      "Coordination of first fix with ceilings, tiling and joinery",
      "Testing, commissioning and handover documentation",
    ],
    exclusions: [
      "Work requiring DEWA contractor enrolment where we do not hold the relevant category — we will say so before quoting",
      "Authority permit fees, which are billed at cost",
      "Design and drawing production by a licensed consultant",
    ],
    commonProblems: [
      "A fit-out where the electrical layout no longer matches the approved drawing",
      "Insufficient circuits for a changed use, such as an office becoming a clinic",
      "Ventilation that was never balanced after handover",
      "Pump and tank arrangements that trip repeatedly under load",
    ],
    defaultTier: "p4_planned",
    emergency: false,
    amcEligible: false,
    faqs: [
      {
        q: "Do you handle the fit-out permit?",
        a: "In DDA jurisdiction areas the fit-out permit is applied for by the contractor, and we manage that application where we hold the contract. It needs a tenant appointment letter, an EJARI copy, stamped drawings and the relevant authority NOCs, and a Civil Defence completion certificate is required before completion. Fees are billed at cost.",
      },
      {
        q: "How is project work billed?",
        a: "Against milestones defined in the contract, not on completion. Each milestone has a value and a trigger — a date, a percentage of completion, or your sign-off — and raises its own invoice when reached. Variations are recorded and approved separately before they are carried out.",
      },
    ],
    related: ["electrical-fittings-repair", "hvac-installation-maintenance", "false-ceilings"],
  },

  // ── Fit-out ────────────────────────────────────────────────────────────────
  {
    slug: "false-ceilings",
    name: "False Ceilings",
    shortName: "False ceilings",
    licensedActivity: "false-ceilings",
    family: "Fit-out",
    archetype: "project",
    aliases: [
      "false ceiling dubai",
      "gypsum ceiling",
      "suspended ceiling",
      "ceiling repair",
      "gypsum partition",
    ],
    tagline: "Gypsum and suspended ceilings, built and made good.",
    answer:
      "False ceilings is a licensed activity on our Dubai DET trade licence, covering gypsum and suspended ceiling installation, bulkheads and coves, access panels, and making good after services work. Ceilings are project work: they are coordinated with the MEP first fix above them and finished ready for paint.",
    scope: [
      "Gypsum board ceilings on metal framing, including bulkheads and coves",
      "Suspended grid ceilings with mineral fibre or metal tiles",
      "Access panels and service coordination for the plant above",
      "Cornice, shadow gap and perimeter detailing",
      "Cutting and making good after plumbing, electrical or HVAC work",
      "Taping, jointing and finishing to a paint-ready surface",
    ],
    exclusions: [
      "Structural alterations to the slab or to load-bearing elements",
      "Fire-rated ceiling systems requiring a certified installer, unless separately agreed",
      "Painting, which is quoted as its own licensed activity",
    ],
    commonProblems: [
      "A ceiling stained or sagging after a leak from the services above",
      "No access panel where a valve or an FCU needs to be reached",
      "Cracking along joints, usually a jointing rather than a structural problem",
      "Ceiling cut open for a repair and never made good",
    ],
    defaultTier: "p4_planned",
    emergency: false,
    amcEligible: false,
    faqs: [
      {
        q: "Can you repair a ceiling after a water leak?",
        a: "Yes, and the order matters: the leak has to be fixed and the area dried before the ceiling is closed up, or the repair fails and the second one costs more than the first. We will say so rather than close it up on the same visit.",
      },
      {
        q: "Do you paint the ceiling as well?",
        a: "Yes. Painting is separately licensed to us, so both parts of the job are ours and there is no gap between two trades to argue about.",
      },
    ],
    related: ["painting", "electromechanical-installation", "carpentry"],
  },

  {
    slug: "tiling",
    name: "Tiling",
    shortName: "Tiling",
    licensedActivity: "tiling",
    family: "Fit-out",
    archetype: "project",
    aliases: ["tiling dubai", "floor tiles", "bathroom tiling", "tile repair", "regrouting", "tiler"],
    tagline: "Floor and wall tiling, laid to stay laid.",
    answer:
      "Tiling is a licensed activity on our Dubai DET trade licence, covering floor and wall tiling in ceramic, porcelain and natural stone, screed and substrate preparation, waterproofing to wet areas, grouting and sealing, and repair of failed or drummy tiling. Tiling is project work, quoted per area against a written scope.",
    scope: [
      "Floor and wall tiling in ceramic, porcelain and natural stone",
      "Substrate preparation, levelling screed and priming",
      "Wet-area tanking before tiling in bathrooms and balconies",
      "Grouting, silicone sealing and movement joints",
      "Skirting, thresholds and trim detailing",
      "Removal and replacement of failed, cracked or drummy tiling",
    ],
    exclusions: [
      "Structural floor repairs and slab levelling beyond a screed",
      "Supply of specified imported stone, unless separately quoted",
      "External waterproofing systems requiring a specialist applicator warranty",
    ],
    commonProblems: [
      "Tiles sounding hollow underfoot, which means the bed has failed",
      "Cracked grout lines letting water into the bed below",
      "Bathroom tiling laid without tanking, showing damp on the far side of the wall",
      "A balcony that ponds water instead of draining",
    ],
    defaultTier: "p4_planned",
    emergency: false,
    amcEligible: false,
    faqs: [
      {
        q: "Why do tiles sound hollow?",
        a: "The adhesive bed has failed, usually because the substrate was not primed or the tiles were laid with insufficient coverage. Regrouting will not fix it — the affected area has to be lifted and re-laid, and we will quote it that way rather than sell you a cosmetic repair.",
      },
      {
        q: "Do you waterproof before tiling a bathroom?",
        a: "Yes, on every wet area, and it is on the quote as its own line so you can see it is there. Tiling a wet area without tanking is the single most common cause of damp in a neighbouring room.",
      },
    ],
    related: ["plumbing-sanitary", "painting", "carpentry"],
  },

  {
    slug: "carpentry",
    name: "Carpentry",
    shortName: "Carpentry",
    licensedActivity: "carpentry",
    family: "Fit-out",
    archetype: "both",
    aliases: ["carpenter dubai", "door repair", "wardrobe installation", "joinery", "kitchen cabinets"],
    tagline: "Doors, joinery and fitted furniture — repaired or built.",
    answer:
      "Carpentry is a licensed activity on our Dubai DET trade licence, covering door hanging and repair, ironmongery, fitted wardrobes and kitchen units, skirting and architrave, and general joinery. Small repairs are attended as a callout; fitted joinery is quoted as project work.",
    scope: [
      "Door hanging, adjustment and replacement, including fire doors",
      "Lock, hinge, closer and handle replacement",
      "Fitted wardrobe and kitchen unit installation",
      "Skirting, architrave, shelving and trim",
      "Repair of swollen, warped or water-damaged joinery",
      "Second-fix carpentry for fit-out work",
    ],
    exclusions: [
      "Structural timber and roof carpentry",
      "Manufacture of bespoke furniture, as opposed to installation",
      "Glass and aluminium work, which is not on our licence",
    ],
    commonProblems: [
      "A door that catches on the frame or will not latch",
      "Wardrobe doors out of alignment, or runners that have failed",
      "Kitchen units swollen at the base after a slow leak",
      "A door closer that has stopped holding a fire door shut",
    ],
    defaultTier: "p3_standard",
    emergency: false,
    amcEligible: true,
    faqs: [
      {
        q: "Can you make a bespoke wardrobe?",
        a: "We install fitted joinery and we repair and adapt existing units. Manufacture of bespoke furniture from scratch is not on our licence, and we would rather say so than subcontract it without telling you.",
      },
      {
        q: "Do you work on glass or aluminium doors?",
        a: "No. Glass and aluminium is not one of the ten activities on our licence. We will tell you at the point of enquiry rather than at the point of invoice.",
      },
    ],
    related: ["painting", "false-ceilings", "tiling"],
  },

  // ── Finishes ───────────────────────────────────────────────────────────────
  {
    slug: "painting",
    name: "Painting",
    shortName: "Painting",
    licensedActivity: "painting",
    family: "Finishes",
    archetype: "both",
    aliases: ["painter dubai", "villa painting", "apartment painting", "wall painting", "repainting"],
    tagline: "Preparation first, then paint. A whole villa or one wall.",
    answer:
      "Painting is a licensed activity on our Dubai DET trade licence, covering interior and exterior painting for villas, apartments and commercial units, including surface preparation, filling and sanding, priming, and finish coats. A touch-up after a repair is a callout; a full repaint is project work, quoted per area against a written scope.",
    scope: [
      "Interior painting — walls, ceilings, joinery and trim",
      "Exterior painting, including elevations and boundary walls",
      "Surface preparation: filling, sanding, crack repair and priming",
      "Making good after plumbing, electrical, ceiling or tiling work",
      "Anti-fungal treatment to bathrooms and consistently damp areas",
      "Move-out and handover redecoration",
    ],
    exclusions: [
      "Structural crack repair, as opposed to filling a surface crack",
      "Waterproofing systems, which are not on our licence",
      "Specialist coatings requiring an applicator warranty, such as epoxy floors",
    ],
    commonProblems: [
      "Paint flaking or blistering in a bathroom or kitchen, which is a damp problem rather than a paint one",
      "Patch repairs that show through as a different sheen",
      "Hairline cracks reopening within months of the last decoration",
      "Exterior paint chalking on a south or west elevation",
    ],
    defaultTier: "p4_planned",
    emergency: false,
    amcEligible: true,
    faqs: [
      {
        q: "Why does the paint in my bathroom keep flaking?",
        a: "Almost always moisture behind the surface rather than the paint itself, so repainting alone will fail again. We look for the source first — extract that is not running, a leak from the far side of the wall, tiling laid without tanking — and quote the fix and the redecoration together.",
      },
      {
        q: "Can you paint the outside of a villa in summer?",
        a: "Yes, but not between 12:30 and 15:00 from 15 June to 15 September. Outdoor work in direct sun is prohibited in that window and our scheduling refuses to place it there, so exterior work is planned around it.",
      },
    ],
    related: ["wallpaper", "false-ceilings", "tiling"],
  },

  {
    slug: "wallpaper",
    name: "Wallpaper",
    shortName: "Wallpaper",
    licensedActivity: "wallpaper",
    family: "Finishes",
    archetype: "project",
    aliases: ["wallpaper installation dubai", "wall covering", "wallpaper removal", "feature wall"],
    tagline: "Hung straight, on a wall that was prepared for it.",
    answer:
      "Wallpaper is a licensed activity on our Dubai DET trade licence, covering supply and installation of wall coverings, removal of existing paper, and the surface preparation that determines whether the result lasts. It is project work, quoted per wall or per room against a written scope.",
    scope: [
      "Installation of paper, vinyl and non-woven wall coverings",
      "Removal of existing wallpaper and adhesive residue",
      "Surface preparation: filling, sanding, sizing and priming",
      "Pattern matching, feature walls and full-room coverage",
      "Repair of lifted seams and bubbled sections",
    ],
    exclusions: [
      "Supply of specified imported coverings, unless separately quoted",
      "Fabric and specialist upholstered wall systems",
      "Damp remediation behind a wall — that is diagnosed and quoted before any covering goes on",
    ],
    commonProblems: [
      "Seams lifting within weeks, usually an unprimed or dusty surface",
      "Bubbling across a whole wall, which is moisture rather than adhesive",
      "Old paper removed badly, leaving a surface that will not take a new covering",
    ],
    defaultTier: "p4_planned",
    emergency: false,
    amcEligible: false,
    faqs: [
      {
        q: "Can you hang wallpaper over the existing paper?",
        a: "We do not recommend it and generally will not. Whatever is wrong with the layer underneath — lifting seams, damp, dust — becomes wrong with the new one within months, and the second removal costs more than the first.",
      },
    ],
    related: ["painting", "false-ceilings"],
  },

  // ── Soft services ──────────────────────────────────────────────────────────
  {
    slug: "building-cleaning",
    name: "Building Cleaning",
    shortName: "Cleaning",
    licensedActivity: "building-cleaning",
    family: "Soft services",
    archetype: "recurring",
    aliases: [
      "building cleaning dubai",
      "common area cleaning",
      "deep cleaning",
      "post construction cleaning",
      "cleaning contract",
    ],
    tagline: "Common areas and units, on a schedule that holds.",
    answer:
      "Building cleaning is a licensed activity on our Dubai DET trade licence, covering common-area cleaning for residential and commercial buildings, deep cleaning of units, and post-construction and handover cleaning. It is normally sold as a scheduled contract with a defined scope and frequency rather than as one-off visits.",
    scope: [
      "Common area cleaning — lobbies, corridors, stairwells, lifts, car parks",
      "Scheduled cleaning under an annual contract, at agreed frequencies",
      "Deep cleaning of apartments, villas and commercial units",
      "Post-construction and post-handover cleaning",
      "Move-in and move-out cleaning",
      "Cleaning following maintenance or fit-out work",
    ],
    exclusions: [
      "Pest control, which is not on our licence",
      "Facade and rope-access cleaning, which requires EIAC-accredited certified personnel",
      "Waste removal and disposal beyond what the building's own arrangements accept",
    ],
    commonProblems: [
      "Common areas cleaned to no defined standard, so nobody can say whether the contract was met",
      "A handover blocked by construction dust that the fit-out contractor left behind",
      "Cleaning scheduled at a frequency that does not match the actual footfall",
    ],
    defaultTier: "p4_planned",
    emergency: false,
    amcEligible: true,
    faqs: [
      {
        q: "Do you clean building facades?",
        a: "No. Facade cleaning at height requires rope-access personnel certified by an EIAC-accredited body, which is a separate competency we do not hold. We will say so rather than take the work.",
      },
      {
        q: "How is a cleaning contract scoped?",
        a: "By area, task and frequency, written down — which lobbies, how often, and what 'clean' means for each. A contract that says 'common areas, daily' is unenforceable by either side, and at renewal neither party can show whether it was delivered.",
      },
    ],
    related: ["painting", "hvac-installation-maintenance"],
  },
] as const;

// ── Lookups ──────────────────────────────────────────────────────────────────

export function getService(slug: string): Service | undefined {
  return services.find((s) => s.slug === slug);
}

export function servicesInFamily(family: ServiceFamily): readonly Service[] {
  return services.filter((s) => s.family === family);
}

/** Services that can be raised as a 24-hour emergency. */
export const emergencyServices: readonly Service[] = services.filter((s) => s.emergency);

/** Services an annual maintenance contract can cover. */
export const amcServices: readonly Service[] = services.filter((s) => s.amcEligible);

export interface ServiceGroup {
  readonly category: ServiceFamily;
  readonly blurb: string;
  readonly items: readonly Service[];
}

/**
 * The catalogue grouped by family, in a fixed order.
 *
 * A family with no services is omitted rather than rendered empty — every
 * family currently has at least one, and the filter is here so that stays true
 * without a page needing to know.
 */
export function groupedServices(): readonly ServiceGroup[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    blurb: CATEGORY_BLURB[category],
    items: servicesInFamily(category),
  })).filter((g) => g.items.length > 0);
}

/**
 * The services listed as `related` on this one, resolved and in order.
 *
 * A related slug that no longer resolves is dropped rather than crashing the
 * page — WEB-1 deleted fourteen services, and a stale cross-reference should
 * cost a card on a page, not the page.
 */
export function relatedServices(service: Service): readonly Service[] {
  return service.related
    .map((slug) => getService(slug))
    .filter((s): s is Service => s !== undefined);
}

/** The commitment text for a service, from its default tier. */
export function responseCommitment(service: Service): string {
  return RESPONSE_COMMITMENT[service.defaultTier];
}

/**
 * Every service maps to a licence line, and every licence line has at least one
 * service.
 *
 * Called by a test rather than at import time. The first half is what stops the
 * catalogue drifting past the licence; the second is what stops a licensed
 * activity quietly having no page, which `WEB-1` requires it to have.
 */
export function catalogueLicenceMismatches(): readonly string[] {
  const problems: string[] = [];

  for (const service of services) {
    try {
      licensedActivity(service.licensedActivity);
    } catch {
      problems.push(`Service "${service.slug}" names an activity that is not on the licence.`);
    }
  }

  for (const activity of LICENSED_ACTIVITY_REGISTER) {
    if (!services.some((s) => s.licensedActivity === activity.key)) {
      problems.push(`Licensed activity "${activity.licenceWording}" has no service page.`);
    }
  }

  const familyMismatch = services.filter((s) => licensedActivity(s.licensedActivity).family !== s.family);
  for (const s of familyMismatch) {
    problems.push(
      `Service "${s.slug}" is filed under ${s.family} but its licence activity is ${licensedActivity(s.licensedActivity).family}.`,
    );
  }

  return problems;
}
