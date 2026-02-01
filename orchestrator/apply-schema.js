import 'dotenv/config';
import { Client } from 'pg';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const SUPABASE_URL = process.env.SUPABASE_URL;
const DB_PASSWORD = process.env.SUPABASE_DB_PASSWORD;
const DB_HOST_ENV = process.env.SUPABASE_DB_HOST;
const DB_USER = process.env.SUPABASE_DB_USER || 'postgres';
const DB_URL = process.env.SUPABASE_DB_URL;

if (!SUPABASE_URL && !DB_URL) {
  console.error('Missing SUPABASE_URL or SUPABASE_DB_URL in .env');
  process.exit(1);
}

if (!DB_PASSWORD && !DB_URL) {
  console.error('Missing SUPABASE_DB_PASSWORD (or SUPABASE_DB_URL) in .env');
  process.exit(1);
}

const ref = SUPABASE_URL ? new URL(SUPABASE_URL).hostname.split('.')[0] : null;
const dbHost = DB_HOST_ENV || (ref ? `db.${ref}.supabase.co` : null);

const connectionString = DB_URL || `postgresql://${DB_USER}:${encodeURIComponent(DB_PASSWORD)}@${dbHost}:5432/postgres`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, '..', 'supabase', 'schema.sql');

const sql = await fs.readFile(schemaPath, 'utf8');

const client = new Client({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

try {
  console.log('Connecting to Supabase DB...');
  await client.connect();
  console.log('Applying schema...');
  await client.query(sql);
  console.log('Schema applied.');
} catch (err) {
  console.error('Schema apply failed:', err?.message || err);
  process.exit(1);
} finally {
  await client.end();
}
