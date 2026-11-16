// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Dependency-URL validation (tier boundary + SSRF guard).
 *
 * Tier-2 dependencies must be public HTTPS endpoints. A Docker service name, a
 * private DNS suffix, RFC 1918/CGNAT space or an IPv6 ULA/link-local/mapped
 * address can only reach a private service, so production start-up must fail
 * fast instead of silently routing Tier-2 traffic to a private dependency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicDependency, isPrivateHost } from './config';

test('private IPv4 ranges, CGNAT and reserved space are never public dependencies', () => {
  for (const host of [
    '127.0.0.1',
    '127.10.20.30',
    '10.0.0.1',
    '10.148.0.2',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.254',
    '0.0.0.0',
    '0.1.2.3',
    '192.0.2.10',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '239.255.255.250',
    '255.255.255.255',
  ]) {
    assert.equal(isPrivateHost(host), true, `${host} must be treated as private`);
  }
});

test('public IPv4 addresses stay allowed', () => {
  for (const host of ['8.8.8.8', '1.1.1.1', '136.85.84.73', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1']) {
    assert.equal(isPrivateHost(host), false, `${host} must stay public`);
  }
});

test('container names and private DNS suffixes are private', () => {
  for (const host of [
    'capabilities',
    'postgres',
    'city-service',
    'localhost',
    'localhost.',
    'api.localhost',
    'metadata.google.internal',
    'db.internal',
    'nas.lan',
    'printer.local',
    'svc.cluster.local',
    'host.docker.internal',
    'app.home.arpa',
  ]) {
    assert.equal(isPrivateHost(host), true, `${host} must be treated as private`);
  }
});

test('IPv6 loopback, ULA, link-local, mapped and documentation ranges are private', () => {
  for (const host of [
    '::',
    '::1',
    '[::1]',
    '0:0:0:0:0:0:0:1',
    'fe80::1',
    'febf::1',
    'fc00::1',
    'fd12:3456:789a::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.148.0.2',
    '0:0:0:0:0:ffff:192.168.1.1',
    '64:ff9b::7f00:1',
    '2001:db8::1',
    '2002:7f00:1::1',
    '100::1',
  ]) {
    assert.equal(isPrivateHost(host), true, `${host} must be treated as private`);
  }
});

test('public IPv6 addresses stay allowed', () => {
  for (const host of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:80b::200e']) {
    assert.equal(isPrivateHost(host), false, `${host} must stay public`);
  }
});

test('public HTTPS dependencies are accepted and private ones fail fast', () => {
  assert.equal(assertPublicDependency('https://api.synapseone.space/', 'SYNAPSEONE_BASE_URL', false), 'https://api.synapseone.space');
  assert.equal(assertPublicDependency('https://synapsedx.sbs', 'SYNAPSEDX_PUBLIC_URL', false), 'https://synapsedx.sbs');

  // Docker/compose service names and private addresses must never be production
  // dependencies, even over HTTP (the local override is for tests only).
  for (const value of [
    'http://capabilities:8082',
    'https://capabilities:8082',
    'http://postgres:5432',
    'http://10.148.0.2:4001',
    'http://127.0.0.1:4001',
    'https://metadata.google.internal',
  ]) {
    assert.throws(
      () => assertPublicDependency(value, 'SYNAPSEONE_BASE_URL', false),
      /public HTTPS endpoint/,
      `${value} must be rejected in production`,
    );
    assert.equal(assertPublicDependency(value, 'SYNAPSEONE_BASE_URL', true), value.replace(/\/+$/, ''));
  }

  // Plain HTTP is rejected for public hosts; local test overrides are exempt.
  assert.throws(() => assertPublicDependency('http://api.synapseone.space', 'SYNAPSEONE_BASE_URL', false), /must use HTTPS/);
  assert.throws(() => assertPublicDependency('not-a-url', 'SYNAPSEONE_BASE_URL', false), /not an absolute URL/);
});
