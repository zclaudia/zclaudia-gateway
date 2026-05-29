import { describe, expect, it } from 'vitest';
import { encodeProxyRequestBody } from '../proxy-body.js';

describe('encodeProxyRequestBody', () => {
  it('encodes binary payloads as base64', () => {
    const payload = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x41]);

    expect(encodeProxyRequestBody(payload, 'application/octet-stream')).toEqual({
      bodyEncoding: 'base64',
      body: payload.toString('base64'),
    });
  });

  it('preserves utf8 request payloads as text', () => {
    expect(encodeProxyRequestBody(Buffer.from('{"ok":true}'), 'application/json; charset=utf-8')).toEqual({
      bodyEncoding: 'utf8',
      body: '{"ok":true}',
    });
  });

  it('returns empty metadata for unsupported body shapes', () => {
    expect(encodeProxyRequestBody({ nope: true }, 'application/json')).toEqual({});
  });
});
