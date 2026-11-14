/**
 * EVA model parameters.
 *
 * These are DEMO values chosen to be physically plausible — they are not NASA spacesuit specifications.
 * The app shows them in the "Model assumptions" panel so nobody mistakes them for flight data.
 */
export interface EvaParams {
  massKg: number; // astronaut + suit + tools
  gravityFactor: number; // walking cost on Mars relative to Earth (partial scaling with 0.38 g)
  suitFactor: number; // extra metabolic cost of moving in a pressurised suit
  restingW: number; // metabolic rate while standing / working lightly
  workingW: number; // metabolic rate during science at a stop
  kJPerLitreO2: number; // energy released per litre of O2 consumed
  o2SupplyL: number; // usable oxygen in the suit
  reserveFraction: number; // fraction of O2 that must remain untouched
  maxEvaH: number; // hard limit on EVA duration
  suitSpeedFactor: number; // suited walking speed relative to an unsuited hiker
  shelterFactor: number; // dose rate inside the pressurised rover relative to outside
  buddyMaxSeparationM: number;
}

export const DEFAULT_PARAMS: EvaParams = {
  massKg: 180,
  gravityFactor: 0.6,
  suitFactor: 1.8,
  restingW: 100,
  workingW: 220,
  kJPerLitreO2: 20.1,
  o2SupplyL: 700,
  reserveFraction: 0.25,
  maxEvaH: 6,
  suitSpeedFactor: 0.6,
  shelterFactor: 0.5,
  buddyMaxSeparationM: 20,
};

export const PARAM_NOTES: { key: keyof EvaParams; label: string; unit: string; basis: string }[] = [
  { key: "massKg", label: "Astronaut + suit + tools", unit: "kg", basis: "Assumption" },
  { key: "gravityFactor", label: "Walking cost vs Earth", unit: "×", basis: "Partial scaling with 0.38 g — cost does not fall linearly with gravity" },
  { key: "suitFactor", label: "Pressurised-suit penalty", unit: "×", basis: "Assumption: suited locomotion costs more than unsuited" },
  { key: "restingW", label: "Resting metabolic rate", unit: "W", basis: "Typical human value" },
  { key: "workingW", label: "Metabolic rate at a science stop", unit: "W", basis: "Assumption, light manual work" },
  { key: "kJPerLitreO2", label: "Energy per litre of O₂", unit: "kJ/L", basis: "Standard physiology" },
  { key: "o2SupplyL", label: "Suit oxygen supply", unit: "L", basis: "Assumption (~1 kg O₂)" },
  { key: "reserveFraction", label: "Oxygen reserve", unit: "fraction", basis: "Safety margin" },
  { key: "maxEvaH", label: "Maximum EVA duration", unit: "h", basis: "Assumption" },
  { key: "suitSpeedFactor", label: "Suited walking speed", unit: "× hiker", basis: "Applied to Tobler's hiking function" },
  { key: "shelterFactor", label: "Dose rate inside the rover", unit: "× outside", basis: "Assumption — depends on vehicle shielding" },
  { key: "buddyMaxSeparationM", label: "Max buddy separation", unit: "m", basis: "Operational rule (assumption)" },
];
