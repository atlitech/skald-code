import { Image } from "expo-image";
import { MOBILE_PRODUCT_NAME } from "../lib/mobileBranding";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

export function SkaldLogo(props: { readonly height: number }) {
  const { themeAppearance } = useAppearancePreferences();
  return (
    <Image
      source={
        themeAppearance === "dark"
          ? require("../../../../assets/skald/skald-code-logo-horizontal-on-dark.svg")
          : require("../../../../assets/skald/skald-code-logo-horizontal.svg")
      }
      accessibilityLabel={MOBILE_PRODUCT_NAME}
      accessibilityIgnoresInvertColors
      contentFit="contain"
      style={{ height: props.height, aspectRatio: 1340.45 / 242.27 }}
    />
  );
}
