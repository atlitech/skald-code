const { androidCiExpoArguments } = require("./android-ci-metro-cache.cjs");

// React Native resets Metro on every release bundle; CI restores content-keyed transforms instead.
process.argv = process.argv.slice(0, 2).concat(androidCiExpoArguments(process.argv.slice(2)));
require(require.resolve("@expo/cli", { paths: [require.resolve("expo/package.json")] }));
