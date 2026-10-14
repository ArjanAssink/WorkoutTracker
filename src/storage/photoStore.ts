import { BlobSASPermissions, BlobServiceClient, generateBlobSASQueryParameters, StorageSharedKeyCredential, type ContainerClient } from "@azure/storage-blob";

/**
 * Photos live as blobs in the same storage account, in a private container. Pages get a
 * signed URL per photo that lasts a day — the images never pass through the function.
 */
export class PhotoStore {
  private constructor(
    private readonly container: ContainerClient,
    private readonly credential: StorageSharedKeyCredential,
  ) {}

  static fromConnectionString(connectionString: string, containerName = "photos"): PhotoStore {
    const service = BlobServiceClient.fromConnectionString(connectionString);
    const name = /AccountName=([^;]+)/.exec(connectionString)?.[1], key = /AccountKey=([^;]+)/.exec(connectionString)?.[1];
    if (!name || !key) throw new Error("Photo storage needs an AccountName/AccountKey connection string to sign URLs");
    return new PhotoStore(service.getContainerClient(containerName), new StorageSharedKeyCredential(name, key));
  }

  async ensureContainer(): Promise<void> {
    await this.container.createIfNotExists();
  }

  async exists(name: string): Promise<boolean> {
    return this.container.getBlockBlobClient(name).exists();
  }

  async put(name: string, data: Buffer, contentType: string): Promise<void> {
    await this.container.getBlockBlobClient(name).uploadData(data, { blobHTTPHeaders: { blobContentType: contentType } });
  }

  signedUrl(name: string, ttlMinutes = 24 * 60): string {
    const expiresOn = new Date(Date.now() + ttlMinutes * 60_000);
    const sas = generateBlobSASQueryParameters({ containerName: this.container.containerName, blobName: name, permissions: BlobSASPermissions.parse("r"), expiresOn }, this.credential).toString();
    return `${this.container.getBlockBlobClient(name).url}?${sas}`;
  }
}
