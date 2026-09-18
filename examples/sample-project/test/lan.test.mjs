import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lanAddresses } from '../lib/lan.mjs';

test('mistura de IPv4 interno, IPv4 externo repetido, e IPv6 externo -> só o IPv4 externo uma vez', () => {
  const interfaces = {
    'Loopback Pseudo-Interface 1': [
      { address: '127.0.0.1', family: 'IPv4', internal: true },
      { address: '::1', family: 'IPv6', internal: true },
    ],
    'Ethernet': [
      { address: '192.168.1.23', family: 'IPv4', internal: false },
      { address: 'fe80::1234:5678:9abc:def0', family: 'IPv6', internal: false },
    ],
    'Wi-Fi': [
      // same external IPv4 address again, on a second interface (e.g. a bridge) — must not repeat
      { address: '192.168.1.23', family: 'IPv4', internal: false },
    ],
  };

  assert.deepEqual(lanAddresses(interfaces), ['192.168.1.23']);
});

test('família numérica 4 conta como IPv4', () => {
  const interfaces = {
    eth0: [{ address: '10.0.0.5', family: 4, internal: false }],
  };
  assert.deepEqual(lanAddresses(interfaces), ['10.0.0.5']);
});

test('ordem é a ordem de aparição, entre interfaces diferentes', () => {
  const interfaces = {
    a: [{ address: '10.0.0.2', family: 'IPv4', internal: false }],
    b: [{ address: '10.0.0.1', family: 'IPv4', internal: false }],
  };
  assert.deepEqual(lanAddresses(interfaces), ['10.0.0.2', '10.0.0.1']);
});

test('entradas malformadas são ignoradas em vez de rebentar', () => {
  const interfaces = {
    weird: [
      null,
      undefined,
      42,
      {},
      { address: '10.0.0.9', family: 'IPv4' }, // internal missing -> not explicitly false, ignored
      { address: '10.0.0.10', family: 'IPv4', internal: false },
    ],
    notAnArray: 'oops',
  };
  assert.deepEqual(lanAddresses(interfaces), ['10.0.0.10']);
});

test('{} -> []', () => {
  assert.deepEqual(lanAddresses({}), []);
});

test('undefined -> [] (usa os.networkInterfaces() por omissão, sem rebentar)', () => {
  assert.deepEqual(lanAddresses(undefined), []);
});

test('sem argumento nenhum usa os.networkInterfaces() e devolve sempre um array', () => {
  const result = lanAddresses();
  assert.ok(Array.isArray(result));
  for (const address of result) assert.equal(typeof address, 'string');
});
