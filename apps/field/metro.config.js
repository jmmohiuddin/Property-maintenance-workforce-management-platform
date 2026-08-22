// Monorepo Metro configuration: the app lives in apps/field and imports
// @meridian/core from packages/core, so Metro has to watch the repository root
// and resolve modules from both node_modules trees. Without this, Metro
// resolves @meridian/core to nothing and the bundle fails at import time
// rather than at build time.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
