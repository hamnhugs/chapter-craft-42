import React from "react";

interface Props {
  /** Total height of the texture in pixels. Default 32. */
  height?: number;
  className?: string;
}

/**
 * Fruit Stripe Zebra Edge: 2px ink-black horizontal stripes, 8px tall with 8px gap.
 * Used in empty states, book placeholders, sidebar footers.
 */
const ZebraEdge: React.FC<Props> = ({ height = 32, className = "" }) => (
  <div
    aria-hidden
    className={className}
    style={{
      height,
      width: "100%",
      backgroundImage:
        "repeating-linear-gradient(0deg, #111 0 2px, transparent 2px 10px)",
    }}
  />
);

export default ZebraEdge;
