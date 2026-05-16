import React from "react";

interface Props {
  /** Bar height in pixels. PRD spec: 4px. */
  thickness?: number;
  /** Skew angle for the diagonal segments. PRD spec: ~12°. */
  skewDeg?: number;
  className?: string;
}

// PRD palette — Cherry → Orange → Yellow → Lime → Melon
const SEGMENTS = ["#E63946", "#F4844D", "#F4C95D", "#6BBF59", "#EE7B9E"];

/**
 * Fruit Stripe signature bar: 4px tall, five diagonal rainbow segments
 * skewed ~12°. Used in headers, dividers, and progress bars.
 */
const StripeBar: React.FC<Props> = ({ thickness = 4, skewDeg = 12, className = "" }) => (
  <div
    aria-hidden
    className={`relative w-full overflow-hidden ${className}`}
    style={{ height: thickness, background: "#111" }}
  >
    <div
      className="absolute inset-0 flex"
      style={{ transform: `skewX(-${skewDeg}deg)`, transformOrigin: "center", width: "110%", marginLeft: "-5%" }}
    >
      {SEGMENTS.map((color, i) => (
        <div key={i} style={{ background: color, flex: 1, height: "100%" }} />
      ))}
    </div>
  </div>
);

export default StripeBar;
