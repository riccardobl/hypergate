import { BlockList, isIP } from "node:net";

export type BandwidthLimit = {
    mbps: number;
    burstMbps?: number;
};
export type IngressPolicyRule = {
    allow?: boolean;
    bandwidthLimit?: BandwidthLimit | null;
    labels?: string[];
    onlyPorts?: [number, number];
    excludePorts?: [number, number];
    onlyProtocols?: string[];
    excludeProtocols?: string[];
    desc?: string;
};


export type IngressPolicy = {
    defaults?: IngressPolicyRule;
    ips?: Record<string, IngressPolicyRule>;
};

export function parseIngressPolicy(...inputs: {}[]): IngressPolicy {
    let merge = {};
    function recursiveMerge(target: any, source: any) {
        for (const [key, value] of Object.entries(source)) {
            if (value && typeof value === "object" && !Array.isArray(value)) {
                if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) {
                    target[key] = {};
                }
                recursiveMerge(target[key], value);
            } else {
                target[key] = value;
            }
        }
    }
    for (const input of inputs) {
        if (input && typeof input === "object") {
            recursiveMerge(merge, input);
        }
    }
    return merge;
}

export function lookupIngressPolicy(policy: IngressPolicy, ip: string, gatePort?: number, protocol?: string, label?: string): IngressPolicyRule | null {
    if (!ip) throw new Error("IP is required for ingress policy lookup");
    if (policy.ips) {
        // search first by label (most important)
        if (label && policy.ips) {
            for (const [ipPattern, rule] of Object.entries(policy.ips)) {
                if (rule.labels?.includes(label)) {
                    return rule;
                }
            }
        }

        // search by ip and port (if specified) combo
        for (const [ipPattern, rule] of Object.entries(policy.ips || {})) {
            if (matchIpPattern(ip, ipPattern)) {
                if (gatePort != null) {
                    if (rule.onlyPorts && (gatePort < rule.onlyPorts[0] || gatePort > rule.onlyPorts[1])) {
                        continue;
                    }
                    if (rule.excludePorts && gatePort >= rule.excludePorts[0] && gatePort <= rule.excludePorts[1]) {
                        continue;
                    }
                }
                if (protocol) {
                    if (rule.onlyProtocols && !rule.onlyProtocols.includes(protocol)) {
                        continue;
                    }
                    if (rule.excludeProtocols && rule.excludeProtocols.includes(protocol)) {
                        continue;
                    }
                }
                return rule;
            }
        }
    }
    // return defaults if no specific rule matched
    return policy.defaults || null;
}


function matchIpPattern(ip: string, pattern: string): boolean {
    const candidate = normalizeIpForMatch(ip.trim());
    const rule = pattern.trim();

    if (rule === "*") return true;

    const ipVersion = isIP(candidate);
    if (!ipVersion) return false;

    const list = new BlockList();

    if (rule.includes("/")) {
        const [base, prefixStr] = rule.split("/");
        const baseNorm = normalizeIpForMatch(base);
        const baseVersion = isIP(baseNorm);
        const prefix = Number(prefixStr);

        if (!baseVersion || baseVersion !== ipVersion || !Number.isInteger(prefix)) return false;

        list.addSubnet(baseNorm, prefix, baseVersion === 4 ? "ipv4" : "ipv6");
        return list.check(candidate, baseVersion === 4 ? "ipv4" : "ipv6");
    }

    const ruleNorm = normalizeIpForMatch(rule);
    const ruleVersion = isIP(ruleNorm);
    if (!ruleVersion || ruleVersion !== ipVersion) return false;

    list.addAddress(ruleNorm, ruleVersion === 4 ? "ipv4" : "ipv6");
    return list.check(candidate, ruleVersion === 4 ? "ipv4" : "ipv6");
}

function normalizeIpForMatch(ip: string): string {
    // strip IPv6 zone id (e.g. fe80::1%eth0)
    const noZone = ip.split("%")[0] || ip;
    // normalize IPv4-mapped IPv6 to IPv4 so existing ipv4 rules still match
    return noZone.startsWith("::ffff:") ? noZone.slice(7) : noZone;
}
