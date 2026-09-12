import { describe, expect, it } from "vitest";
import { filterUnexposedDockerPorts } from "./DockerManager.js";

const ports = [
    { PrivatePort: 80, PublicPort: 8080, Type: "tcp" },
    { PrivatePort: 53, Type: "udp" },
    { PrivatePort: 53, Type: "tcp" },
];

describe("DockerManager port exclusions", () => {
    it("excludes published ports", () => {
        expect(filterUnexposedDockerPorts(ports, "80")).toEqual(ports.slice(1));
    });

    it("applies protocol-specific and whitespace-tolerant exclusions", () => {
        expect(filterUnexposedDockerPorts(ports, " 53/udp ")).toEqual([ports[0], ports[2]]);
    });

    it("matches protocol-specific exclusions case-insensitively", () => {
        expect(filterUnexposedDockerPorts([{ PrivatePort: 80, Type: "TCP" }], "80/tcp")).toEqual([]);
        expect(filterUnexposedDockerPorts([{ PrivatePort: 53, Type: "udp" }], "53/UDP")).toEqual([]);
    });

    it("gives wildcard exclusions final precedence", () => {
        expect(filterUnexposedDockerPorts(ports, "*")).toEqual([]);
    });
});
