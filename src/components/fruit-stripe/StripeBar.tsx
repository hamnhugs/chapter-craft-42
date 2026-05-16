import React from "react";

interface Props {
  thickness?: number;
  className?: string;
}

/** Signature rainbow accent for the Fruit Stripe theme. */
const StripeBar: React.FC<Props> = ({ thickness = 4, className = "" }) => (
  <div
    aria-hidden
    className={className}
    style={{
      height: thickness,
      width: "100%",
      background:
        "linear-gradient(90deg, #E63946 0%, #E63946 20%, #F4A261 20%, #F4A261 40%, #FFD23F 40%, #FFD23F 60%, #2A9D8F 60%, #2A9D8F 80%, #E76F8C 80%, #E76F8C 100%)",
    }}
  />
);

export default StripeBar;
