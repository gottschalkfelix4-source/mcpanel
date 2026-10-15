import { afterEach, describe, expect, it } from 'vitest';
import {
  AddressList, clientAddress, isPublicAddress, normalizeAddress, parseAddressList,
  setServerNetwork, setTrustedProxies, trustProxy,
} from './network.js';

afterEach(() => {
  setTrustedProxies('');
  setServerNetwork([], []);
});

describe('normalizeAddress', () => {
  it.each([
    ['::ffff:10.0.0.1', '10.0.0.1'],
    ['[::1]', '::1'],
    ['fe80::1%eth0', 'fe80::1'],
    ['  FD00::AB ', 'fd00::ab'],
    [undefined, ''],
  ])('macht aus %s → %s', (input, expected) => {
    expect(normalizeAddress(input)).toBe(expected);
  });
});

describe('AddressList', () => {
  it('erkennt Adressen in CIDR-Bereichen und verwirft Ungültiges', () => {
    const list = new AddressList();
    expect(list.add('10.0.0.0/8')).toBe(true);
    expect(list.add('fd00::/8')).toBe(true);
    expect(list.add('kein-netz')).toBe(false);
    expect(list.add('10.0.0.0/33')).toBe(false);
    expect(list.has('10.200.1.1')).toBe(true);
    expect(list.has('::ffff:10.1.1.1')).toBe(true);
    expect(list.has('fd12::1')).toBe(true);
    expect(list.has('11.0.0.1')).toBe(false);
  });

  it('eine leere Liste enthält nichts', () => {
    expect(parseAddressList('').has('127.0.0.1')).toBe(false);
    expect(parseAddressList(' , ').has('127.0.0.1')).toBe(false);
  });
});

describe('isPublicAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '192.168.188.129', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '0.0.0.0'])(
    'stuft %s als nicht öffentlich ein', (address) => {
      expect(isPublicAddress(address)).toBe(false);
    },
  );
  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('stuft %s als öffentlich ein', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
  it('ein Hostname ist keine Adresse', () => {
    expect(isPublicAddress('example.com')).toBe(false);
  });
});

describe('Proxy-Vertrauen', () => {
  it('vertraut dem direkten nginx im Heimnetz, aber keinem Minecraft-Container', () => {
    setServerNetwork(['172.30.0.0/16'], ['172.30.0.1']);
    expect(trustProxy('127.0.0.1', 0)).toBe(true);
    expect(trustProxy('192.168.1.10', 0)).toBe(true);
    expect(trustProxy('172.30.0.5', 0)).toBe(false);
    // Das Gateway ist der Docker-Host selbst.
    expect(trustProxy('172.30.0.1', 0)).toBe(true);
    expect(trustProxy('8.8.8.8', 0)).toBe(false);
  });

  it('übernimmt X-Forwarded-For nur vom direkten Proxy', () => {
    expect(clientAddress('127.0.0.1', '203.0.113.9')).toBe('203.0.113.9');
    expect(clientAddress('8.8.8.8', '203.0.113.9')).toBe('8.8.8.8');
  });

  it('eine gefälschte Kette vor dem Proxy zählt nicht ohne TRUSTED_PROXIES', () => {
    // Client 192.168.1.50 schickt selbst "X-Forwarded-For: 1.2.3.4"
    expect(clientAddress('127.0.0.1', '1.2.3.4, 192.168.1.50')).toBe('192.168.1.50');
  });

  it('folgt der Kette durch einen eingetragenen vorgeschalteten Proxy', () => {
    setTrustedProxies('192.168.1.2');
    expect(clientAddress('127.0.0.1', '203.0.113.9, 192.168.1.2')).toBe('203.0.113.9');
    expect(clientAddress('127.0.0.1', ['203.0.113.9', '192.168.1.3'])).toBe('192.168.1.3');
  });
});
