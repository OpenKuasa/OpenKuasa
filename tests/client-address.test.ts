import { describe, expect, it } from 'vitest';
import { clientAddressFrom, clientKey, UNKNOWN_CLIENT } from '@/lib/security/client-address';

const from = (headers: Record<string, string>) =>
  clientAddressFrom((name) => headers[name.toLowerCase()] ?? null);

describe('clientAddressFrom', () => {
  it('reads the address the platform reports', () => {
    expect(from({ 'x-real-ip': '203.0.113.7' })).toBe('203.0.113.7');
    expect(from({ 'x-real-ip': '  203.0.113.7 ' })).toBe('203.0.113.7');
  });

  it('never lets a forwarded header sent by the client choose the address', () => {
    expect(from({ 'x-forwarded-for': '198.51.100.1', 'x-real-ip': '203.0.113.7' })).toBe('203.0.113.7');
    expect(from({ 'x-forwarded-for': '198.51.100.1, 198.51.100.2' })).toBeNull();
    expect(from({ forwarded: 'for=198.51.100.1' })).toBeNull();
    expect(from({ 'cf-connecting-ip': '198.51.100.1', 'true-client-ip': '198.51.100.1' })).toBeNull();
  });

  it('has no address when the header is missing or is not one address', () => {
    expect(from({})).toBeNull();
    expect(from({ 'x-real-ip': '' })).toBeNull();
    expect(from({ 'x-real-ip': 'unknown' })).toBeNull();
    expect(from({ 'x-real-ip': '203.0.113.7, 198.51.100.1' })).toBeNull();
    expect(from({ 'x-real-ip': '999.1.1.1' })).toBeNull();
    expect(from({ 'x-real-ip': 'x'.repeat(500) })).toBeNull();
  });

  it('treats one IPv6 network as one client, however the address is written', () => {
    expect(from({ 'x-real-ip': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' })).toBe('2001:db8:1:2::/64');
    expect(from({ 'x-real-ip': '2001:DB8:1:2::1' })).toBe('2001:db8:1:2::/64');
    expect(from({ 'x-real-ip': '2001:0db8:0001:0002:0:0:0:1' })).toBe('2001:db8:1:2::/64');
    expect(from({ 'x-real-ip': '2001:db8::1' })).toBe('2001:db8:0:0::/64');
    expect(from({ 'x-real-ip': '::1' })).toBe('0:0:0:0::/64');
  });

  it('reads an IPv4 address carried inside an IPv6 one as that IPv4 address', () => {
    expect(from({ 'x-real-ip': '::ffff:203.0.113.7' })).toBe('203.0.113.7');
  });
});

describe('clientKey', () => {
  it('is the address, or one shared name when there is none', () => {
    expect(clientKey('203.0.113.7')).toEqual({ key: '203.0.113.7', known: true });
    expect(clientKey(null)).toEqual({ key: UNKNOWN_CLIENT, known: false });
  });
});
