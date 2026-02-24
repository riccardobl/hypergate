import { describe, it, expect } from 'vitest';
import { Protocol, normalizeProtocol, protocolToString } from '../src/Protocol.js';

describe('Protocol', () => {
  describe('Protocol enum', () => {
    it('should have tcp = 0', () => {
      expect(Protocol.tcp).toBe(0);
    });

    it('should have udp = 1', () => {
      expect(Protocol.udp).toBe(1);
    });
  });

  describe('normalizeProtocol', () => {
    it('should return TCP for undefined', () => {
      expect(normalizeProtocol(undefined)).toBe(Protocol.tcp);
    });

    it('should return TCP for null', () => {
      expect(normalizeProtocol(null as any)).toBe(Protocol.tcp);
    });

    it('should return TCP for empty string', () => {
      expect(normalizeProtocol('')).toBe(Protocol.tcp);
    });

    it('should return TCP for "tcp"', () => {
      expect(normalizeProtocol('tcp')).toBe(Protocol.tcp);
    });

    it('should return TCP for "TCP"', () => {
      expect(normalizeProtocol('TCP')).toBe(Protocol.tcp);
    });

    it('should return TCP for "TcP" (mixed case)', () => {
      expect(normalizeProtocol('TcP')).toBe(Protocol.tcp);
    });

    it('should return UDP for "udp"', () => {
      expect(normalizeProtocol('udp')).toBe(Protocol.udp);
    });

    it('should return UDP for "UDP"', () => {
      expect(normalizeProtocol('UDP')).toBe(Protocol.udp);
    });

    it('should return TCP for unknown strings', () => {
      expect(normalizeProtocol('http')).toBe(Protocol.tcp);
      expect(normalizeProtocol('foo')).toBe(Protocol.tcp);
      expect(normalizeProtocol('unknown')).toBe(Protocol.tcp);
    });
  });

  describe('protocolToString', () => {
    it('should return "tcp" for Protocol.tcp', () => {
      expect(protocolToString(Protocol.tcp)).toBe('tcp');
    });

    it('should return "udp" for Protocol.udp', () => {
      expect(protocolToString(Protocol.udp)).toBe('udp');
    });

    it('should return undefined for undefined', () => {
      expect(protocolToString(undefined)).toBeUndefined();
    });

    it('should return undefined for invalid protocol numbers', () => {
      expect(protocolToString(2 as Protocol)).toBeUndefined();
      expect(protocolToString(-1 as Protocol)).toBeUndefined();
    });
  });
});
