const {Pool}=require('pg');

let pool;
function database(){
  if(!process.env.DATABASE_URL)return null;
  if(!pool)pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL.includes('railway.internal')?false:{rejectUnauthorized:false},max:5});
  return pool;
}

async function initDatabase(){
  const db=database();if(!db)return false;
  await db.query(`
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id BIGSERIAL PRIMARY KEY,
      total_usdt NUMERIC(24,8) NOT NULL,
      change_24h_usdt NUMERIC(24,8) NOT NULL DEFAULT 0,
      change_24h_pct NUMERIC(12,6) NOT NULL DEFAULT 0,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS asset_snapshots (
      id BIGSERIAL PRIMARY KEY,
      portfolio_snapshot_id BIGINT NOT NULL REFERENCES portfolio_snapshots(id) ON DELETE CASCADE,
      asset VARCHAR(20) NOT NULL,
      quantity NUMERIC(36,18) NOT NULL,
      price_usdt NUMERIC(24,8) NOT NULL,
      value_usdt NUMERIC(24,8) NOT NULL,
      change_24h_pct NUMERIC(12,6) NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS portfolio_captured_idx ON portfolio_snapshots(captured_at DESC);
    CREATE INDEX IF NOT EXISTS asset_snapshot_idx ON asset_snapshots(portfolio_snapshot_id,asset);
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      event VARCHAR(80) NOT NULL,
      details JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);return true;
}

async function saveSnapshot(summary){
  const db=database();if(!db)throw new Error('Banco de dados não configurado.');
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    const saved=await client.query('INSERT INTO portfolio_snapshots(total_usdt,change_24h_usdt,change_24h_pct) VALUES($1,$2,$3) RETURNING id,captured_at',[summary.total,summary.changeValue,summary.changePct]);
    for(const item of summary.assets)await client.query('INSERT INTO asset_snapshots(portfolio_snapshot_id,asset,quantity,price_usdt,value_usdt,change_24h_pct) VALUES($1,$2,$3,$4,$5,$6)',[saved.rows[0].id,item.asset,item.quantity,item.price,item.value,item.changePct]);
    await client.query('INSERT INTO audit_log(event,details) VALUES($1,$2)',['portfolio_snapshot',{assets:summary.assets.length,total:summary.total}]);
    await client.query('COMMIT');return saved.rows[0];
  }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
}

async function history(limit=30){
  const db=database();if(!db)throw new Error('Banco de dados não configurado.');
  const result=await db.query('SELECT total_usdt::float8,change_24h_usdt::float8,change_24h_pct::float8,captured_at FROM portfolio_snapshots ORDER BY captured_at DESC LIMIT $1',[Math.min(Math.max(limit,1),365)]);
  return result.rows;
}

module.exports={initDatabase,saveSnapshot,history};
