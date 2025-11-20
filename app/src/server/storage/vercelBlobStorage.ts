import { put } from "@vercel/blob";

export interface SavedFileInfo {
  storageLocation: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
}

function getMimeTypeFromFilename(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  const mimeTypes: Record<string, string> = {
    'mp4': 'video/mp4',
    'mov': 'video/quicktime',
    'avi': 'video/x-msvideo',
    'webm': 'video/webm',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
  };
  return mimeTypes[ext || ''] || 'application/octet-stream';
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

  // Determine mime type from file.type or fallback to file extension
  const detectedMimeType = file.type || getMimeTypeFromFilename(originalFilename);
  
  console.log('[Blob Storage] Upload details:', {
    originalFilename,
    browserFileType: file.type,
    detectedMimeType,
    sizeBytes: buffer.byteLength
  });

  // Upload to Vercel Blob
  const blob = await put(filename, buffer, {
    access: "public",
    contentType: detectedMimeType,
  });

  return {
    storageLocation: blob.url, // Public URL from Vercel Blob
    originalFilename,
    mimeType: detectedMimeType,
    sizeBytes: buffer.byteLength,
  };
}
