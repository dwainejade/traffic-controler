/**
 * What colour a shop sign is.
 *
 * OpenStreetMap knows what a business is called and, for the chains, which
 * brand it belongs to — but nothing about how it looks. So the mapping from
 * brand to colour is ours: a table for the chains you would recognise from
 * across the street, and a colour per category for the delis, bakeries and
 * salons that are the actual substance of a shopping street.
 *
 * These are sign boards, not logos: a background and an ink, approximating the
 * brand's own two colours closely enough to be recognisable at a glance from a
 * pavement. No marks, no wordmarks, no typefaces.
 */

export type SignColours = {
  /** The board. */
  board: string
  /** The lettering on it. */
  ink: string
}

/**
 * Chains, keyed by their normalised brand name (see `brandKey`).
 *
 * Matching on the name rather than on `brand:wikidata` is deliberate: the name
 * is what OSM carries everywhere, the wikidata id is patchy, and a mistyped id
 * fails silently while a mistyped name is visible the moment you walk past it.
 * The ids are still honoured — see `QID_TO_KEY` — for the entries that carry a
 * brand id but no brand name.
 */
export const BRANDS: Record<string, SignColours> = {
  // Fast food
  mcdonalds: { board: "#DA291C", ink: "#FFC72C" },
  burgerking: { board: "#D62300", ink: "#F5EBDC" },
  subway: { board: "#008C15", ink: "#FFC600" },
  kfc: { board: "#A6192E", ink: "#FFFFFF" },
  popeyes: { board: "#FF7900", ink: "#FFFFFF" },
  wendys: { board: "#E2203D", ink: "#FFFFFF" },
  tacobell: { board: "#702082", ink: "#FFFFFF" },
  pizzahut: { board: "#EE3124", ink: "#FFFFFF" },
  dominos: { board: "#006491", ink: "#FFFFFF" },
  papajohns: { board: "#C8102E", ink: "#FFFFFF" },
  fiveguys: { board: "#ED174F", ink: "#FFFFFF" },
  shakeshack: { board: "#4F8A10", ink: "#FFFFFF" },
  chipotle: { board: "#451400", ink: "#D9C7A7" },
  pandaexpress: { board: "#D2232A", ink: "#FFFFFF" },
  wingstop: { board: "#1A1A1A", ink: "#00A651" },
  jerseymikessubs: { board: "#1B4F9C", ink: "#FFFFFF" },
  blimpie: { board: "#E01A2B", ink: "#FFFFFF" },
  cava: { board: "#1F4B3F", ink: "#F0E3C8" },
  sweetgreen: { board: "#4A7C3F", ink: "#FFFFFF" },
  panerabread: { board: "#6C8A3A", ink: "#FFFFFF" },
  pretamanger: { board: "#862633", ink: "#FFFFFF" },
  ihop: { board: "#0033A0", ink: "#FFFFFF" },
  dennys: { board: "#FFC72C", ink: "#B01F24" },

  // Coffee, tea, sweets
  starbucks: { board: "#00704A", ink: "#FFFFFF" },
  dunkin: { board: "#FF671F", ink: "#FFFFFF" },
  bluebottlecoffee: { board: "#0F5DB8", ink: "#FFFFFF" },
  blankstreetcoffee: { board: "#8ED8B4", ink: "#12362B" },
  kungfutea: { board: "#B01F24", ink: "#F4E3B2" },
  gongcha: { board: "#7B1E23", ink: "#E8C87A" },
  mixueicecreamtea: { board: "#E2231A", ink: "#FFFFFF" },
  haagendazs: { board: "#7B1E3C", ink: "#E8C87A" },
  insomniacookies: { board: "#4B2E83", ink: "#F7E36B" },
  krispykreme: { board: "#006241", ink: "#FFFFFF" },

  // Pharmacy and convenience
  walgreens: { board: "#E31837", ink: "#FFFFFF" },
  cvspharmacy: { board: "#CC0000", ink: "#FFFFFF" },
  riteaid: { board: "#005DAA", ink: "#FFFFFF" },
  duanereade: { board: "#003DA5", ink: "#FFFFFF" },
  seveneleven: { board: "#008061", ink: "#FFFFFF" },
  boots: { board: "#05054B", ink: "#FFFFFF" },

  // Groceries
  wholefoodsmarket: { board: "#00674B", ink: "#FFFFFF" },
  traderjoes: { board: "#C8102E", ink: "#FFFFFF" },
  keyfood: { board: "#C8102E", ink: "#FFC72C" },
  costco: { board: "#E31837", ink: "#FFFFFF" },
  walmart: { board: "#0071CE", ink: "#FFC220" },
  target: { board: "#CC0000", ink: "#FFFFFF" },
  aldi: { board: "#00447C", ink: "#FF8300" },
  lidl: { board: "#0050AA", ink: "#FFE500" },
  tesco: { board: "#00539F", ink: "#FFFFFF" },
  sainsburys: { board: "#F06C00", ink: "#FFFFFF" },

  // Banks
  chase: { board: "#117ACA", ink: "#FFFFFF" },
  bankofamerica: { board: "#012169", ink: "#E31837" },
  citibank: { board: "#003B70", ink: "#FFFFFF" },
  wellsfargo: { board: "#D71E28", ink: "#FFCD41" },
  tdbank: { board: "#008A00", ink: "#FFFFFF" },
  santander: { board: "#EC0000", ink: "#FFFFFF" },
  hsbc: { board: "#DB0011", ink: "#FFFFFF" },

  // Phones and electronics
  tmobile: { board: "#E20074", ink: "#FFFFFF" },
  metrobytmobile: { board: "#E20074", ink: "#FFFFFF" },
  verizon: { board: "#CD040B", ink: "#FFFFFF" },
  att: { board: "#00A8E0", ink: "#FFFFFF" },
  boostmobile: { board: "#F7941E", ink: "#FFFFFF" },
  bestbuy: { board: "#0046BE", ink: "#FFF200" },
  gamestop: { board: "#ED1C24", ink: "#FFFFFF" },

  // Everything else that recurs
  homedepot: { board: "#F96302", ink: "#FFFFFF" },
  truevalue: { board: "#D42027", ink: "#FFFFFF" },
  petsmart: { board: "#0057B8", ink: "#FFFFFF" },
  footlocker: { board: "#1A1A1A", ink: "#FFFFFF" },
  barnesnoble: { board: "#046A38", ink: "#FFFFFF" },
  sephora: { board: "#1A1A1A", ink: "#FFFFFF" },
  hm: { board: "#E50010", ink: "#FFFFFF" },
  gap: { board: "#00243F", ink: "#FFFFFF" },
  oldnavy: { board: "#002B5C", ink: "#FFFFFF" },
  tjmaxx: { board: "#E11B22", ink: "#FFFFFF" },
  primark: { board: "#00558C", ink: "#FFFFFF" },
  goodwill: { board: "#005DAA", ink: "#FFFFFF" },
  lululemon: { board: "#D31334", ink: "#FFFFFF" },
  adidas: { board: "#1A1A1A", ink: "#FFFFFF" },
  warbyparker: { board: "#1B3A5C", ink: "#FFFFFF" },
  lenscrafters: { board: "#00447C", ink: "#FFFFFF" },
}

/**
 * Wikidata ids for the entries above, as a fallback key.
 *
 * Only ids observed on real data are listed — a guessed id is worse than none,
 * because it either does nothing or paints the wrong shop.
 */
export const QID_TO_KEY: Record<string, string> = {
  Q38076: "mcdonalds",
  Q177054: "burgerking",
  Q244457: "subway",
  Q524757: "kfc",
  Q839466: "dominos",
  Q2759586: "papajohns",
  Q1131810: "fiveguys",
  Q1058722: "shakeshack",
  Q465751: "chipotle",
  Q1358690: "pandaexpress",
  Q8025339: "wingstop",
  Q6184897: "jerseymikessubs",
  Q4926479: "blimpie",
  Q85751038: "cava",
  Q18636413: "sweetgreen",
  Q7130852: "panerabread",
  Q2109109: "pretamanger",
  Q1185675: "ihop",
  Q37158: "starbucks",
  Q847743: "dunkin",
  Q4928917: "bluebottlecoffee",
  Q114792509: "blankstreetcoffee",
  Q66023886: "kungfutea",
  Q5581670: "gongcha",
  Q107406476: "mixueicecreamtea",
  Q1143333: "haagendazs",
  Q16997024: "insomniacookies",
  Q1591889: "walgreens",
  Q2078880: "cvspharmacy",
  Q5310380: "duanereade",
  Q259340: "seveneleven",
  Q688825: "traderjoes",
  Q6398037: "keyfood",
  Q1046951: "target",
  Q151954: "lidl",
  Q524629: "chase",
  Q487907: "bankofamerica",
  Q7669891: "tdbank",
  Q5835668: "santander",
  Q190464: "hsbc",
  Q3511885: "tmobile",
  Q1925685: "metrobytmobile",
  Q919641: "verizon",
  Q298594: "att",
  Q4943790: "boostmobile",
  Q202210: "gamestop",
  Q7847545: "truevalue",
  Q3307147: "petsmart",
  Q63335: "footlocker",
  Q795454: "barnesnoble",
  Q2408041: "sephora",
  Q188326: "hm",
  Q420822: "gap",
  Q2735242: "oldnavy",
  Q10860683: "tjmaxx",
  Q137023: "primark",
  Q5583655: "goodwill",
  Q6702957: "lululemon",
  Q3895: "adidas",
  Q7968882: "warbyparker",
  Q6523209: "lenscrafters",
}

/**
 * What an unbranded shop looks like — which is most of them, and the half of
 * the street that gives a neighbourhood its character. Colours are chosen to
 * separate the categories from each other at a glance rather than to imitate
 * anything: a deli should not read as a bank.
 */
const CATEGORIES: Record<string, SignColours> = {
  // Food and drink
  restaurant: { board: "#7A2E2E", ink: "#F6E6D4" },
  fast_food: { board: "#C25A1E", ink: "#FFF3E0" },
  cafe: { board: "#5A4230", ink: "#F2E4D0" },
  bar: { board: "#2E2A3C", ink: "#E6D9A8" },
  pub: { board: "#3A2A1E", ink: "#E8C77A" },
  ice_cream: { board: "#E8A0B4", ink: "#4A2430" },
  bakery: { board: "#C9A063", ink: "#3A2A16" },
  pastry: { board: "#C9A063", ink: "#3A2A16" },
  confectionery: { board: "#B8607A", ink: "#FFF0F4" },
  butcher: { board: "#8C3A44", ink: "#F6E6D4" },
  deli: { board: "#B8763A", ink: "#FFF3E0" },
  greengrocer: { board: "#5C8A3A", ink: "#FFFFFF" },
  alcohol: { board: "#4A2A3C", ink: "#E6C9A8" },

  // Daily needs
  convenience: { board: "#C4913A", ink: "#3A2A16" },
  supermarket: { board: "#2F6E4A", ink: "#FFFFFF" },
  pharmacy: { board: "#1F7A5A", ink: "#FFFFFF" },
  chemist: { board: "#1F7A5A", ink: "#FFFFFF" },
  variety_store: { board: "#C4552A", ink: "#FFF0DC" },
  department_store: { board: "#7A3A5C", ink: "#FFFFFF" },
  kiosk: { board: "#B8763A", ink: "#FFF3E0" },
  newsagent: { board: "#A8623A", ink: "#FFF3E0" },
  tobacco: { board: "#5C3A2A", ink: "#E8C97A" },
  cannabis: { board: "#3A6E3A", ink: "#F0F6E0" },
  bank: { board: "#1E3A5C", ink: "#E8EDF4" },
  fuel: { board: "#2A4A6E", ink: "#FFFFFF" },
  post_office: { board: "#1E4A7A", ink: "#FFFFFF" },
  laundry: { board: "#3A6E8C", ink: "#FFFFFF" },
  dry_cleaning: { board: "#3A6E8C", ink: "#FFFFFF" },
  hardware: { board: "#4A5A66", ink: "#FFE8B0" },
  doityourself: { board: "#4A5A66", ink: "#FFE8B0" },
  shipping: { board: "#5A5A6E", ink: "#FFFFFF" },
  printing: { board: "#4A4A5C", ink: "#FFFFFF" },
  copyshop: { board: "#4A4A5C", ink: "#FFFFFF" },
  car_repair: { board: "#4A4A50", ink: "#FFD24A" },
  storage_rental: { board: "#5A5A5C", ink: "#FFD24A" },
  funeral_directors: { board: "#2A2A32", ink: "#D8D4CC" },

  // Personal
  hairdresser: { board: "#8C3A6E", ink: "#F6E0EE" },
  beauty: { board: "#A8447A", ink: "#FFF0F6" },
  optician: { board: "#2A5A7A", ink: "#FFFFFF" },
  clothes: { board: "#5A3A6E", ink: "#F0E4F6" },
  shoes: { board: "#4A3A5C", ink: "#F0E4F6" },
  jewelry: { board: "#3A3A4A", ink: "#E8C97A" },
  cosmetics: { board: "#A8447A", ink: "#FFF0F6" },
  massage: { board: "#6E4A7A", ink: "#F6E0EE" },
  nail: { board: "#B84A8C", ink: "#FFF0F6" },
  tattoo: { board: "#2A2A32", ink: "#E8C97A" },
  bag: { board: "#4A3A2A", ink: "#F0E4D8" },
  shoe_repair: { board: "#4A3A2A", ink: "#F0E4D8" },
  pet: { board: "#4A7A8C", ink: "#FFFFFF" },
  pet_grooming: { board: "#4A7A8C", ink: "#FFFFFF" },

  // Leisure
  cinema: { board: "#3A2A4A", ink: "#E8C97A" },
  books: { board: "#3A5A4A", ink: "#F0E8D8" },
  florist: { board: "#5C8A5A", ink: "#FFFFFF" },
  garden_centre: { board: "#5C8A5A", ink: "#FFFFFF" },
  gift: { board: "#8C4A6E", ink: "#FFF0F6" },
  stationery: { board: "#3A5A7A", ink: "#FFFFFF" },
  furniture: { board: "#6E5A3A", ink: "#F6ECD8" },
  houseware: { board: "#6E5A3A", ink: "#F6ECD8" },
  interior_decoration: { board: "#6E5A4A", ink: "#F6ECD8" },
  frame: { board: "#6E5A4A", ink: "#F6ECD8" },
  linen: { board: "#7A6A5A", ink: "#F6ECD8" },
  curtain: { board: "#7A6A5A", ink: "#F6ECD8" },
  electronics: { board: "#2A4A5C", ink: "#FFFFFF" },
  mobile_phone: { board: "#2A4A5C", ink: "#FFFFFF" },
  telecommunication: { board: "#2A4A5C", ink: "#FFFFFF" },
  travel_agency: { board: "#2A6E8C", ink: "#FFFFFF" },
}

/** Anything the table above has never heard of. */
const UNKNOWN: SignColours = { board: "#6E6A66", ink: "#F2F0EC" }

/**
 * A brand name reduced to something matchable: "Papa John's", "papa johns" and
 * "PAPA JOHN'S" are one shop. Digits spelled out, because "7-Eleven" is not a
 * key anybody would guess to write.
 */
export function brandKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/7/g, "seven")
    .replace(/[^a-z]/g, "")
}

/** The sign colours for a shopfront, brand first and category behind it. */
export function signColours(brand: string, category: string): SignColours {
  return BRANDS[brand] ?? CATEGORIES[category] ?? UNKNOWN
}
