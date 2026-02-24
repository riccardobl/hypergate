import type { IngressPolicy } from "./IngressPolicy.js";

export type Route = {
    key: Buffer;
    routeExpiration: number;
    ingressPolicy: IngressPolicy;
};

export type Service = {
    gatePort: number;
    serviceHost: string;
    servicePort: number;
    protocol: string;
    tags?: string;
    ingressPolicy?: IngressPolicy;
};

export type RoutingEntry = Service & {
    routes: Route[];
    i?: number;
};

export type RoutingTable = RoutingEntry[];
