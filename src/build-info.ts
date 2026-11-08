/**
 * Build identity of the running gateway.
 *
 * Values are injected at build time (Dockerfile ARG → ENV, docker compose
 * build args) and read from the environment once at startup. The runtime
 * never reads .git and never executes git: a build without injection (local
 * dev, tsx watch) reports 'unknown' for the injected fields — by design, so
 * the admin console can tell a dev process from a real deployment.
 */

import { GATEWAY_PROTOCOL_V4 } from '@zclaudia/gateway-protocol';
import type { GatewayBuildInfo } from '@zclaudia/gateway-protocol/admin';

const UNKNOWN = 'unknown';

/** Read build info from the injection env vars; unset or blank fields become 'unknown'. */
export function readBuildInfoFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayBuildInfo {
  return {
    version: env.GATEWAY_BUILD_VERSION?.trim() || UNKNOWN,
    commit: env.GATEWAY_BUILD_COMMIT?.trim() || UNKNOWN,
    buildTime: env.GATEWAY_BUILD_TIME?.trim() || UNKNOWN,
    // Not injected: the protocol version is a code constant of this build.
    protocolVersion: GATEWAY_PROTOCOL_V4,
  };
}
