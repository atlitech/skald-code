import type { ExpoConfig } from "expo/config";

import { BRAND_ASSET_PATHS } from "../../scripts/lib/brand-assets.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

type AppVariant = "development" | "personal" | "preview" | "production";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);
// Expo's TypeScript setup otherwise installs `typescript` on every start; we typecheck with tsrs.
process.env.EXPO_NO_TYPESCRIPT_SETUP = "1";

const APP_VARIANT = resolveAppVariant(repoEnv.APP_VARIANT);
const isPersonalBuild = APP_VARIANT === "personal";
const isIosPersonalTeamBuild = repoEnv.T3CODE_IOS_PERSONAL_TEAM === "1";
const runtimeVersionPolicy =
  isPersonalBuild && !isIosPersonalTeamBuild
    ? "fingerprint"
    : resolveRuntimeVersionPolicy(process.env.MOBILE_VERSION_POLICY);
const easProjectId = isPersonalBuild
  ? "4dfd2e15-bc73-461a-a26f-ba1c7d559172"
  : "d763fcb8-d37c-41ea-a773-b54a0ab4a454";
const unsignedAndroidBenchmark = repoEnv.T3CODE_ANDROID_CI_UNSIGNED === "1";

if (
  repoEnv.T3CODE_ANDROID_CI_UNSIGNED !== undefined &&
  (!unsignedAndroidBenchmark || !isPersonalBuild || repoEnv.CI !== "true")
) {
  throw new Error("T3CODE_ANDROID_CI_UNSIGNED must be 1 with APP_VARIANT=personal and CI=true.");
}

function resolveRuntimeVersionPolicy(value: string | undefined) {
  switch (value) {
    case "appVersion":
    case "fingerprint":
    case "nativeVersion":
    case "sdkVersion":
      return value;
    case undefined:
      return APP_VARIANT === "development" ? "appVersion" : "fingerprint";
    default:
      throw new Error(`Unsupported MOBILE_VERSION_POLICY: ${value}`);
  }
}

const personalChannel = repoEnv.T3CODE_MOBILE_CHANNEL ?? "personal-production";
if (isPersonalBuild && !["personal-production", "personal-pilot"].includes(personalChannel)) {
  throw new Error("T3CODE_MOBILE_CHANNEL must be personal-production or personal-pilot.");
}
// EAS injects managed profiles after prebuild; explicit profiles remain available for local diagnostics.
const iosProvisioningProfiles = parseProvisioningProfiles(repoEnv.T3CODE_IOS_PROVISIONING_PROFILES);

function parseProvisioningProfiles(value: string | undefined) {
  if (!value?.trim()) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((name) => typeof name === "string")
  ) {
    throw new Error("T3CODE_IOS_PROVISIONING_PROFILES must map bundle IDs to profile names.");
  }
  return parsed as Readonly<Record<string, string>>;
}

const personalTeamBundleIdentifier = repoEnv.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID?.trim();
const IOS_BUNDLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

// Native Observe can dispatch before JS configures it; personal builds and builds without
// a relay use `.invalid` (RFC 6761) so they cannot send reports to Expo's default ingest.
const observeEndpointUrl =
  !isPersonalBuild && repoEnv.T3CODE_RELAY_URL?.trim()
    ? new URL("/v1/mobile/observe", repoEnv.T3CODE_RELAY_URL.trim()).toString()
    : "https://observe.invalid";

const fromRepoRoot = (relativePath: string) => `../../${relativePath}`;
const androidAdaptiveForeground = "./assets/android-icon-foreground.png";

if (
  isIosPersonalTeamBuild &&
  (!personalTeamBundleIdentifier ||
    !IOS_BUNDLE_IDENTIFIER_PATTERN.test(personalTeamBundleIdentifier))
) {
  throw new Error(
    "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID must be a reverse-DNS identifier such as com.example.t3code when T3CODE_IOS_PERSONAL_TEAM=1.",
  );
}

const PREVIEW_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIosIconPng),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#111533",
  androidAdaptiveBackgroundImage: "./assets/android-icon-background-nightly.png",
  androidSplashIcon: "./assets/android-splash-icon-nightly.png",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#7565C7",
} as const;

const RELEASE_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIosIconPng),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#000000",
  androidAdaptiveBackgroundImage: undefined,
  androidSplashIcon: "./assets/android-splash-icon-prod.png",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#FFFFFF",
} as const;

const SKALD_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.skaldIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.skaldIconPng),
  splashIcon: fromRepoRoot("assets/skald/splash-light.png"),
  splashIconDark: fromRepoRoot("assets/skald/splash-dark.png"),
  androidAdaptiveForeground: fromRepoRoot("assets/skald/android-foreground.png"),
  androidAdaptiveBackgroundColor: "#06222B",
  androidAdaptiveBackgroundImage: undefined,
  androidSplashIcon: fromRepoRoot("assets/skald/android-splash-light.png"),
  androidSplashIconDark: fromRepoRoot("assets/skald/android-splash.png"),
  androidMonochromeIcon: fromRepoRoot("assets/skald/android-monochrome.png"),
  androidNotificationIcon: fromRepoRoot("assets/skald/android-notification.png"),
  androidNotificationColor: "#B094E2",
} as const;

const VARIANT_CONFIG = {
  development: {
    appName: "Skald Code Dev",
    scheme: "t3code-dev",
    iosBundleIdentifier: "com.t3tools.t3code.dev",
    androidPackage: "com.t3tools.t3code.dev",
    relyingParty: "clerk.t3.codes",
    assets: SKALD_ASSETS,
  },
  personal: {
    appName: "Skald Code",
    scheme: "t3code-personal",
    iosBundleIdentifier: "tech.atli.skaldcode",
    androidPackage: "tech.atli.skaldcode",
    relyingParty: "clerk.t3.codes",
    assets: SKALD_ASSETS,
  },
  preview: {
    appName: "T3 Code Preview",
    scheme: "t3code-preview",
    iosBundleIdentifier: "com.t3tools.t3code.preview",
    androidPackage: "com.t3tools.t3code.preview",
    relyingParty: "clerk.t3.codes",
    assets: PREVIEW_ASSETS,
  },
  production: {
    appName: "T3 Code",
    scheme: "t3code",
    iosBundleIdentifier: "com.t3tools.t3code",
    androidPackage: "com.t3tools.t3code",
    relyingParty: "clerk.t3.codes",
    assets: RELEASE_ASSETS,
  },
} as const;

function resolveAppVariant(value: string | undefined): AppVariant {
  switch (value) {
    case "development":
    case "personal":
    case "preview":
    case "production":
      return value;
    case undefined:
      return "production";
    default:
      throw new Error("APP_VARIANT must be development, preview, or production.");
  }
}

const variant = VARIANT_CONFIG[APP_VARIANT];
// Copied thread links open the app. app.t3.codes/.well-known lists every variant's identifiers.
const HOSTED_APP_HOST = "app.t3.codes";
const iosBundleIdentifier = isIosPersonalTeamBuild
  ? personalTeamBundleIdentifier!
  : variant.iosBundleIdentifier;

const dmSansFonts = {
  regular: "@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf",
  medium: "@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf",
  bold: "@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf",
} as const;

const widgetsPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-widgets",
  {
    bundleIdentifier: `${iosBundleIdentifier}.widgets`,
    groupIdentifier: `group.${iosBundleIdentifier}`,
    enablePushNotifications: true,
    // Frequent updates need the iOS entitlement to avoid early throttling.
    frequentUpdates: true,
    enableAndroid: true,
    widgets: [
      {
        name: "SubscriptionUsage",
        displayName: "Subscription usage",
        description: "Subscription quotas from your connected Skald Code environments.",
        ios: {
          configuration: {
            title: "Subscription usage",
            description:
              "Both shows Session and Weekly when available. The Lock Screen shows the tightest selected limit.",
            parameters: {
              codexPeriod: {
                title: "Codex limits",
                type: "enum",
                default: "auto",
                values: [
                  { name: "Both", value: "auto" },
                  { name: "Session", value: "session" },
                  { name: "Weekly", value: "weekly" },
                ],
              },
              claudePeriod: {
                title: "Claude limits",
                type: "enum",
                default: "auto",
                values: [
                  { name: "Both", value: "auto" },
                  { name: "Session", value: "session" },
                  { name: "Weekly", value: "weekly" },
                ],
              },
            },
          },
          supportedFamilies: [
            "systemSmall",
            "systemMedium",
            "systemLarge",
            "systemExtraLarge",
            "accessoryRectangular",
          ],
        },
        android: {
          minWidth: 250,
          minHeight: 180,
          targetCellWidth: 4,
          targetCellHeight: 3,
          resizeMode: "both",
          // The embedded layout renders before first launch; publishing replaces it with stored props.
          initialLayout: "./src/widgets/SubscriptionUsage.android.tsx",
        },
      },
      {
        name: "AgentActivity",
        displayName: "Agent Activity",
        description: "Shows the current state of active Skald Code agents.",
        android: null,
        ios: { supportedFamilies: ["systemSmall", "systemMedium", "accessoryRectangular"] },
      },
    ],
  },
];

const personalIosSigningPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "./plugins/withPersonalIosSigningTeam.cjs",
  { provisioningProfiles: iosProvisioningProfiles },
];

const personalAndroidSigningPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "./plugins/withPersonalAndroidSigning.cjs",
  { unsigned: unsignedAndroidBenchmark },
];

const sharingPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-sharing",
  {
    ios: {
      // Personal Teams cannot sign App Groups or extension targets; keep local builds usable.
      enabled: !isIosPersonalTeamBuild,
      extensionBundleIdentifier: `${iosBundleIdentifier}.sharing`,
      appGroupId: `group.${iosBundleIdentifier}`,
      activationRule: {
        supportsText: true,
        supportsWebUrlWithMaxCount: 1,
        supportsImageWithMaxCount: 8,
        supportsMovieWithMaxCount: 8,
        supportsFileWithMaxCount: 8,
      },
    },
    android: {
      enabled: true,
      singleShareMimeTypes: ["*/*"],
      multipleShareMimeTypes: ["*/*"],
    },
  },
];

// Match iOS PostScript names on Android so RN and the native composer share fonts before runtime loading.

const config: ExpoConfig = {
  name: isIosPersonalTeamBuild ? "T3 Code Personal" : variant.appName,
  slug: isPersonalBuild && !isIosPersonalTeamBuild ? "skald-code" : "t3-code",
  platforms: ["ios", "android"],
  scheme: isIosPersonalTeamBuild ? `t3code-${iosBundleIdentifier}` : variant.scheme,
  version: repoEnv.T3CODE_MOBILE_VERSION ?? "2.2.0",
  runtimeVersion: {
    // Skip costly fingerprinting on dev launches; preview and production OTAs require matching native projects.
    policy: runtimeVersionPolicy,
  },
  orientation: "portrait",
  icon: variant.assets.appIcon,
  userInterfaceStyle: "automatic",
  updates: isIosPersonalTeamBuild
    ? {
        enabled: false,
      }
    : {
        enabled: repoEnv.T3CODE_MOBILE_UPDATES_ENABLED !== "0",
        url: `https://u.expo.dev/${easProjectId}`,
        ...(isPersonalBuild ? { requestHeaders: { "expo-channel-name": personalChannel } } : {}),
        checkAutomatically: "ON_LOAD",
        fallbackToCacheTimeout: 0,
      },
  ios: {
    icon: variant.assets.iosIcon,
    supportsTablet: true,
    requireFullScreen: process.env.T3_SHOWCASE_CAPTURE_BUILD === "1",
    bundleIdentifier: iosBundleIdentifier,
    // Pin a paid team (the fork's for `personal`, T3 Tools' otherwise) so non-interactive
    // `expo run:ios` never falls back to a free Personal Team, which cannot sign app groups,
    // Sign in with Apple, or push notification entitlements.
    appleTeamId: isIosPersonalTeamBuild ? undefined : isPersonalBuild ? "H6L3F33KRM" : "ARK85ZXQ4Z",
    associatedDomains: isIosPersonalTeamBuild
      ? []
      : [
          `applinks:${variant.relyingParty}`,
          `webcredentials:${variant.relyingParty}`,
          `applinks:${HOSTED_APP_HOST}`,
        ],
    entitlements: {
      "keychain-access-groups": [`$(AppIdentifierPrefix)${iosBundleIdentifier}`],
    },
    infoPlist: {
      UISupportedInterfaceOrientations: [
        "UIInterfaceOrientationPortrait",
        "UIInterfaceOrientationLandscapeLeft",
        "UIInterfaceOrientationLandscapeRight",
      ],
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
      NSLocalNetworkUsageDescription:
        "Allow Skald Code to connect to T3 Code servers on your local network or tailnet.",
      NSPhotoLibraryAddUsageDescription: "Allow Skald Code to save images to your photo library.",
      // System picture in picture needs background audio to start and survive outside the app.
      UIBackgroundModes: ["audio"],
      ITSAppUsesNonExemptEncryption: false,
      // Capture builds disable multitasking because iPadOS otherwise ignores orientation requests.
      ...(process.env.T3_SHOWCASE_CAPTURE_BUILD === "1"
        ? {
            "UISupportedInterfaceOrientations~ipad": [
              "UIInterfaceOrientationPortrait",
              "UIInterfaceOrientationPortraitUpsideDown",
              "UIInterfaceOrientationLandscapeLeft",
              "UIInterfaceOrientationLandscapeRight",
            ],
          }
        : {}),
    },
  },
  android: {
    icon: variant.assets.appIcon,
    package: variant.androidPackage,
    ...(repoEnv.T3CODE_ANDROID_GOOGLE_SERVICES_FILE
      ? { googleServicesFile: repoEnv.T3CODE_ANDROID_GOOGLE_SERVICES_FILE }
      : {}),
    adaptiveIcon: {
      backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
      ...(variant.assets.androidAdaptiveBackgroundImage
        ? { backgroundImage: variant.assets.androidAdaptiveBackgroundImage }
        : {}),
      foregroundImage: variant.assets.androidAdaptiveForeground,
      monochromeImage: variant.assets.androidMonochromeIcon,
    },
    // JS back dispatch needs RN's Android 16 shim and withAndroidPredictiveBackCompat on Android 13-15.
    predictiveBackGestureEnabled: true,
    // expo-sensors declares this for its pedometer, which the app does not use.
    blockedPermissions: ["android.permission.ACTIVITY_RECOGNITION"],
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [{ scheme: "https", host: HOSTED_APP_HOST, pathPrefix: "/threads/" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  web: {
    favicon: variant.assets.appIcon,
  },
  plugins: [
    // Entitlement mods run in reverse registration order; strip restricted
    // capabilities after the plugins that add them.
    ...(isIosPersonalTeamBuild ? ["./plugins/withoutIosPersonalTeamCapabilities.cjs"] : []),
    // Registered first so it runs after the extension targets exist.
    ...(isPersonalBuild ? [personalIosSigningPlugin] : []),
    "expo-asset",
    "react-native-pdf-jsi",
    [
      "expo-font",
      {
        ios: {
          fonts: [dmSansFonts.regular, dmSansFonts.medium, dmSansFonts.bold],
        },
        android: {
          fonts: [
            {
              fontFamily: "DMSans-Regular",
              fontDefinitions: [{ path: dmSansFonts.regular, weight: 400 }],
            },
            {
              fontFamily: "DMSans-Medium",
              fontDefinitions: [{ path: dmSansFonts.medium, weight: 500 }],
            },
            {
              fontFamily: "DMSans-Bold",
              fontDefinitions: [{ path: dmSansFonts.bold, weight: 700 }],
            },
          ],
        },
      },
    ],
    "expo-secure-store",
    "expo-sqlite",
    ...(isIosPersonalTeamBuild
      ? [sharingPlugin]
      : ["./plugins/withShareExtensionDisplayName.cjs", sharingPlugin]),
    [
      "expo-notifications",
      {
        icon: variant.assets.androidNotificationIcon,
        color: variant.assets.androidNotificationColor,
        mode: APP_VARIANT === "development" ? "development" : "production",
      },
    ],
    // Upstream's Clerk only accepts Apple sign-in from T3 Tools' bundle IDs.
    [
      "@clerk/expo",
      { theme: "./clerk-theme.json", appleSignIn: !isIosPersonalTeamBuild && !isPersonalBuild },
    ],
    "expo-web-browser",
    [
      "expo-quick-actions",
      {
        androidIcons: {
          shortcut_icon: {
            foregroundImage: variant.assets.androidAdaptiveForeground,
            backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
            ...(variant.assets.androidAdaptiveBackgroundImage
              ? { backgroundImage: variant.assets.androidAdaptiveBackgroundImage }
              : {}),
          },
        },
      },
    ],
    [
      "expo-audio",
      {
        microphonePermission: "Allow Skald Code to use your microphone for voice input.",
        recordAudioAndroid: true,
        enableBackgroundPlayback: false,
        enableBackgroundRecording: false,
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission:
          "Allow Skald Code to access your camera so you can scan pairing QR codes.",
        microphonePermission: false,
        barcodeScannerEnabled: true,
        recordAudioAndroid: false,
      },
    ],
    [
      "expo-image-picker",
      {
        photosPermission: false,
        // `false` makes this plugin add RECORD_AUDIO to blockedPermissions, breaking Android dictation.
        microphonePermission: "Allow Skald Code to use your microphone for voice input.",
      },
    ],
    [
      "expo-splash-screen",
      {
        image: variant.assets.splashIcon,
        resizeMode: "contain",
        backgroundColor: "#f8f9f5",
        imageWidth: 220,
        dark: {
          image:
            "splashIconDark" in variant.assets
              ? variant.assets.splashIconDark
              : variant.assets.splashIcon,
          backgroundColor: "#101c28",
        },
        android: {
          // Android 12+ masks the central two thirds of the 288dp canvas; adaptive layers avoid clipped corners.
          image: variant.assets.androidSplashIcon,
          imageWidth: 288,
          dark: {
            image:
              "androidSplashIconDark" in variant.assets
                ? variant.assets.androidSplashIconDark
                : variant.assets.androidSplashIcon,
          },
        },
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          minSdkVersion: 24,
          // SDK 58 lacks Kotlin 2.3's runtime-inert annotation. R8 needs explicit InputMerger constructors for widgets.
          extraProguardRules: [
            "-dontwarn kotlin.MustUseReturnValues",
            "-keep class * extends androidx.work.InputMerger { <init>(); }",
          ].join("\n"),
        },
        ios: {
          deploymentTarget: "18.0",
          // AppCheckCore 11.3+ includes Swift and needs module maps for these Objective-C dependencies.
          extraPods: [
            { name: "GoogleUtilities", modular_headers: true },
            { name: "RecaptchaInterop", modular_headers: true },
          ],
        },
      },
    ],
    "./plugins/withIosCocoaPodsUuidCache.cjs",
    // Compile out the unused pedometer to avoid an iOS motion purpose string.
    ["expo-sensors", { motionPermission: false }],
    // Mods run in reverse order; expo-widgets must create and wipe the target before assets are added.
    ...(!isIosPersonalTeamBuild ? ["./plugins/withWidgetLogoAsset.cjs", widgetsPlugin] : []),
    "./plugins/withAndroidNetworkSecurityConfig.cjs",
    "./plugins/withAndroidGradleHeap.cjs",
    "./plugins/withAndroidInputBackground.cjs",
    "./plugins/withAndroidModernPopupMenu.cjs",
    "./plugins/withAndroidModernAlertDialog.cjs",
    "./plugins/withAndroidPredictiveBackCompat.cjs",
    "./plugins/withAndroidTabletOrientation.cjs",
    ...(isPersonalBuild
      ? [
          "./plugins/withPersonalAndroidProfileable.cjs",
          personalAndroidSigningPlugin,
          "./plugins/withoutPersonalAndroidObserve.cjs",
        ]
      : []),
  ],
  extra: {
    appVariant: APP_VARIANT,
    iosPersonalTeamBuild: isIosPersonalTeamBuild,
    relay: {
      url: repoEnv.T3CODE_RELAY_URL ?? null,
    },
    clerk: {
      publishableKey: repoEnv.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,
      jwtTemplate: repoEnv.EXPO_PUBLIC_CLERK_JWT_TEMPLATE ?? null,
    },
    // Clerk reads these exact names at prebuild. Omit unset values: manifest null becomes truthy {}.
    EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME,
    observability: {
      tracesUrl: repoEnv.EXPO_PUBLIC_OTLP_TRACES_URL ?? "https://api.axiom.co/v1/traces",
      tracesDataset: repoEnv.EXPO_PUBLIC_OTLP_TRACES_DATASET ?? null,
      tracesToken: repoEnv.EXPO_PUBLIC_OTLP_TRACES_TOKEN ?? null,
    },
    ...(!isIosPersonalTeamBuild
      ? {
          eas: {
            projectId: easProjectId,
            observe: { endpointUrl: observeEndpointUrl },
          },
        }
      : {}),
  },
  owner: isIosPersonalTeamBuild ? undefined : isPersonalBuild ? "atlitech" : "pingdotgg",
  experiments: {
    // Metro only runs babel-plugin-react-compiler when this is set; see src/reactCompilerCoverage.test.ts.
    reactCompiler: true,
  },
};

export default config;
