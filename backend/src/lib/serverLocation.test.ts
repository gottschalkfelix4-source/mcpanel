import { afterEach, describe, expect, it } from 'vitest';
import { config, serverDir, serverHostDir } from '../config.js';
import {
  forgetServer, nodeIdOf, removeNodeLocation, replaceServerLocations, serverNodeLocation, serversOnNode,
  setNodeLocation, setServerNode,
} from './serverLocation.js';

const vps = { id: 'vps', name: 'VPS', tunnelIp: '10.66.0.2', agentToken: 't', publicHost: 'vps.example.test', dataRoot: '/opt/mcpanel-node', ports: { docker: 2375, status: 7480, rcon: 7481, smb: 445 }, dataVolume: null };

afterEach(() => {
  replaceServerLocations([]);
  removeNodeLocation('vps');
});

describe('Serverstandorte', () => {
  it('behandelt unbekannte Server als lokal', () => {
    expect(nodeIdOf('abc')).toBeNull();
    expect(serverDir('abc').replace(/\\/g, '/')).toBe(`${config.dataRoot.replace(/\\/g, '/')}/servers/abc`);
  });

  it('legt Server auf einer Node in deren eingehängte Freigabe und Host-Pfad', () => {
    setNodeLocation(vps);
    setServerNode('abc', 'vps');
    expect(serverDir('abc').replace(/\\/g, '/')).toBe(`${config.dataRoot.replace(/\\/g, '/')}/nodes/vps/servers/abc`);
    expect(serverHostDir('abc')).toBe('/opt/mcpanel-node/servers/abc');
    expect(serversOnNode('vps')).toEqual(['abc']);
  });

  it('fällt bei einer unbekannten Node nie still auf lokal zurück', () => {
    setServerNode('abc', 'weg');
    expect(() => serverNodeLocation('abc')).toThrow('nicht bekannt');
    expect(() => serverDir('abc')).toThrow('nicht bekannt');
  });

  it('vergisst gelöschte Server und lädt den Stand komplett neu', () => {
    setNodeLocation(vps);
    replaceServerLocations([{ id: 'a', nodeId: 'vps' }, { id: 'b', nodeId: null }]);
    expect(nodeIdOf('a')).toBe('vps');
    expect(nodeIdOf('b')).toBeNull();
    forgetServer('a');
    expect(nodeIdOf('a')).toBeNull();
  });
});
