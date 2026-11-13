// Each theme's living app-bar backdrop. Bookworm Studio's is the Vegas sky;
// the others each have their own signature piece here.
import type { ThemeId } from "@/lib/themes";
import VegasSky from "@/components/VegasSky";
import FruitStripeArt from "./FruitStripeArt";
import DextersLabArt from "./DextersLabArt";
import AuroraArt from "./AuroraArt";
import DesolateLabArt from "./DesolateLabArt";

export default function HeaderArt({ themeId }: { themeId: ThemeId }) {
  switch (themeId) {
    case "bookworm-studio": return <VegasSky />;
    case "fruit-stripe": return <FruitStripeArt />;
    case "dexters-lab": return <DextersLabArt />;
    case "aurora": return <AuroraArt />;
    case "desolate-lab": return <DesolateLabArt />;
    default: return null;
  }
}
