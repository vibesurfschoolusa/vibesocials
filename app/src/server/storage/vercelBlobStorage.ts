import { put } from "@vercel/blob";

export interface SavedFileInfo {
  storageLocation: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
}

export async function saveUploadedFile(
  userId: string,
  file: File
): Promise<SavedFileInfo> {
  const originalFilename = file.name || "upload";
  const safeName = originalFilename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const timestamp = Date.now();
  const filename = `${userId}/${timestamp}-${safeName}`;

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Upload to Vercel Blob
  const blob = await put(filename, buffer, {
    access: "public",
    contentType: file.type || "application/octet-stream",
  });

  return {
    storageLocation: blob.url, // Public URL from Vercel Blob
    originalFilename,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: buffer.byteLength,
  };
}
