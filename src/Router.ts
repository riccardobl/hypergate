import type { IngressPolicy } from "./IngressPolicy.js";
import type { Protocol } from "./Protocol.js";

export type Route = {
    key: Buffer;
    routeExpiration: number;
    ingressPolicy: IngressPolicy;
};

export type Service = {
    gatePort: number;
    serviceHost: string;
    servicePort: number;
    protocol: Protocol;
    tags?: string;
    ingressPolicy?: IngressPolicy;
};

export type RoutingEntry = Service & {
    routes: Route[];
    i?: number;
};

export type RoutingTable = RoutingEntry[];
