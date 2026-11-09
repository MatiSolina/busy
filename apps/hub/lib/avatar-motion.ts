const MOTIONS = [
  "bounce",
  "wiggle",
  "nod",
  "peek",
  "sway",
  "pop",
  "shuffle",
  "float",
] as const;

/** A bot keeps its gestures and rhythm across views, reloads, and color changes. */
export function avatarMotionFor(identity: string) {
  let seed = 17;
  for (const character of identity) {
    seed = (seed * 31 + character.charCodeAt(0)) % 2_147_483_647;
  }

  return {
    direction: Math.floor(seed / 8) % 2 === 0 ? 1 : -1,
    gazeX: 5 + (Math.floor(seed / 181) % 4),
    gazeY: 3 + (Math.floor(seed / 31) % 3),
    hoverDuration: 420 + (seed % 181),
    lightDuration: (14 + (seed % 11)) / 10,
    name: MOTIONS[seed % MOTIONS.length] ?? "bounce",
    scale: (85 + (Math.floor(seed / 17) % 31)) / 100,
    tilt: 4 + (Math.floor(seed / 71) % 4),
    workDelay: -(seed % 2001) / 1000,
    workDuration: (3000 + (seed % 2201)) / 1000,
  };
}
