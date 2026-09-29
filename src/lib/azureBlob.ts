import { BlobServiceClient } from '@azure/storage-blob';

export async function uploadToAzureBlob(file: File, safeName: string): Promise<string> {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'docsnx-uploads';

  if (!connectionString) {
    throw new Error('Azure Storage Connection string not found');
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  const containerClient = blobServiceClient.getContainerClient(containerName);

  try {
    await containerClient.createIfNotExists();
  } catch (error) {
    console.error('Error creating Azure container:', error);
  }

  const blockBlobClient = containerClient.getBlockBlobClient(safeName);

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  const uploadOptions = {
    blobHTTPHeaders: {
      blobContentType: file.type || 'application/octet-stream',
    },
  };

  await blockBlobClient.uploadData(buffer, uploadOptions);

  return blockBlobClient.url;
}
