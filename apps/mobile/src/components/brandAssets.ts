import Constants from "expo-constants";

const appVariant = Constants.expoConfig?.extra?.appVariant;

export const T3_CODE_BRAND_MARK_SOURCE =
  appVariant === "development" || appVariant === "personal"
    ? require("../../../../assets/skald/icon-1024.png")
    : appVariant === "preview"
      ? require("../../../../assets/nightly/nightly-ios-1024.png")
      : require("../../../../assets/prod/black-ios-1024.png");
