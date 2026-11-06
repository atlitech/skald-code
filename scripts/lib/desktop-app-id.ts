// The fork Mac app's identity: electron-builder's appId, which macOS uses as
// the bundle identifier, and the name Finder and the Dock show. The bundle ID
// matches the iOS app's, as upstream's do, and the Developer ID profile is for
// it. The fork release checks the built Mac app against both.
export const DESKTOP_APP_ID = "tech.atli.skaldcode";
export const DESKTOP_PRODUCT_NAME = "Skald Code";
