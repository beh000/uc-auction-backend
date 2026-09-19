const zlib = require('zlib');
const { BSON } = require('mongodb');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const KEEP_BACKUPS = 14; // ~2 weeks of daily backups; the self-hosted Mongo has no automatic backups of its own

function s3Client() {
  return new S3Client({
    region: process.env.BACKUP_REGION || 'auto',
    endpoint: process.env.BACKUP_ENDPOINT,
    credentials: {
      accessKeyId: process.env.BACKUP_ACCESS_KEY_ID,
      secretAccessKey: process.env.BACKUP_SECRET_ACCESS_KEY
    }
  });
}

// EJSON (not plain JSON) so ObjectId/Date/etc. round-trip correctly on restore
// instead of collapsing into plain strings.
async function dumpToJson(db) {
  const collections = await db.listCollections().toArray();
  const dump = {};
  for (const { name } of collections) {
    dump[name] = await db.collection(name).find({}).toArray();
  }
  return BSON.EJSON.stringify(dump);
}

async function deleteOldBackups(s3, bucket) {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'backup-' }));
  const objects = (list.Contents || []).sort((a, b) => b.Key.localeCompare(a.Key));
  const stale = objects.slice(KEEP_BACKUPS);
  for (const obj of stale) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
  }
}

async function backupDatabase(db) {
  const bucket = process.env.BACKUP_BUCKET;
  if (!bucket) return; // backups not configured — skip silently rather than crash the caller

  const json = await dumpToJson(db);
  const gz = zlib.gzipSync(json);
  const key = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`;

  const s3 = s3Client();
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: gz, ContentType: 'application/gzip' }));
  console.log(`Mongo backup uploaded: ${key} (${gz.length} bytes)`);

  await deleteOldBackups(s3, bucket);
}

module.exports = { backupDatabase };
