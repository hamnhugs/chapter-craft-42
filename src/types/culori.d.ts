// Minimal declaration for culori (v4 ships no bundled .d.ts). Only the
// surface videoQc.ts actually uses; extend if more of the API is adopted.
declare module "culori" {
  /** Returns a CIEDE2000 color-difference function. Accepts any CSS color
   *  string ("#0af", "rgb(1, 2, 3)") or culori color object. */
  export function differenceCiede2000(
    kL?: number, kC?: number, kH?: number,
  ): (colorA: string | object, colorB: string | object) => number;

  // The reference implementations oklch.test.ts checks lib/oklch.ts against.
  // Loosely typed on purpose: culori's colour objects vary by mode.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type CuloriColor = any;
  export function converter(mode: string): (color: string | object) => CuloriColor;
  export function clampChroma(color: string | object, mode?: string): CuloriColor;
  export function wcagContrast(a: string | object, b: string | object): number;
  export function wcagLuminance(color: string | object): number;
}
