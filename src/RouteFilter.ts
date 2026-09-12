import type { RoutingEntry } from "./Router.js";
import { normalizeProtocol } from "./Protocol.js";

export type GatewayRouteFilter = Partial<Pick<RoutingEntry, "gatePort" | "serviceHost" | "servicePort" | "protocol" | "tags">>;

export type GatewayRouteFilterOptions = {
    filters?: GatewayRouteFilter | GatewayRouteFilter[];
    exposeOnlyServices?: string[];
    exposeOnlyDocker?: boolean;
    exposeOnlyPublished?: boolean;
};

export function shouldExposeRoute(entry: RoutingEntry, options: GatewayRouteFilterOptions): boolean {
    const entryTags = entry.tags?.split(" ").filter(Boolean) ?? [];

    if (options.exposeOnlyServices?.length && !options.exposeOnlyServices.includes(entry.serviceHost)) return false;
    if (options.exposeOnlyDocker && !entryTags.includes("docker")) return false;
    if (options.exposeOnlyPublished && !entryTags.includes("published")) return false;

    const filters = options.filters == null ? [] : Array.isArray(options.filters) ? options.filters : [options.filters];
    if (filters.length === 0) return true;

    return filters.some((filter) => {
        if (filter.gatePort !== undefined && filter.gatePort != entry.gatePort) return false;
        if (filter.serviceHost !== undefined && filter.serviceHost != entry.serviceHost) return false;
        if (filter.servicePort !== undefined && filter.servicePort != entry.servicePort) return false;
        if (filter.protocol !== undefined) {
            const filterProtocol = typeof filter.protocol === "number" ? filter.protocol : normalizeProtocol(filter.protocol);
            if (filterProtocol == null || filterProtocol != entry.protocol) return false;
        }
        if (filter.tags !== undefined) {
            const filterTags = filter.tags.split(" ").filter(Boolean);
            if (!filterTags.every((tag) => entryTags.includes(tag))) return false;
        }
        return true;
    });
}
