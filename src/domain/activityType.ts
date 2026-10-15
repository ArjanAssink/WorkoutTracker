/**
 * Apple's HealthKit workout types are a long, awkward enum (`HKWorkoutActivityTypeRunning`).
 * Shortcuts, meanwhile, hands you the display name ("Outdoor Run"). We normalise both into
 * a small set of slugs so a workout logged by the Shortcut and the same workout found later
 * in an export.xml collapse onto the same identity and the same MET value.
 */

export type ActivityType = string;

/** Fallback used when we cannot recognise the incoming label at all. */
export const UNKNOWN_ACTIVITY: ActivityType = "other";

/**
 * Metabolic equivalents, roughly per the Compendium of Physical Activities (2024 update),
 * picking a moderate-intensity entry for each. These only drive the MET-minute effort
 * estimate, which is the fallback for workouts with no heart-rate data.
 */
const MET_BY_ACTIVITY: Record<string, number> = {
  running: 9.8,
  walking: 3.5,
  hiking: 6.0,
  cycling: 7.5,
  swimming: 7.0,
  rowing: 7.0,
  elliptical: 5.0,
  stairclimbing: 8.8,
  strength: 5.0,
  functionalstrength: 5.5,
  hiit: 8.0,
  coretraining: 4.0,
  yoga: 2.5,
  pilates: 3.0,
  dance: 5.5,
  boxing: 7.8,
  martialarts: 10.3,
  tennis: 7.3,
  soccer: 7.0,
  basketball: 6.5,
  golf: 4.8,
  skiing: 7.0,
  snowboarding: 5.3,
  skating: 7.0,
  surfing: 3.0,
  climbing: 8.0,
  jumprope: 12.3,
  cooldown: 2.0,
  flexibility: 2.3,
  taichi: 3.0,
  paddlesports: 5.0,
  underwaterdiving: 7.0,
  barre: 3.0,
  badminton: 5.5,
  tabletennis: 4.0,
  volleyball: 4.0,
  handball: 8.0,
  hockey: 8.0,
  rugby: 8.3,
  equestrian: 5.5,
  bowling: 3.0,
  archery: 4.3,
  wrestling: 6.0,
  waterfitness: 5.5,
  sailing: 3.0,
  wheelchair: 3.5,
  crosstraining: 6.0,
  mixedcardio: 6.0,
  other: 4.0,
};

/**
 * Maps a raw label onto a slug. Keys are compared after stripping the
 * `HKWorkoutActivityType` prefix, lowercasing, and removing non-alphanumerics, so
 * "Outdoor Run", "outdoor_run" and "HKWorkoutActivityTypeRunning" all land here.
 */
const ALIASES: Record<string, ActivityType> = {
  running: "running",
  run: "running",
  outdoorrun: "running",
  indoorrun: "running",
  treadmill: "running",
  trailrun: "running",
  walking: "walking",
  walk: "walking",
  outdoorwalk: "walking",
  indoorwalk: "walking",
  hiking: "hiking",
  hike: "hiking",
  cycling: "cycling",
  cycle: "cycling",
  biking: "cycling",
  outdoorcycle: "cycling",
  indoorcycle: "cycling",
  // Health Auto Export writes the long names: "Outdoor Cycling", "Outdoor Running", "Indoor Walking"…
  outdoorcycling: "cycling",
  indoorcycling: "cycling",
  outdoorrunning: "running",
  indoorrunning: "running",
  outdoorwalking: "walking",
  indoorwalking: "walking",
  swimming: "swimming",
  swim: "swimming",
  poolswim: "swimming",
  openwaterswim: "swimming",
  rowing: "rowing",
  row: "rowing",
  indoorrow: "rowing",
  elliptical: "elliptical",
  stairclimbing: "stairclimbing",
  stairs: "stairclimbing",
  stepper: "stairclimbing",
  traditionalstrengthtraining: "strength",
  strengthtraining: "strength",
  strength: "strength",
  weighttraining: "strength",
  functionalstrengthtraining: "functionalstrength",
  functionalstrength: "functionalstrength",
  highintensityintervaltraining: "hiit",
  hiit: "hiit",
  intervaltraining: "hiit",
  coretraining: "coretraining",
  core: "coretraining",
  yoga: "yoga",
  pilates: "pilates",
  mindandbody: "yoga",
  dance: "dance",
  cardiodance: "dance",
  socialdance: "dance",
  boxing: "boxing",
  kickboxing: "boxing",
  martialarts: "martialarts",
  bjj: "martialarts",
  jiujitsu: "martialarts",
  brazilianjiujitsu: "martialarts",
  capoeira: "taichi", // Apple has no Capoeira type; it is logged as Tai Chi. See PERSONAL_OVERRIDES.
  tennis: "tennis",
  soccer: "soccer",
  basketball: "basketball",
  golf: "golf",
  downhillskiing: "skiing",
  crosscountryskiing: "skiing",
  skiing: "skiing",
  snowboarding: "snowboarding",
  skatingsports: "skating",
  skating: "skating",
  surfingsports: "surfing",
  surfing: "surfing",
  climbing: "climbing",
  jumprope: "jumprope",
  cooldown: "cooldown",
  flexibility: "flexibility",
  preparationandrecovery: "flexibility",
  taichi: "taichi",
  paddlesports: "paddlesports",
  underwaterdiving: "underwaterdiving",
  barre: "barre",
  badminton: "badminton",
  tabletennis: "tabletennis",
  volleyball: "volleyball",
  handball: "handball",
  hockey: "hockey",
  rugby: "rugby",
  equestriansports: "equestrian",
  equestrian: "equestrian",
  bowling: "bowling",
  archery: "archery",
  wrestling: "wrestling",
  waterfitness: "waterfitness",
  watersports: "watersports",
  sailing: "sailing",
  wheelchairwalkpace: "wheelchair",
  wheelchairrunpace: "wheelchair",
  crosstraining: "crosstraining",
  mixedcardio: "mixedcardio",
  mixedmetaboliccardiotraining: "mixedcardio",
  other: "other",
};

/** Human-readable labels, for anything that renders a workout back to a person. */
const DISPLAY_NAMES: Record<string, string> = {
  running: "Running",
  walking: "Walking",
  hiking: "Hiking",
  cycling: "Cycling",
  swimming: "Swimming",
  rowing: "Rowing",
  elliptical: "Elliptical",
  stairclimbing: "Stair Climbing",
  strength: "Strength Training",
  functionalstrength: "Functional Strength",
  hiit: "HIIT",
  coretraining: "Core Training",
  yoga: "Yoga",
  pilates: "Pilates",
  dance: "Dance",
  boxing: "Boxing",
  martialarts: "Martial Arts",
  tennis: "Tennis",
  soccer: "Soccer",
  basketball: "Basketball",
  golf: "Golf",
  skiing: "Skiing",
  snowboarding: "Snowboarding",
  skating: "Skating",
  surfing: "Surfing",
  climbing: "Climbing",
  jumprope: "Jump Rope",
  cooldown: "Cooldown",
  flexibility: "Flexibility",
  taichi: "Tai Chi",
  paddlesports: "Paddle Sports",
  underwaterdiving: "Underwater Diving",
  barre: "Barre",
  badminton: "Badminton",
  tabletennis: "Table Tennis",
  volleyball: "Volleyball",
  handball: "Handball",
  hockey: "Hockey",
  rugby: "Rugby",
  equestrian: "Equestrian",
  bowling: "Bowling",
  archery: "Archery",
  wrestling: "Wrestling",
  waterfitness: "Water Fitness",
  watersports: "Water Sports",
  sailing: "Sailing",
  wheelchair: "Wheelchair",
  crosstraining: "Cross Training",
  mixedcardio: "Mixed Cardio",
  other: "Other",
};

/**
 * Personal corrections, applied on the way *out* only.
 *
 * Apple Watch has no Capoeira or Brazilian Jiu-Jitsu workout type, so these sessions get
 * logged as the nearest thing Apple offers — Tai Chi and Martial Arts respectively. The
 * slug stays as Apple recorded it because workout ids are derived from it; renaming the
 * slug would orphan every row already stored. Only the label and the MET value change.
 *
 * Labels resolve at read time, so existing workouts pick these up immediately. MET values
 * apply at write time, so previously-imported sessions keep their old effort until
 * re-imported — and only those with no heart rate, since the rest use TRIMP.
 *
 * This mapping is specific to one person. Clear it if the data is ever someone else's.
 */
const PERSONAL_OVERRIDES: Record<string, { label: string; met: number; emoji?: string }> = {
  // Tai Chi is a far gentler activity than what is actually being done here.
  taichi: { label: "Capoeira", met: 10.0, emoji: "🤸" },
  // Calibrated, not looked up. 57 BJJ classes with a chest-strap recording scored a median
  // 0.69 TRIMP per minute (sessions with an average under 95 bpm — strap off — excluded); the compendium's 10.3 for "martial arts, vigorous" would put a
  // session with no heart rate at nearly double that. The MET here is the value that makes
  // the no-heart-rate estimate land on the measured median (met × 0.12 ≈ TRIMP/min). A
  // class is mostly drilling with short bursts of rolling; the average heart rate is ~120.
  martialarts: { label: "BJJ", met: 5.8, emoji: "🥋" },
};

/**
 * One glyph per activity, for places where a label is scanned rather than read — a
 * calendar month view, mostly. Keep these recognisable at a glance and distinct from each
 * other; two activities sharing a glyph defeats the point.
 */
const EMOJI: Record<string, string> = {
  running: "🏃",
  walking: "🚶",
  hiking: "🥾",
  cycling: "🚴",
  swimming: "🏊",
  rowing: "🚣",
  elliptical: "🏃",
  stairclimbing: "🪜",
  strength: "🏋️",
  functionalstrength: "🏋️",
  hiit: "🔥",
  coretraining: "🧘",
  yoga: "🧘",
  pilates: "🧘",
  dance: "💃",
  boxing: "🥊",
  martialarts: "🥋",
  tennis: "🎾",
  soccer: "⚽",
  basketball: "🏀",
  golf: "⛳",
  skiing: "⛷️",
  snowboarding: "🏂",
  skating: "⛸️",
  surfing: "🏄",
  climbing: "🧗",
  jumprope: "🪢",
  cooldown: "🧊",
  flexibility: "🤸",
  taichi: "🤸",
  paddlesports: "🛶",
  underwaterdiving: "🤿",
  barre: "🩰",
  badminton: "🏸",
  tabletennis: "🏓",
  volleyball: "🏐",
  handball: "🤾",
  hockey: "🏒",
  rugby: "🏉",
  equestrian: "🏇",
  bowling: "🎳",
  archery: "🏹",
  wrestling: "🤼",
  waterfitness: "🏊",
  watersports: "🚤",
  sailing: "⛵",
  wheelchair: "🧑‍🦽",
  crosstraining: "🤾",
  mixedcardio: "🔥",
  other: "💪",
};

/**
 * A CSS3 colour name per activity, for the RFC 7986 `COLOR` property.
 *
 * Emitted for the clients that honour it, but do not rely on it: Apple Calendar and Google
 * Calendar both ignore per-event colour on a subscribed feed and colour by calendar
 * instead. Subscribe to several `activityType`-filtered feeds if you want real colours.
 */
const COLORS: Record<string, string> = {
  running: "dodgerblue",
  walking: "mediumseagreen",
  hiking: "darkolivegreen",
  cycling: "darkorange",
  swimming: "darkturquoise",
  rowing: "steelblue",
  strength: "indianred",
  functionalstrength: "indianred",
  hiit: "orangered",
  yoga: "mediumpurple",
  pilates: "mediumpurple",
  coretraining: "mediumpurple",
  dance: "hotpink",
  boxing: "crimson",
  martialarts: "crimson",
  taichi: "crimson",
  climbing: "sienna",
  skiing: "lightskyblue",
  paddlesports: "teal",
  underwaterdiving: "navy",
  other: "slategray",
};

/**
 * Personal relabels, applied at parse time so the *stored* slug is right and every import
 * agrees. Unlike {@link PERSONAL_OVERRIDES}, these change identity: a relabelled workout
 * gets a different derived id, which is why it has to happen before the row is written.
 *
 * Evidence for each rule came from the data itself: 47 Strava sessions typed "Other", all
 * 98–117 minutes, all Monday and Friday evenings, filling exactly the gap in the BJJ history
 * between Polar Flow and Health Auto Export; and three "Wrestling" entries in the same
 * weekly slots. Neither is anything but jiu-jitsu for this person.
 */
export interface RelabelContext {
  sourceName?: string | undefined;
  durationSeconds: number;
}

export function relabelActivity(slug: ActivityType, context: RelabelContext): ActivityType {
  if (slug === "wrestling") return "martialarts";
  if (slug === "other" && /strava/i.test(context.sourceName ?? "") && context.durationSeconds >= 60 * 60) {
    return "martialarts";
  }
  return slug;
}

function canonicalise(raw: string): string {
  return raw
    .replace(/^HKWorkoutActivityType/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Normalises any Apple-flavoured workout label to a slug. Unrecognised labels keep their
 * canonicalised form rather than collapsing to `other`, so a new Apple activity type still
 * groups with itself in reports instead of smearing across every unknown workout.
 */
export function normaliseActivityType(raw: string | undefined | null): ActivityType {
  if (!raw) return UNKNOWN_ACTIVITY;
  const key = canonicalise(raw);
  if (!key) return UNKNOWN_ACTIVITY;
  return ALIASES[key] ?? key;
}

/** MET value for the activity, falling back to the generic "other" rate. */
export function metValue(activity: ActivityType): number {
  return PERSONAL_OVERRIDES[activity]?.met ?? MET_BY_ACTIVITY[activity] ?? MET_BY_ACTIVITY["other"]!;
}

export function displayName(activity: ActivityType): string {
  return PERSONAL_OVERRIDES[activity]?.label ?? DISPLAY_NAMES[activity] ?? activity;
}

/** A glyph for the activity; falls back to a generic one so every activity has something. */
export function activityEmoji(activity: ActivityType): string {
  return PERSONAL_OVERRIDES[activity]?.emoji ?? EMOJI[activity] ?? EMOJI["other"]!;
}

/** CSS3 colour name for the RFC 7986 `COLOR` property. See {@link COLORS} on support. */
export function activityColor(activity: ActivityType): string {
  return COLORS[activity] ?? COLORS["other"]!;
}
