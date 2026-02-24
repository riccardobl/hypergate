import { describe, it, expect, beforeEach } from 'vitest';
import { parseIngressPolicy, lookupIngressPolicy } from '../src/IngressPolicy.js';
import { Protocol } from '../src/Protocol.js';

describe('IngressPolicy', () => {
  describe('parseIngressPolicy', () => {
    it('should return empty policy for empty inputs', () => {
      const result = parseIngressPolicy();
      expect(result).toEqual({});
    });

    it('should return empty policy for empty object', () => {
      const result = parseIngressPolicy({});
      expect(result).toEqual({});
    });

    it('should parse single input object', () => {
      const input = {
        defaults: { allow: true },
        ips: {
          '192.168.1.1': { allow: false },
        },
      };
      const result = parseIngressPolicy(input);
      expect(result).toEqual(input);
    });

    it('should merge multiple input objects', () => {
      const input1 = { defaults: { allow: true } };
      const input2 = { ips: { '192.168.1.1': { allow: false } } };
      const result = parseIngressPolicy(input1, input2);
      expect(result.defaults).toEqual({ allow: true });
      expect(result.ips).toEqual({ '192.168.1.1': { allow: false } });
    });

    it('should deep merge nested objects', () => {
      const input1 = {
        defaults: { allow: true, bandwidthLimit: { mbps: 10 } },
      };
      const input2 = {
        defaults: { bandwidthLimit: { burstMbps: 20 } },
      };
      const result = parseIngressPolicy(input1, input2);
      expect(result.defaults?.allow).toBe(true);
      expect(result.defaults?.bandwidthLimit?.mbps).toBe(10);
      expect(result.defaults?.bandwidthLimit?.burstMbps).toBe(20);
    });

    it('should block __proto__ and prototype keys', () => {
      const input = {
        defaults: { allow: true },
        '__proto__': { malicious: true },
        'prototype': { malicious: true },
      };
      const result = parseIngressPolicy(input);
      // Blocked keys should not be processed (the values won't be merged in)
      expect(result.defaults).toEqual({ allow: true });
      // ensure dangerous keys did not inject malicious properties
      expect((result as any)['__proto__']?.malicious).toBeUndefined();
      expect((result as any)['prototype']?.malicious).toBeUndefined();
      // ensure object's prototype wasn't replaced
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    });

    it('should prune expired policies', () => {
      const input = {
        defaults: { allow: true, expireAt: Date.now() - 1000 },
        ips: {
          '192.168.1.1': { allow: false, expireAt: Date.now() + 10000 },
        },
      };
      const result = parseIngressPolicy(input);
      expect(result.defaults).toBeUndefined();
      expect(result.ips?.['192.168.1.1']).toBeDefined();
    });
  });

  describe('lookupIngressPolicy', () => {
    let policy: any;

    beforeEach(() => {
      policy = {
        defaults: { allow: true, bandwidthLimit: { mbps: 100 } },
        ips: {
          '192.168.1.100': { allow: false },
          '10.0.0.0/8': { allow: true },
          '*': { allow: false },
        },
      };
    });

    it('should throw error if IP is not provided', () => {
      expect(() => lookupIngressPolicy(policy, '')).toThrow('IP is required');
    });

    it('should return defaults when no specific rule matches', () => {
      // Create policy without wildcard to test defaults
      const noWildcard = {
        defaults: { allow: true, bandwidthLimit: { mbps: 100 } },
        ips: {
          '192.168.1.100': { allow: false },
        },
      };
      const result = lookupIngressPolicy(noWildcard, '172.16.0.1');
      expect(result).toEqual(noWildcard.defaults);
    });

    it('should match exact IP', () => {
      const result = lookupIngressPolicy(policy, '192.168.1.100');
      expect(result?.allow).toBe(false);
    });

    it('should match CIDR subnet', () => {
      const result = lookupIngressPolicy(policy, '10.0.0.1');
      expect(result?.allow).toBe(true);
    });

    it('should match wildcard', () => {
      const result = lookupIngressPolicy(policy, '8.8.8.8');
      expect(result?.allow).toBe(false);
    });

    it('should return null when no defaults and no match', () => {
      const noDefaults = { ips: { '192.168.1.0/24': { allow: true } } };
      const result = lookupIngressPolicy(noDefaults as any, '10.0.0.1');
      expect(result).toBeNull();
    });

    describe('port filtering', () => {
      beforeEach(() => {
        policy = {
          ips: {
            '*': {
              allow: true,
              onlyPorts: [80, 443],
            },
            '192.168.1.100': {
              allow: false,
              excludePorts: [8080, 9000],
            },
          },
        };
      });

      it('should filter by onlyPorts - matching port', () => {
        const result = lookupIngressPolicy(policy, '10.0.0.1', 80);
        expect(result?.allow).toBe(true);
      });

      it('should filter by onlyPorts - non-matching port', () => {
        const result = lookupIngressPolicy(policy, '10.0.0.1', 8080);
        expect(result).toBeNull();
      });

      it('should filter by excludePorts - non-matching port', () => {
        // Create specific policy for this test without wildcard
        const policyNoWildcard = {
          ips: {
            '192.168.1.100': {
              allow: false,
              excludePorts: [8080, 9000] as [number, number],
            },
          },
        };
        const result = lookupIngressPolicy(policyNoWildcard, '192.168.1.100', 80);
        expect(result?.allow).toBe(false);
      });

      it('should filter by excludePorts - matching excluded port', () => {
        const result = lookupIngressPolicy(policy, '192.168.1.100', 8080);
        expect(result).toBeNull();
      });
    });

    describe('protocol filtering', () => {
      beforeEach(() => {
        policy = {
          ips: {
            '*': {
              allow: true,
              onlyProtocols: ['tcp'],
            },
          },
        };
      });

      it('should filter by onlyProtocols - matching protocol', () => {
        const result = lookupIngressPolicy(policy, '10.0.0.1', 80, Protocol.tcp);
        expect(result?.allow).toBe(true);
      });

      it('should filter by onlyProtocols - non-matching protocol', () => {
        const result = lookupIngressPolicy(policy, '10.0.0.1', 80, Protocol.udp);
        expect(result).toBeNull();
      });

      it('should filter by excludeProtocols', () => {
        const policyWithExclude = {
          ips: {
            '*': { allow: true, excludeProtocols: ['udp'] },
          },
        };
        const result = lookupIngressPolicy(policyWithExclude, '10.0.0.1', 80, Protocol.udp);
        expect(result).toBeNull();
      });
    });

    describe('IPv6 support', () => {
      it('should match IPv6 addresses', () => {
        const policy = {
          ips: {
            '::1': { allow: false },
            '2001:db8::1': { allow: true },
          },
        };
        expect(lookupIngressPolicy(policy, '::1')?.allow).toBe(false);
        expect(lookupIngressPolicy(policy, '2001:db8::1')?.allow).toBe(true);
      });

      it('should match IPv6 subnets', () => {
        const policy = {
          ips: {
            '2001:db8::/32': { allow: true },
          },
        };
        expect(lookupIngressPolicy(policy, '2001:db8::1')?.allow).toBe(true);
      });

      it('should normalize IPv4-mapped IPv6 addresses', () => {
        const policy = {
          ips: {
            '192.168.1.1': { allow: false },
          },
        };
        // ::ffff:192.168.1.1 should match 192.168.1.1
        expect(lookupIngressPolicy(policy, '::ffff:192.168.1.1')?.allow).toBe(false);
      });

      it('should strip IPv6 zone ID', () => {
        const policy = {
          ips: {
            'fe80::1': { allow: false },
          },
        };
        // fe80::1%eth0 should match fe80::1
        expect(lookupIngressPolicy(policy, 'fe80::1%eth0')?.allow).toBe(false);
      });
    });

    describe('label-based lookup', () => {
      it('should match by label before IP', () => {
        const policy = {
          ips: {
            '*': { allow: true },
            'specific-client': { allow: false, labels: ['trusted'] },
          },
        };
        const result = lookupIngressPolicy(policy, '10.0.0.1', undefined, undefined, 'trusted');
        expect(result?.allow).toBe(false);
      });
    });
  });
});
