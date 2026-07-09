import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { list, del } from "@vercel/blob";

/**
 * DELETE /api/admin/cleanup-blobs
 * Cleans up orphaned blobs from failed posts
 * Admin only - removes blobs that are older than 24 hours
 */
export async function DELETE() {
  const user = await getCurrentUser();
  
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // List all blobs in storage
    const { blobs } = await list();
    
    let deletedCount = 0;
    let freedBytes = 0;
    const errors: string[] = [];

    // Delete blobs older than 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    for (const blob of blobs) {
      try {
        // Check if blob is older than 24 hours
        if (new Date(blob.uploadedAt) < oneDayAgo) {
          await del(blob.url);
          deletedCount++;
          freedBytes += blob.size;
          console.log(`[Cleanup] Deleted blob: ${blob.pathname} (${blob.size} bytes)`);
        }
      } catch (error: unknown) {
        errors.push(`Failed to delete ${blob.pathname}: ${(error as Error).message}`);
      }
    }

    return NextResponse.json({
      success: true,
      deletedCount,
      freedMB: (freedBytes / (1024 * 1024)).toFixed(2),
      totalBlobs: blobs.length,
      remainingBlobs: blobs.length - deletedCount,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error: unknown) {
    console.error("[Cleanup] Failed to cleanup blobs:", error);
    return NextResponse.json(
      { error: (error as Error).message || "Failed to cleanup blobs" },
      { status: 500 }
    );
  }
}
