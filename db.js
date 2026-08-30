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
    CREATE TABLE IF NOT EXISTS paper_accounts (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      cash_usdt NUMERIC(24,8) NOT NULL,
      initial_usdt NUMERIC(24,8) NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS paper_positions (
      symbol VARCHAR(24) PRIMARY KEY,
      asset VARCHAR(20) NOT NULL,
      quantity NUMERIC(36,18) NOT NULL DEFAULT 0,
      average_price_usdt NUMERIC(24,8) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS paper_orders (
      id BIGSERIAL PRIMARY KEY,
      symbol VARCHAR(24) NOT NULL,
      side VARCHAR(4) NOT NULL CHECK (side IN ('BUY','SELL')),
      quantity NUMERIC(36,18) NOT NULL,
      price_usdt NUMERIC(24,8) NOT NULL,
      notional_usdt NUMERIC(24,8) NOT NULL,
      fee_usdt NUMERIC(24,8) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO paper_accounts(id,cash_usdt,initial_usdt)
    VALUES(1,1000,1000) ON CONFLICT(id) DO NOTHING;
    CREATE INDEX IF NOT EXISTS paper_orders_created_idx ON paper_orders(created_at DESC);
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

async function portfolioBaseline(){
  const db=database();if(!db)throw new Error('Banco de dados não configurado.');
  const result=await db.query('SELECT total_usdt::float8,captured_at FROM portfolio_snapshots ORDER BY captured_at DESC LIMIT 1');
  return result.rows[0]||null;
}

async function paperData(){
  const db=database();if(!db)throw new Error('Banco de dados não configurado.');
  const [account,positions,orders]=await Promise.all([
    db.query('SELECT cash_usdt::float8,initial_usdt::float8,updated_at FROM paper_accounts WHERE id=1'),
    db.query('SELECT symbol,asset,quantity::float8,average_price_usdt::float8 FROM paper_positions WHERE quantity>0 ORDER BY symbol'),
    db.query('SELECT id,symbol,side,quantity::float8,price_usdt::float8,notional_usdt::float8,fee_usdt::float8,created_at FROM paper_orders ORDER BY created_at DESC LIMIT 50')
  ]);
  return {account:account.rows[0],positions:positions.rows,orders:orders.rows};
}

async function paperOrder({symbol,asset,side,quantity,price,feeRate=0.001}){
  const db=database();if(!db)throw new Error('Banco de dados não configurado.');
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    const account=(await client.query('SELECT cash_usdt::float8,initial_usdt::float8 FROM paper_accounts WHERE id=1 FOR UPDATE')).rows[0];
    const current=(await client.query('SELECT quantity::float8,average_price_usdt::float8 FROM paper_positions WHERE symbol=$1 FOR UPDATE',[symbol])).rows[0]||{quantity:0,average_price_usdt:0};
    const notional=quantity*price,fee=notional*feeRate;
    if(side==='BUY'){
      if(notional+fee>account.cash_usdt)throw new Error('Saldo simulado insuficiente.');
      const nextQuantity=current.quantity+quantity;
      const nextAverage=((current.quantity*current.average_price_usdt)+notional)/nextQuantity;
      await client.query('UPDATE paper_accounts SET cash_usdt=cash_usdt-$1,updated_at=NOW() WHERE id=1',[notional+fee]);
      await client.query(`INSERT INTO paper_positions(symbol,asset,quantity,average_price_usdt) VALUES($1,$2,$3,$4)
        ON CONFLICT(symbol) DO UPDATE SET quantity=$3,average_price_usdt=$4,updated_at=NOW()`,[symbol,asset,nextQuantity,nextAverage]);
    }else{
      if(quantity>current.quantity)throw new Error('Quantidade simulada insuficiente para vender.');
      const nextQuantity=current.quantity-quantity;
      await client.query('UPDATE paper_accounts SET cash_usdt=cash_usdt+$1,updated_at=NOW() WHERE id=1',[notional-fee]);
      await client.query('UPDATE paper_positions SET quantity=$2,updated_at=NOW() WHERE symbol=$1',[symbol,nextQuantity]);
    }
    await client.query('INSERT INTO paper_orders(symbol,side,quantity,price_usdt,notional_usdt,fee_usdt) VALUES($1,$2,$3,$4,$5,$6)',[symbol,side,quantity,price,notional,fee]);
    await client.query('INSERT INTO audit_log(event,details) VALUES($1,$2)',['paper_order',{symbol,side,quantity,price}]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
}

module.exports={initDatabase,saveSnapshot,history,portfolioBaseline,paperData,paperOrder};
