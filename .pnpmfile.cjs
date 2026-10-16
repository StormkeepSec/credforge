// pnpm hooks (the Dockerfile copies this file before `pnpm install`).
//
// better-auth lists vitest (for its test utilities) and drizzle-kit (for its CLI) as optional peer
// dependencies. The workspace has both as development tools, so pnpm linked them into
// better-auth's dependencies, and `pnpm deploy --prod` then copied about 150 MB of vitest, vite,
// rolldown, esbuild and drizzle-kit into the production image. The server never loads them.
const UNWANTED_PEERS = { 'better-auth': ['vitest', 'drizzle-kit'] };

module.exports = {
  hooks: {
    readPackage(pkg) {
      for (const name of UNWANTED_PEERS[pkg.name] ?? []) {
        if (pkg.peerDependencies) delete pkg.peerDependencies[name];
        if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[name];
      }
      return pkg;
    },
  },
};
