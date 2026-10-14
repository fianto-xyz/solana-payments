import { AccountBatcher } from './account-batcher.js';
import type { AccountData } from './rpc.js';

const account = (owner: string): AccountData => ({ owner, lamports: 1n, dataBase64: '' });

describe('AccountBatcher', () => {
  it('sends reads that arrive together as one call, each address once, answers in order', async () => {
    const getAccounts = vi.fn((addresses: string[]) =>
      Promise.resolve(addresses.map((address) => (address === 'missing' ? null : account(address)))),
    );
    const batcher = new AccountBatcher({ getAccounts }, { commitment: 'confirmed' });
    const answers = await Promise.all(['a', 'b', 'a', 'missing'].map((address) => batcher.read(address)));
    expect(getAccounts).toHaveBeenCalledTimes(1);
    expect(getAccounts).toHaveBeenCalledWith(['a', 'b', 'missing'], { commitment: 'confirmed' });
    expect(answers.map((answer) => answer?.owner ?? null)).toEqual(['a', 'b', 'a', null]);
  });

  it('fails every read of a failed call, and the next window starts fresh', async () => {
    const getAccounts = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue([account('c')]);
    const batcher = new AccountBatcher({ getAccounts }, {});
    await expect(Promise.all([batcher.read('a'), batcher.read('b')])).rejects.toThrow('busy');
    await expect(batcher.read('c')).resolves.toMatchObject({ owner: 'c' });
    expect(getAccounts).toHaveBeenCalledTimes(2);
  });

  it('flushes at once when a call would be full', async () => {
    const getAccounts = vi.fn((addresses: string[]) => Promise.resolve(addresses.map(account)));
    const batcher = new AccountBatcher({ getAccounts }, {}, 60_000);
    await Promise.all(Array.from({ length: 100 }, (_, i) => batcher.read(`a${i}`)));
    expect(getAccounts).toHaveBeenCalledTimes(1);
    expect(getAccounts.mock.calls[0][0]).toHaveLength(100);
  });
});
