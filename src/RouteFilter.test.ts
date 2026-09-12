import { describe, expect, it } from "vitest";
import { Protocol } from "./Protocol.js";
import { shouldExposeRoute } from "./RouteFilter.js";
import type { RoutingEntry } from "./Router.js";

const dockerRoute: RoutingEntry = {
    gatePort: 8080,
    serviceHost: "web.internal",
    servicePort: 80,
    protocol: Protocol.tcp,
    tags: "docker published",
    routes: [],
};

describe("gateway route exposure filter", () => {
    it("applies service allowlists without requiring a gateway JSON filter", () => {
        expect(shouldExposeRoute(dockerRoute, { exposeOnlyServices: ["web.internal"] })).toBe(true);
        expect(shouldExposeRoute(dockerRoute, { exposeOnlyServices: ["admin.internal"] })).toBe(false);
    });

    it("applies docker and published constraints without gateway JSON filters", () => {
        expect(shouldExposeRoute({ ...dockerRoute, tags: undefined }, { exposeOnlyDocker: true })).toBe(false);
        expect(shouldExposeRoute({ ...dockerRoute, tags: "docker" }, { exposeOnlyPublished: true })).toBe(false);
        expect(shouldExposeRoute(dockerRoute, { exposeOnlyDocker: true, exposeOnlyPublished: true })).toBe(true);
    });

    it("preserves bare gateway behavior when no constraints are configured", () => {
        expect(shouldExposeRoute(dockerRoute, {})).toBe(true);
    });

    it("treats multiple JSON filters as alternatives under the global constraints", () => {
        expect(
            shouldExposeRoute(dockerRoute, {
                exposeOnlyServices: ["web.internal"],
                filters: [{ serviceHost: "other.internal" }, { gatePort: 8080, tags: "published" }],
            }),
        ).toBe(true);
        expect(
            shouldExposeRoute(dockerRoute, {
                exposeOnlyServices: ["other.internal"],
                filters: [{ gatePort: 8080 }],
            }),
        ).toBe(false);
    });
});
