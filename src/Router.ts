export type Route = {
    key: Buffer;
    routeExpiration: number;
};

export type Service = {
    gatePort: number;
    serviceHost: string;
    servicePort: number;
    protocol: string;
    tags?: string;
};

export type RoutingEntry = Service & {
    routes: Route[];
    i?: number;
};

export type RoutingTable = RoutingEntry[];
