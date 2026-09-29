import { describe, it, expect, vi } from 'vitest';
import { runAfterResponse } from '@/lib/records/afterResponse';

// Outside a request scope `after()` throws, so the helper must still run the
// task (route tests call handlers directly) and must never let it reject.
describe('runAfterResponse outside a request', () => {
  it('starts the task immediately', () => {
    const task = vi.fn(async () => {});
    runAfterResponse('test', task);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('swallows and logs a rejection', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runAfterResponse('test', async () => { throw new Error('drive down'); });
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalledWith('[after-response] test failed:', expect.any(Error));
    spy.mockRestore();
  });
});
