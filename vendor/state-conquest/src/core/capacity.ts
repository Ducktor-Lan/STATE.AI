import {
  CAPACITY_BASE,
  CAPACITY_MAX,
  CAPACITY_MIN,
  CAPACITY_SCALE,
  DEFAULT_REFERENCE_AREA,
} from '../config/balance';

/**
 * Logical map area drives capacity. Screen pixels and canvas scale never do.
 */
export function capacityForArea(
  areaUnits: number,
  referenceArea: number = DEFAULT_REFERENCE_AREA
): number {
  const safeArea = isFinite(areaUnits) && areaUnits > 0 ? areaUnits : 0.0001;
  const safeReference =
    isFinite(referenceArea) && referenceArea > 0 ? referenceArea : DEFAULT_REFERENCE_AREA;
  const raw = CAPACITY_BASE + CAPACITY_SCALE * Math.sqrt(safeArea / safeReference);
  return Math.max(CAPACITY_MIN, Math.min(CAPACITY_MAX, Math.round(raw)));
}
