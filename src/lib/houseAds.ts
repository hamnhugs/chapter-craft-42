// House-ad creatives shown to free-tier users. Zero external ad scripts:
// ad networks (AdSense etc.) don't approve content behind a login, so until a
// network is wired in, the inventory is first-party upgrade promos. Each
// creative doubles as a contextual upgrade prompt — the highest-converting
// "ad" a freemium app can run.

export interface HouseAd {
  id: string;
  icon: string; // material symbol name
  headline: string;
  body: string;
  cta: string;
  gradient: [string, string];
}

export const HOUSE_ADS: HouseAd[] = [
  {
    id: "neurons",
    icon: "neurology",
    headline: "One neuron is lonely",
    body: "Pro unlocks unlimited neurons — grow a whole brain from your library.",
    cta: "Upgrade — $4.99/mo",
    gradient: ["#7C3AED", "#2563EB"],
  },
  {
    id: "deep-research",
    icon: "science",
    headline: "Go deeper",
    body: "Deep Research reads further, reasons harder, and cites its sources.",
    cta: "Unlock Deep Research",
    gradient: ["#0EA5E9", "#10B981"],
  },
  {
    id: "lifetime",
    icon: "all_inclusive",
    headline: "Pay once, read forever",
    body: "$197 Lifetime: every Pro feature and every future update. Limited-time offer.",
    cta: "Get Lifetime",
    gradient: ["#F59E0B", "#EF4444"],
  },
  {
    id: "no-ads",
    icon: "block",
    headline: "Remove these ads",
    body: "Pro and Lifetime are completely ad-free. Your reading, uninterrupted.",
    cta: "Go ad-free",
    gradient: ["#EC4899", "#8B5CF6"],
  },
];
