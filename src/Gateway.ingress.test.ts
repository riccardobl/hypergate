import { describe, expect, it } from "vitest";
import { resolveRouteIngressRule } from "./Gateway.js";
import { Protocol } from "./Protocol.js";

describe("gateway unlimited ingress overrides", () => {
    it("removes bandwidth limits without overriding a provider deny", () => {
        const override = { ips: { "127.0.0.1": { bandwidthLimit: null } } };
        const denied = resolveRouteIngressRule({ ips: { "127.0.0.1": { allow: false, bandwidthLimit: { mbps: 1 } } } }, override, "127.0.0.1", 443, Protocol.tcp);
        expect(denied?.allow).toBe(false);
        expect(denied?.bandwidthLimit).toEqual({ mbps: 1 });
    });

    it("preserves allowed access while removing its bandwidth limit", () => {
        const effective = resolveRouteIngressRule(
            { defaults: { allow: true, bandwidthLimit: { mbps: 1 } } },
            { ips: { "127.0.0.1": { bandwidthLimit: null, labels: ["gateway-unlimited"] } } },
            "127.0.0.1",
            443,
            Protocol.tcp,
        );
        expect(effective).toMatchObject({ allow: true, bandwidthLimit: null, labels: ["gateway-unlimited"] });
    });
});
