/**
 * Modular Google Drive Zero-Knowledge JSON Sync Engine
 *
 * Partitions the tenant's records into separate encrypted JSON modules inside the
 * tenant's dedicated Drive folder (/DocsNX_Data/<module>.enc.json) to optimise
 * bandwidth and support granular access. Detects storage quota overflow so the
 * caller can offer a fallback.
 *
 * Everything here relays ciphertext produced by src/lib/clientCrypto.ts. No
 * plaintext record ever passes through this module.
 */

import {
  type Drive,
  downloadDriveFile,
  isQuotaError,
  listDriveFolderFiles,
  uploadFileToDriveFolder,
} from './googleDrive';

/**
 * The syncable modules.
 *
 * These names are exactly the keys of `data` in the `/api/backup` export, and a
 * restore posts them straight back to that endpoint. They must not drift: a
 * renamed module here silently stops round-tripping.
 */
export const MODULE_NAMES = [
  'manifest',
  'users',
  'documents',
  'medicalRecords',
  'passwords',
  'bankInfos',
  'creditCards',
  'tradingDemats',
  'vehicles',
  'licMediclaims',
  'investments',
  'emergencyContacts',
  'warrantyAmcs',
  'contractAgreements',
  'todos',
  'taxCompliances',
  'willsEstates',
  'loansDebts',
  'utilityBills',
  'corporateCompliances',
  'employmentPayrolls',
] as const;

export type ModuleName = (typeof MODULE_NAMES)[number];

const MODULE_NAME_SET = new Set<string>(MODULE_NAMES);

export function isModuleName(value: unknown): value is ModuleName {
  return typeof value === 'string' && MODULE_NAME_SET.has(value);
}

export function moduleFileName(moduleName: ModuleName): string {
  return `${moduleName}.enc.json`;
}

/** Maps a file inside the folder back to its module, or null if it is not ours. */
export function moduleFromFileName(fileName: string): ModuleName | null {
  if (!fileName.endsWith('.enc.json')) return null;
  const base = fileName.slice(0, -'.enc.json'.length);
  return isModuleName(base) ? base : null;
}

export interface SyncResult {
  status: 'SUCCESS' | 'QUOTA_EXCEEDED' | 'ERROR';
  fileId?: string;
  errorMessage?: string;
}

/**
 * Uploads one module's ciphertext into the tenant's dedicated folder.
 *
 * Pass `existingFileId` to overwrite the module's previous file. Omitting it
 * creates a duplicate rather than replacing, because Drive permits repeated
 * names within a folder.
 */
export async function syncEncryptedModuleToDrive(
  drive: Drive,
  folderId: string,
  moduleName: ModuleName,
  encryptedCiphertext: string,
  existingFileId?: string | null
): Promise<SyncResult> {
  try {
    const { id } = await uploadFileToDriveFolder(
      drive,
      folderId,
      moduleFileName(moduleName),
      'application/json',
      encryptedCiphertext,
      existingFileId
    );
    return { status: 'SUCCESS', fileId: id };
  } catch (error: any) {
    if (isQuotaError(error)) {
      return {
        status: 'QUOTA_EXCEEDED',
        errorMessage: 'Tenant Google Drive storage is full.',
      };
    }
    // A stale file id (the user deleted the file from their own Drive) is
    // recoverable: retry once as a fresh create.
    if (existingFileId && Number(error?.response?.status ?? error?.code) === 404) {
      return await syncEncryptedModuleToDrive(drive, folderId, moduleName, encryptedCiphertext);
    }
    return { status: 'ERROR', errorMessage: error?.message || 'Network sync error' };
  }
}

/**
 * Reads every module back out of the tenant's folder.
 *
 * Returns ciphertext exactly as stored — decryption happens in the browser with
 * the master passphrase, which the server never sees.
 */
export async function readEncryptedModulesFromDrive(
  drive: Drive,
  folderId: string
): Promise<{
  modules: Partial<Record<ModuleName, string>>;
  fileIds: Partial<Record<ModuleName, string>>;
  lastModified: string | null;
}> {
  const files = await listDriveFolderFiles(drive, folderId);

  const modules: Partial<Record<ModuleName, string>> = {};
  const fileIds: Partial<Record<ModuleName, string>> = {};
  let lastModified: string | null = null;

  for (const file of files) {
    const moduleName = moduleFromFileName(file.name);
    if (!moduleName || modules[moduleName]) continue;

    modules[moduleName] = await downloadDriveFile(drive, file.id);
    fileIds[moduleName] = file.id;

    if (file.modifiedTime && (!lastModified || file.modifiedTime > lastModified)) {
      lastModified = file.modifiedTime;
    }
  }

  return { modules, fileIds, lastModified };
}
