import { nonceOfSiwsMessage, renderSiwsMessage, siwsChainId, SIWS_VERSION } from './siws.js';

const FIELDS = {
  domain: 'app.example.com',
  address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  statement: 'Sign in to Example.',
  uri: 'https://app.example.com',
  version: SIWS_VERSION,
  chainId: 'mainnet',
  nonce: '0123456789abcdef0123456789abcdef',
  issuedAt: '2030-01-01T00:00:00.000Z',
  expirationTime: '2030-01-01T00:05:00.000Z',
};

describe('renderSiwsMessage', () => {
  it('renders the Sign In With Solana text a Wallet Standard wallet produces for the same input', () => {
    expect(renderSiwsMessage(FIELDS)).toBe(
      [
        'app.example.com wants you to sign in with your Solana account:',
        '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
        '',
        'Sign in to Example.',
        '',
        'URI: https://app.example.com',
        'Version: 1',
        'Chain ID: mainnet',
        'Nonce: 0123456789abcdef0123456789abcdef',
        'Issued At: 2030-01-01T00:00:00.000Z',
        'Expiration Time: 2030-01-01T00:05:00.000Z',
      ].join('\n'),
    );
  });
});

describe('renderSiwsMessage validation', () => {
  it.each(['\n', '\r', ' ', ' '])('throws when a field contains %j', (breakChar) => {
    expect(() => renderSiwsMessage({ ...FIELDS, statement: `line one${breakChar}line two` })).toThrow();
  });

  it('throws when a field is longer than the length cap', () => {
    expect(() => renderSiwsMessage({ ...FIELDS, uri: `https://${'a'.repeat(2048)}.example` })).toThrow();
  });

  it('omits the statement block entirely when the statement is empty', () => {
    expect(renderSiwsMessage({ ...FIELDS, statement: '' })).toBe(
      [
        'app.example.com wants you to sign in with your Solana account:',
        '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
        '',
        'URI: https://app.example.com',
        'Version: 1',
        'Chain ID: mainnet',
        'Nonce: 0123456789abcdef0123456789abcdef',
        'Issued At: 2030-01-01T00:00:00.000Z',
        'Expiration Time: 2030-01-01T00:05:00.000Z',
      ].join('\n'),
    );
  });
});

describe('siwsChainId', () => {
  it.each([
    ['mainnet-beta', 'mainnet'],
    ['devnet', 'devnet'],
    ['localnet', 'localnet'],
  ] as const)('%s is announced as %s', (cluster, chainId) => {
    expect(siwsChainId(cluster)).toBe(chainId);
  });
});

describe('nonceOfSiwsMessage', () => {
  it('reads the nonce line', () => {
    expect(nonceOfSiwsMessage(renderSiwsMessage(FIELDS))).toBe(FIELDS.nonce);
  });

  it('answers null when there is no well-formed nonce line', () => {
    expect(nonceOfSiwsMessage('hello')).toBeNull();
    expect(nonceOfSiwsMessage('Nonce: abc')).toBeNull();
    expect(nonceOfSiwsMessage('Nonce: 0123456789abcdef-0123')).toBeNull();
  });
});
