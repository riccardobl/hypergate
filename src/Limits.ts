export type LimitsConfig = {
    MAX_BUFFER_PER_CHANNEL: number;
    MAX_BUFFER_PER_PEER: number;
    ROUTE_FINDING_TIMEOUT_MS: number;
    STATS_INTERVAL_MS: number;
    ROUTE_EXPIRATION_MS: number;
    CHANNEL_TIMEOUT_POLL_MS: number;
    OPEN_REQUEST_TIMEOUT_MS: number;
    FIND_ROUTE_RETRY_MIN_MS: number;
    FIND_ROUTE_RETRY_MAX_MS: number;
    PEER_STALE_MS: number;
    PEER_REFRESH_MS: number;
    PEER_REFRESH_WAIT_MS: number;
    TCP_SOCKET_TIMEOUT_MS: number;
    UDP_SOCKET_TIMEOUT_MS: number;
};

const defaults: LimitsConfig = {
    MAX_BUFFER_PER_CHANNEL: 150 * 1024 * 1024, // 150 MB
    MAX_BUFFER_PER_PEER: 300 * 1024 * 1024, // 300 MB
    ROUTE_FINDING_TIMEOUT_MS: 1 * 60 * 1000, // 1 minutes
    STATS_INTERVAL_MS: 10 * 60_000, // 10 minutes
    ROUTE_EXPIRATION_MS: 2 * 1000 * 60, // 2 minute
    CHANNEL_TIMEOUT_POLL_MS: 1000 * 60, // 1 minute
    OPEN_REQUEST_TIMEOUT_MS: 5000, // 5s
    FIND_ROUTE_RETRY_MIN_MS: 100, // 100ms
    FIND_ROUTE_RETRY_MAX_MS: 600, // 600ms
    PEER_STALE_MS: 1000 * 60 * 15, // 15 minutes
    PEER_REFRESH_MS: 5000, // 5s
    PEER_REFRESH_WAIT_MS: 100, // 100ms
    TCP_SOCKET_TIMEOUT_MS: 60 * 60 * 1000, // 1 hour
    UDP_SOCKET_TIMEOUT_MS: 60 * 60 * 1000, // 1 hour
};

export const Limits: LimitsConfig = { ...defaults };

function parseNumber(v: any, fallback: number) {
    if (v == null || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

export function configureFromArgv(argv: any) {
    // Prefer explicit argv values, then environment variables.
    Limits.MAX_BUFFER_PER_CHANNEL = parseNumber(argv.maxBufferPerChannel ?? process.env.HYPERGATE_MAX_BUFFER_PER_CHANNEL, defaults.MAX_BUFFER_PER_CHANNEL);
    Limits.MAX_BUFFER_PER_PEER = parseNumber(argv.maxBufferPerPeer ?? process.env.HYPERGATE_MAX_BUFFER_PER_PEER, defaults.MAX_BUFFER_PER_PEER);
    Limits.ROUTE_FINDING_TIMEOUT_MS = parseNumber(argv.routeFindingTimeoutMs ?? process.env.HYPERGATE_ROUTE_FINDING_TIMEOUT_MS, defaults.ROUTE_FINDING_TIMEOUT_MS);
    Limits.STATS_INTERVAL_MS = parseNumber(argv.statsIntervalMs ?? process.env.HYPERGATE_STATS_INTERVAL_MS, defaults.STATS_INTERVAL_MS);
    Limits.ROUTE_EXPIRATION_MS = parseNumber(argv.routeExpirationMs ?? process.env.HYPERGATE_ROUTE_EXPIRATION_MS, defaults.ROUTE_EXPIRATION_MS);
    Limits.CHANNEL_TIMEOUT_POLL_MS = parseNumber(argv.channelTimeoutPollMs ?? process.env.HYPERGATE_CHANNEL_TIMEOUT_POLL_MS, defaults.CHANNEL_TIMEOUT_POLL_MS);
    Limits.OPEN_REQUEST_TIMEOUT_MS = parseNumber(argv.openRequestTimeoutMs ?? process.env.HYPERGATE_OPEN_REQUEST_TIMEOUT_MS, defaults.OPEN_REQUEST_TIMEOUT_MS);
    Limits.FIND_ROUTE_RETRY_MIN_MS = parseNumber(argv.findRouteRetryMinMs ?? process.env.HYPERGATE_FIND_ROUTE_RETRY_MIN_MS, defaults.FIND_ROUTE_RETRY_MIN_MS);
    Limits.FIND_ROUTE_RETRY_MAX_MS = parseNumber(argv.findRouteRetryMaxMs ?? process.env.HYPERGATE_FIND_ROUTE_RETRY_MAX_MS, defaults.FIND_ROUTE_RETRY_MAX_MS);
    Limits.PEER_STALE_MS = parseNumber(argv.peerStaleMs ?? process.env.HYPERGATE_PEER_STALE_MS, defaults.PEER_STALE_MS);
    Limits.PEER_REFRESH_MS = parseNumber(argv.peerRefreshMs ?? process.env.HYPERGATE_PEER_REFRESH_MS, defaults.PEER_REFRESH_MS);
    Limits.PEER_REFRESH_WAIT_MS = parseNumber(argv.peerRefreshWaitMs ?? process.env.HYPERGATE_PEER_REFRESH_WAIT_MS, defaults.PEER_REFRESH_WAIT_MS);
    Limits.TCP_SOCKET_TIMEOUT_MS = parseNumber(argv.tcpSocketTimeoutMs ?? process.env.HYPERGATE_TCP_SOCKET_TIMEOUT_MS, defaults.TCP_SOCKET_TIMEOUT_MS);
    Limits.UDP_SOCKET_TIMEOUT_MS = parseNumber(argv.udpSocketTimeoutMs ?? process.env.HYPERGATE_UDP_SOCKET_TIMEOUT_MS, defaults.UDP_SOCKET_TIMEOUT_MS);
}

export default { Limits, configureFromArgv };
