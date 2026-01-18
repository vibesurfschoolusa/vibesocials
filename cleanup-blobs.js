// Run this with: node cleanup-blobs.js
// Requires BLOB_READ_WRITE_TOKEN environment variable

const { list, del } = require('@vercel/blob');

async function cleanupBlobs() {
  try {
    console.log('Fetching blobs...');
    const { blobs } = await list();
    
    console.log(`Found ${blobs.length} blobs`);
    
    let deletedCount = 0;
    let freedBytes = 0;
    
    // Delete all blobs older than 1 hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    
    for (const blob of blobs) {
      if (new Date(blob.uploadedAt) < oneHourAgo) {
        try {
          await del(blob.url);
          deletedCount++;
          freedBytes += blob.size;
          console.log(`✓ Deleted: ${blob.pathname} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
        } catch (err) {
          console.error(`✗ Failed to delete ${blob.pathname}:`, err.message);
        }
      }
    }
    
    console.log('\n=== Summary ===');
    console.log(`Deleted: ${deletedCount} blobs`);
    console.log(`Freed: ${(freedBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Remaining: ${blobs.length - deletedCount} blobs`);
  } catch (error) {
    console.error('Error:', error.message);
  }
}

cleanupBlobs();
