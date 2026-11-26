/**
 * Random employee names (FO-010A).
 *
 * A name is drawn once when an employee is created or when the owner asks for
 * a new one, then stored. Reading an employee never draws a name. Equal names
 * are allowed: the UUID is the identity, so two "Alex" are two people.
 */

export const EMPLOYEE_FIRST_NAMES = [
  "Alex", "Avery", "Blake", "Cameron", "Casey", "Dana", "Devon", "Drew", "Eden", "Elliot",
  "Emery", "Finley", "Frankie", "Gray", "Harper", "Hayden", "Indigo", "Jamie", "Jordan", "Jules",
  "Kai", "Kendall", "Lane", "Logan", "Marlow", "Morgan", "Nico", "Noor", "Oakley", "Parker",
  "Peyton", "Quinn", "Reese", "Riley", "River", "Robin", "Rowan", "Sage", "Sasha", "Sawyer",
  "Shiloh", "Skyler", "Sloane", "Spencer", "Tatum", "Taylor", "Teagan", "Toby", "Wren", "Zion",
  "Amara", "Anika", "Arjun", "Beatriz", "Callum", "Chidi", "Dmitri", "Elena", "Farid", "Greta",
  "Hana", "Ilya", "Imani", "Jonas", "Kenji", "Leila", "Mateo", "Mei", "Nadia", "Omar",
  "Priya", "Rafael", "Saoirse", "Tomas", "Uma", "Viktor", "Yara", "Zara", "Anya", "Bruno",
] as const;

/**
 * Draw one name. Prefers a name no active employee holds, so a small team
 * reads clearly; falls back to any name when every one is taken. `random`
 * returns a number in [0, 1) and is injectable for tests.
 */
export function generateEmployeeName(taken: Iterable<string> = [], random: () => number = Math.random): string {
  const used = new Set<string>();
  for (const name of taken) used.add(name.trim().toLowerCase());
  const free = EMPLOYEE_FIRST_NAMES.filter((name) => !used.has(name.toLowerCase()));
  const pool: readonly string[] = free.length > 0 ? free : EMPLOYEE_FIRST_NAMES;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  return pool[index]!;
}
