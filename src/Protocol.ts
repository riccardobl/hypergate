export enum Protocol {
    tcp = 0,
    udp = 1,
}

export function normalizeProtocol(value?: string): Protocol {
    if (!value) return Protocol.tcp;
    const v = value.toLowerCase();
    if (v === "tcp") return Protocol.tcp;
    if (v === "udp") return Protocol.udp;
    return Protocol.tcp;
}

export function protocolToString(value?: Protocol): "tcp" | "udp" | undefined {
    if (value === Protocol.tcp) return "tcp";
    if (value === Protocol.udp) return "udp";
    return undefined;
}
