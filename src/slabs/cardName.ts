/**
 * The graders whose names appear inside a card title. Deliberately a closed list rather than
 * a general pattern: a loose match would cut real card names that happen to contain a word
 * followed by a number.
 */
const GRADERS = "PSA|CGC|BGS|SGC|BECKETT";

/** e.g. "PSA 10", "CGC 8.5", "Beckett 9". Global so the LAST grade in a title wins. */
const GRADE_IN_NAME = new RegExp(`\\b(?:${GRADERS})\\s*\\d{1,2}(?:\\.\\d)?`, "gi");

/**
 * A card's title, trimmed at its grade.
 *
 * Collector Crypt truncates names to a fixed width, which leaves a fragment of the set name
 * dangling past the grade: "2023 #007 Gyarados PSA 10 Clb-Tr", "2010 #NA Pikachu-Holo PSA 10
 * Wor". The grade is where the title naturally ends, and the fragment is not information —
 * it is the middle of a word.
 *
 * Only cuts when a grade is actually present, so titles shaped differently are untouched:
 * "1999 Pokemon Fossil 1st Edition" and "2016 #012 Full Art/Manaphy 1st E" come back as they
 * went in. Both the demo and the real path display through here, so they cannot disagree.
 */
export function displayCardName(name: string | null | undefined): string {
  if (!name) return "";
  const matches = [...name.matchAll(GRADE_IN_NAME)];
  const last = matches[matches.length - 1];
  if (!last || last.index === undefined) return name;
  return name.slice(0, last.index + last[0].length).trimEnd();
}
