// @vitest-environment node
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE ALLOWLIST REACHES THE FOURTEEN LEGACY MODULES TOO                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `/api/documents` and the sub-category form each checked their own upload. The
 * module routes — medical, vehicles, rentals, warranty and the rest — checked
 * nothing, and their pages did not set `accept` either. The same file was
 * refused by one portal and stored by another, which is exactly what the "one
 * list, both sides" contract in uploadTypes.ts exists to prevent.
 *
 * The fix is one guard in `createRecord`, which every one of those routes
 * writes through — create and update alike. These pin both halves: that the
 * guard fires before anything is written, and that the routes turn it into a
 * 400 the form can show rather than a 500.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('@/lib/db', () => {
  const boom = () => { throw new Error('the guard must run BEFORE any query'); };
  return {
    db: new Proxy({}, { get: boom }),
    withTenant: boom,
  };
});

const { createRecord, UnsupportedUploadError } = await import('@/lib/records/handler');
const { uploadTypeResponse } = await import('@/lib/uploadErrors');

const categoryKey = { moduleKey: 'medical', documentKey: 'prescription' };
const ctx = {
  user: { id: 'u1', tenantId: 't1' },
  scope: 'medical',
  keys: [categoryKey],
} as any;

const upload = (name: string, type: string) =>
  ({ name, type, size: 12, arrayBuffer: async () => new ArrayBuffer(12) }) as unknown as File;

describe('createRecord refuses a type the vault does not store', () => {
  it('throws before it touches the database', async () => {
    // The db mock throws on ANY access, so this passing is the assertion that
    // nothing was written, billed or uploaded to Drive first.
    await expect(createRecord(ctx, {
      title: 'Prescription',
      categoryKey,
      record: {},
      file: upload('backup.zip', 'application/zip'),
    } as any)).rejects.toBeInstanceOf(UnsupportedUploadError);
  });

  it('names the extension in the message the form shows', async () => {
    const error = await createRecord(ctx, {
      title: 'Prescription',
      categoryKey,
      record: {},
      file: upload('setup.exe', 'application/x-msdownload'),
    } as any).catch((e: Error) => e);
    expect((error as Error).message).toContain('.exe');
  });

  it('lets an accepted type through to the work it was going to do', async () => {
    // Reaches the db mock and dies there — which is the proof it got PAST the
    // guard. Any other error would mean the file was refused.
    const error = await createRecord(ctx, {
      title: 'Prescription',
      categoryKey,
      record: {},
      file: upload('IMG_4021.heic', 'image/heic'),
    } as any).catch((e: Error) => e);
    expect(error).not.toBeInstanceOf(UnsupportedUploadError);
  });
});

describe('the response it becomes', () => {
  it('is a 400 carrying the message on the file field', async () => {
    const response = uploadTypeResponse(new UnsupportedUploadError('.zip cannot be stored.'));
    expect(response?.status).toBe(400);
    const body = await response!.json();
    expect(body.fieldErrors.file).toContain('.zip');
    expect(body.error).toContain('.zip');
  });

  it('passes anything else through so the caller keeps its own handling', () => {
    expect(uploadTypeResponse(new Error('drive is down'))).toBeNull();
  });
});

/**
 * The structural half.
 *
 * A new module route is written by copying an old one, and the line most easily
 * lost in the copy is the one in the catch chain. Without this, the symptom is
 * a 500 on a refused upload — which looks like a server fault and gets debugged
 * as one.
 */
describe('every route that takes a file turns the refusal into a 400', () => {
  const API = 'src/app/api';

  /**
   * Routes that legitimately do not wire the responder, and why. An entry here
   * is a claim that the route CANNOT throw it, not a licence to skip the check.
   */
  const EXEMPT: Record<string, string> = {
    // Validates through categoryFormBody, which returns fieldErrors before
    // createRecord is ever called.
    'src/app/api/modules/[moduleKey]/[documentKey]/route.ts': 'validated in categoryFormBody',
    'src/app/api/modules/[moduleKey]/[documentKey]/[id]/route.ts': 'validated in categoryFormBody',
    // Files scratch pages this server itself wrote; it never passes `file`.
    'src/app/api/ai/scan/save/route.ts': 'writes scratchPages, not an upload',
  };

  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : (entry.name === 'route.ts' ? [full] : []);
    });

  it('has no route calling createRecord without the responder', () => {
    const offenders = walk(API).filter((file) => {
      const source = fs.readFileSync(file, 'utf-8');
      if (!source.includes('createRecord(')) return false;
      if (EXEMPT[file]) return false;
      return !source.includes('uploadTypeResponse');
    });
    expect(offenders).toEqual([]);
  });

  it('keeps the exemption list honest', () => {
    // An exemption for a route that no longer exists hides the next one that
    // should have been listed.
    for (const file of Object.keys(EXEMPT)) {
      expect(fs.existsSync(file), `${file} is exempted but does not exist`).toBe(true);
    }
  });
});
