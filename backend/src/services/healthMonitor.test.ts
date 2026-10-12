import { expect, it } from 'vitest';
import { HealthMonitor } from './healthMonitor.js';

it('warnt erst bei zwei Minuten anhaltender Störung und meldet die Erholung einmal', () => {
  const monitor = new HealthMonitor();
  expect(monitor.observe('a', 'running', 'unhealthy', null, 0)).toBeNull();
  expect(monitor.observe('a', 'running', 'unhealthy', null, 119999)).toBeNull();
  expect(monitor.observe('a', 'running', 'unhealthy', null, 120000)).toBe('failed');
  expect(monitor.observe('a', 'running', 'unhealthy', null, 900000)).toBeNull();
  expect(monitor.observe('a', 'running', 'healthy', null, 920000)).toBe('recovered');
  expect(monitor.observe('a', 'running', 'healthy', null, 940000)).toBeNull();
});
it('gibt großen Modpacks fünfzehn Minuten Anlaufzeit', () => {
  const monitor = new HealthMonitor();
  expect(monitor.observe('a', 'running', 'unhealthy', new Date(0).toISOString(), 899999)).toBeNull();
  expect(monitor.observe('a', 'running', 'unhealthy', new Date(0).toISOString(), 900000)).toBeNull();
  expect(monitor.observe('a', 'running', 'unhealthy', new Date(0).toISOString(), 1020000)).toBe('failed');
});
it('behandelt einen Stopp und fehlende Prüfwerte nicht als Ausfall', () => {
  const monitor = new HealthMonitor();
  monitor.observe('a', 'running', 'unhealthy', null, 0);
  expect(monitor.observe('a', 'stopped', 'unhealthy', null, 120000)).toBeNull();
  expect(monitor.observe('a', 'running', null, null, 240000)).toBeNull();
  expect(monitor.observe('a', 'running', 'healthy', null, 360000)).toBeNull();
});
it('entfernt den Zustand gelöschter Server', () => {
  const monitor = new HealthMonitor();
  monitor.observe('a', 'running', 'unhealthy', null, 0);
  monitor.retain(new Set());
  expect(monitor.observe('a', 'running', 'unhealthy', null, 120000)).toBeNull();
});
