// Camera math for stage plans and frustum wedges.
//
// This is TECHVIS, not previs — the industry distinction is real and worth
// keeping: previs blocks out what a shot looks like, techvis computes the
// physical numbers (lens, distance, height, coverage) that make it achievable.
// A floor plan with angle-of-view wedges is squarely the second thing.
//
// DETERMINISM WARNING, and the reason resolved values get persisted rather than
// recomputed: ECMA-262 specifies +, -, *, / and Math.sqrt as correctly-rounded
// IEEE-754, so those reproduce bit-for-bit across engines. Math.atan, sin, cos,
// exp and pow are explicitly implementation-approximated and DO differ between
// browsers and between versions of the same browser. Every function here that
// touches trig is therefore a pure derivation from stored inputs, and anything
// that lands in a saved sheet stores the computed number — never the recipe.

/** Sensor dimensions in millimetres. Measured active area, not marketing
 *  format names. */
export interface Sensor {
  id: string;
  label: string;
  /** Active width in mm — the dimension horizontal angle of view is taken on. */
  w: number;
  /** Active height in mm. */
  h: number;
}

export const SENSORS: Record<string, Sensor> = {
  full_frame:    { id: "full_frame",    label: "Full frame / VistaVision", w: 36.0,  h: 24.0 },
  super35_4perf: { id: "super35_4perf", label: "Super 35, 4-perf",         w: 24.89, h: 18.66 },
  alexa35_og:    { id: "alexa35_og",    label: "ARRI Alexa 35, Open Gate", w: 27.99, h: 19.22 },
  aps_c:         { id: "aps_c",         label: "APS-C",                    w: 22.2,  h: 14.8 },
  micro43:       { id: "micro43",       label: "Micro Four Thirds",        w: 17.3,  h: 13.0 },
};

export const DEFAULT_SENSOR = "super35_4perf";

export function sensorById(id: string | undefined): Sensor {
  return SENSORS[id || ""] || SENSORS[DEFAULT_SENSOR];
}

export function sensorDiagonalMm(s: Sensor): number {
  return Math.sqrt(s.w * s.w + s.h * s.h);
}

const DEG = 180 / Math.PI;

/**
 * Angle of view in degrees for a rectilinear lens.
 *
 *   α = 2 · arctan( d / 2f )                       focused at infinity
 *   α = 2 · arctan( d / (2F · (1 + m/P)) )          at finite focus
 *
 * `dimensionMm` is the sensor dimension along the axis being measured — width
 * for horizontal, height for vertical, diagonal for diagonal. `magnification`
 * is subject magnification m (0 at infinity); `pupilFactor` is the pupil
 * magnification P, which is 1 for most lenses and only departs from it on
 * retrofocus and telephoto designs.
 */
export function angleOfViewDeg(
  dimensionMm: number,
  focalMm: number,
  magnification = 0,
  pupilFactor = 1,
): number {
  if (!(focalMm > 0) || !(dimensionMm > 0)) return 0;
  const p = pupilFactor > 0 ? pupilFactor : 1;
  const effective = focalMm * (1 + magnification / p);
  return 2 * Math.atan(dimensionMm / (2 * effective)) * DEG;
}

export interface LensCoverage {
  horizontalDeg: number;
  verticalDeg: number;
  diagonalDeg: number;
}

/**
 * Effective horizontal dimension for an anamorphic lens.
 *
 * An anamorphic lens optically COMPRESSES the image horizontally, so a 2×
 * lens fits twice as wide a scene onto the same sensor width. Equivalently its
 * horizontal focal length is f / squeeze. Either way the horizontal field gets
 * WIDER with squeeze, so the sensor width is multiplied — dividing it produces
 * a lens narrower than its spherical equivalent, which is backwards.
 */
function effectiveWidth(sensor: Sensor, squeeze = 1): number {
  return sensor.w * (squeeze > 0 ? squeeze : 1);
}

/** Full coverage for a lens on a sensor. `squeeze` is the anamorphic factor
 *  and affects the horizontal field only — the vertical is untouched. */
export function lensCoverage(sensor: Sensor, focalMm: number, squeeze = 1, magnification = 0): LensCoverage {
  const w = effectiveWidth(sensor, squeeze);
  return {
    horizontalDeg: angleOfViewDeg(w, focalMm, magnification),
    verticalDeg: angleOfViewDeg(sensor.h, focalMm, magnification),
    diagonalDeg: angleOfViewDeg(Math.sqrt(w * w + sensor.h * sensor.h), focalMm, magnification),
  };
}

/** Frame width covered at a given subject distance, in the same unit as the
 *  distance. The number a gaffer actually wants off a floor plan. */
export function coverageWidthAt(sensor: Sensor, focalMm: number, distance: number, squeeze = 1): number {
  const half = (angleOfViewDeg(effectiveWidth(sensor, squeeze), focalMm) / 2) / DEG;
  return 2 * distance * Math.tan(half);
}

// ── plan-view frustum ───────────────────────────────────────────────────────

export interface PlanPoint { x: number; y: number }

export interface CameraSetup {
  id: string;
  label: string;
  /** Position on the plan, in plan units (metres by convention). */
  at: PlanPoint;
  /** Direction the lens points, degrees clockwise from plan north (+Y up). */
  headingDeg: number;
  focalMm: number;
  sensorId?: string;
  squeeze?: number;
  /** How far to draw the wedge. Purely a drawing length — a real frustum is
   *  unbounded, and picking a far plane is a diagram decision, not optics. */
  throwDistance?: number;
}

/**
 * The wedge polygon for a camera, as plan-space points: apex at the camera,
 * then the two edge rays terminated at the throw distance, plus a shallow arc
 * between them so a wide lens doesn't read as a triangle with a chord.
 *
 * Returns plain numbers. Callers persist THESE, not the heading and focal
 * length, so a saved plan redraws identically on any engine.
 */
export function frustumWedge(setup: CameraSetup, arcSegments = 8): PlanPoint[] {
  const sensor = sensorById(setup.sensorId);
  const hfov = angleOfViewDeg(effectiveWidth(sensor, setup.squeeze), setup.focalMm);
  const throwD = setup.throwDistance && setup.throwDistance > 0 ? setup.throwDistance : 6;
  const half = hfov / 2;
  const segs = Math.max(2, Math.min(64, Math.floor(arcSegments)));

  const pts: PlanPoint[] = [{ x: setup.at.x, y: setup.at.y }];
  for (let i = 0; i <= segs; i++) {
    // Heading is clockwise from +Y, so the plan-space direction for an angle a
    // (degrees clockwise from north) is (sin a, cos a).
    const a = (setup.headingDeg - half + (hfov * i) / segs) / DEG;
    pts.push({
      x: setup.at.x + Math.sin(a) * throwD,
      y: setup.at.y + Math.cos(a) * throwD,
    });
  }
  return pts;
}

/** Is a point inside the camera's horizontal coverage? Used to mark which
 *  blocking positions a setup actually sees. */
export function coversPoint(setup: CameraSetup, p: PlanPoint): boolean {
  const sensor = sensorById(setup.sensorId);
  const hfov = angleOfViewDeg(effectiveWidth(sensor, setup.squeeze), setup.focalMm);
  const dx = p.x - setup.at.x;
  const dy = p.y - setup.at.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return true;
  if (setup.throwDistance && dist > setup.throwDistance) return false;
  // Bearing of the point, clockwise from +Y, to match headingDeg.
  const bearing = Math.atan2(dx, dy) * DEG;
  let delta = bearing - setup.headingDeg;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return Math.abs(delta) <= hfov / 2;
}

/** Shot size from the coverage width and the subject's height, using the
 *  conventional cut points. Advisory — a label for the plan, not a rule. */
export function shotSizeLabel(coverageWidth: number, subjectHeight: number): string {
  if (!(subjectHeight > 0) || !(coverageWidth > 0)) return "unknown";
  const ratio = coverageWidth / subjectHeight;
  if (ratio <= 0.25) return "extreme close-up";
  if (ratio <= 0.5) return "close-up";
  if (ratio <= 0.9) return "medium close-up";
  if (ratio <= 1.4) return "medium";
  if (ratio <= 2.2) return "medium wide";
  if (ratio <= 4) return "wide";
  return "extreme wide";
}
