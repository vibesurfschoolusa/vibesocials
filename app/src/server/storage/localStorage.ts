import fs from "fs/promises";
import path from "path";

const DEFAULT_UPLOAD_ROOT = path.join(process.cwd(), "storage", "uploads");

function getUploadRoot() {
  return process.env.MEDIA_UPLOAD_ROOT || DEFAULT_UPLOAD_ROOT;
}

export interface SavedFileInfo {
  storageLocation: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
}

export async function saveUploadedFile(userId: string, file: File): Promise<SavedFileInfo> {
  const uploadRoot = getUploadRoot();
  const userDir = path.join(uploadRoot, userId);

  await fs.mkdir(userDir, { recursive: true });

  const originalFilename = file.name || "upload";
  const safeName = originalFilename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const timestamp = Date.now();
  const filename = `${timestamp}-${safeName}`;

  const filePath = path.join(userDir, filename);

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  await fs.writeFile(filePath, buffer);

  return {
    storageLocation: filePath,
    originalFilename,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: buffer.byteLength,
  };
}
