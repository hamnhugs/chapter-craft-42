// Each theme's light on the room — a layer over the whole app rather than a
// skin on its surfaces. Most themes have none; the Scriptorium's is the sun
// through its window by day and the reader's own candle by night.
import { useTheme } from "@/context/ThemeContext";
import ScriptoriumAmbient from "./ScriptoriumAmbient";

export default function ThemeAmbient() {
  const { themeId } = useTheme();
  switch (themeId) {
    case "scriptorium": return <ScriptoriumAmbient />;
    default: return null;
  }
}
