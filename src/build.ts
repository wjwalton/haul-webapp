/** This build's identity (vite.config.ts `define`), shown in the header and written into every update log. */
export const BUILD = __BUILD__;

/** e.g. "0.1.0-beta (a1b2c3d, 2026-11-19)" */
export const BUILD_LABEL = `${BUILD.version}${BUILD.channel ? `-${BUILD.channel}` : ''} (${BUILD.commit}, ${BUILD.date})`;
