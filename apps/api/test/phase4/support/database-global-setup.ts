import pg from 'pg';
import { setupDatabaseTemplate } from '../../phase3/support/database-global-setup.js';

async function sourceSnapshot(url: string) {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows as { tablename: string }[];
    const counts: Record<string, string> = {};
    for (const { tablename } of tables) counts[tablename] = (await client.query(`SELECT count(*) AS count FROM "${tablename.replaceAll('"', '""')}"`)).rows[0].count;
    const migrations = tables.some(t => t.tablename === '_prisma_migrations') ? (await client.query('SELECT migration_name, checksum, finished_at FROM "_prisma_migrations" ORDER BY migration_name')).rows : [];
    return { counts, migrations };
  } finally { await client.end(); }
}
export default async function setup() {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL is required for owned Phase4 fixtures');
  const before = await sourceSnapshot(source);
  const teardown = await setupDatabaseTemplate(false);
  const namespace = process.env.PHASE3_NAMESPACE!;
  process.env.PHASE4_NAMESPACE = namespace;
  process.env.PHASE4_TEMPLATE = process.env.PHASE3_TEMPLATE;
  return async () => {
    try {
      await teardown();
      if (JSON.stringify(await sourceSnapshot(source)) !== JSON.stringify(before)) throw new Error('Phase4 source tables or migration records changed');
      const inspector = new pg.Client({ connectionString: source });
      try {
        await inspector.connect();
        if ((await inspector.query('SELECT datname FROM pg_database WHERE starts_with(datname, $1)', [namespace])).rows.length) throw new Error('Phase4 owned database cleanup incomplete');
      } finally { await inspector.end(); }
      console.log('Phase4 isolation: source counts/migrations unchanged; all owned databases absent.');
    } finally { delete process.env.PHASE4_NAMESPACE; delete process.env.PHASE4_TEMPLATE; }
  };
}
