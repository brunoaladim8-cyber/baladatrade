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
    CREATE TABLE IF NOT EXISTS financial_ledger (
      id BIGSERIAL PRIMARY KEY,
      occurred_at TIMESTAMPTZ NOT NULL,
      type VARCHAR(20) NOT NULL CHECK (type IN ('expense','trade_pnl','fee','interest','transfer','income')),
      category VARCHAR(40) NOT NULL DEFAULT 'Outros',
      description VARCHAR(160) NOT NULL,
      amount_brl NUMERIC(18,2) NOT NULL DEFAULT 0,
      amount_usdt NUMERIC(24,8) NOT NULL DEFAULT 0,
      source VARCHAR(30) NOT NULL DEFAULT 'manual',
      external_id VARCHAR(120),
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(source,external_id)
    );
    CREATE INDEX IF NOT EXISTS financial_ledger_occurred_idx ON financial_ledger(occurred_at DESC);
    CREATE TABLE IF NOT EXISTS market_scans (
      id BIGSERIAL PRIMARY KEY,
      symbol VARCHAR(24) NOT NULL,
      price NUMERIC(30,12) NOT NULL,
      change_24h NUMERIC(12,6) NOT NULL,
      high_24h NUMERIC(30,12) NOT NULL,
      low_24h NUMERIC(30,12) NOT NULL,
      amplitude_pct NUMERIC(12,6) NOT NULL,
      range_position_pct NUMERIC(12,6) NOT NULL,
      risk_score SMALLINT NOT NULL,
      alignment VARCHAR(12) NOT NULL,
      spread_pct NUMERIC(12,8) NOT NULL,
      book_imbalance_pct NUMERIC(12,6) NOT NULL,
      payload JSONB NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS market_scans_symbol_time_idx ON market_scans(symbol,captured_at DESC);
    CREATE TABLE IF NOT EXISTS trade_plans (
      id BIGSERIAL PRIMARY KEY,
      symbol VARCHAR(24) NOT NULL,
      direction VARCHAR(5) NOT NULL CHECK(direction IN ('LONG','SHORT')),
      entry NUMERIC(30,12) NOT NULL,
      stop NUMERIC(30,12) NOT NULL,
      target NUMERIC(30,12) NOT NULL,
      capital_usdt NUMERIC(24,8) NOT NULL,
      risk_pct NUMERIC(8,4) NOT NULL,
      risk_usdt NUMERIC(24,8) NOT NULL,
      quantity NUMERIC(36,18) NOT NULL,
      leverage SMALLINT NOT NULL,
      risk_reward NUMERIC(12,6) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'PLANNED',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS trade_plans_symbol_time_idx ON trade_plans(symbol,created_at DESC);
    ALTER TABLE trade_plans ADD COLUMN IF NOT EXISTS outcome_price NUMERIC(30,12);
    ALTER TABLE trade_plans ADD COLUMN IF NOT EXISTS outcome_usdt NUMERIC(24,8);
    ALTER TABLE trade_plans ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS alert_events (
      id BIGSERIAL PRIMARY KEY,
      kind VARCHAR(32) NOT NULL,
      level VARCHAR(12) NOT NULL,
      symbol VARCHAR(24),
      title VARCHAR(160) NOT NULL,
      message TEXT NOT NULL,
      fingerprint VARCHAR(180) NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}',
      acknowledged_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(fingerprint)
    );
    CREATE INDEX IF NOT EXISTS alert_events_created_idx ON alert_events(created_at DESC);
    CREATE TABLE IF NOT EXISTS position_watches (
      id BIGSERIAL PRIMARY KEY,
      symbol VARCHAR(24) NOT NULL,
      direction VARCHAR(5) NOT NULL CHECK(direction IN ('LONG','SHORT')),
      entry NUMERIC(30,12) NOT NULL,
      quantity NUMERIC(36,18) NOT NULL,
      stop NUMERIC(30,12),
      target NUMERIC(30,12),
      trailing_pct NUMERIC(8,4),
      peak_price NUMERIC(30,12) NOT NULL,
      status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS position_watches_active_idx ON position_watches(status,updated_at DESC);
  `);return true;
}

async function saveMarketScan(scan){const db=database();if(!db)return null;const result=await db.query(`INSERT INTO market_scans(symbol,price,change_24h,high_24h,low_24h,amplitude_pct,range_position_pct,risk_score,alignment,spread_pct,book_imbalance_pct,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,captured_at`,[scan.symbol,scan.price,scan.change24h,scan.high,scan.low,scan.amplitude,scan.rangePosition,scan.risk.score,scan.alignment,scan.orderBook.spreadPct,scan.orderBook.imbalancePct,scan]);return result.rows[0]}
async function marketScanHistory(symbol,limit=50){const db=database();if(!db)throw new Error('Banco de dados não configurado.');return (await db.query(`SELECT id,symbol,price::float8,change_24h::float8,high_24h::float8,low_24h::float8,amplitude_pct::float8,range_position_pct::float8,risk_score,alignment,spread_pct::float8,book_imbalance_pct::float8,captured_at FROM market_scans WHERE symbol=$1 ORDER BY captured_at DESC LIMIT $2`,[symbol,Math.min(Math.max(limit,1),500)])).rows}
async function saveTradePlan(plan){const db=database();if(!db)throw new Error('Banco de dados não configurado.');return (await db.query(`INSERT INTO trade_plans(symbol,direction,entry,stop,target,capital_usdt,risk_pct,risk_usdt,quantity,leverage,risk_reward) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,created_at`,[plan.symbol,plan.direction,plan.entry,plan.stop,plan.target,plan.capital,plan.riskPct,plan.riskMoney,plan.quantity,plan.leverage,plan.riskReward])).rows[0]}
async function tradePlanHistory(symbol,limit=50){const db=database();if(!db)throw new Error('Banco de dados não configurado.');return (await db.query(`SELECT id,symbol,direction,entry::float8,stop::float8,target::float8,capital_usdt::float8,risk_pct::float8,risk_usdt::float8,quantity::float8,leverage,risk_reward::float8,status,outcome_price::float8,outcome_usdt::float8,closed_at,created_at FROM trade_plans WHERE ($1='' OR symbol=$1) ORDER BY created_at DESC LIMIT $2`,[symbol,Math.min(Math.max(limit,1),500)])).rows}
async function closeTradePlan(id,status,price,pnl,closedAt){const db=database();if(!db)return;await db.query('UPDATE trade_plans SET status=$2,outcome_price=$3,outcome_usdt=$4,closed_at=$5 WHERE id=$1 AND status=\'PLANNED\'',[id,status,price,pnl,closedAt])}
async function saveAlerts(alerts){const db=database();if(!db)return {saved:0};let saved=0;for(const item of alerts){const result=await db.query(`INSERT INTO alert_events(kind,level,symbol,title,message,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(fingerprint) DO NOTHING`,[item.kind,item.level,item.symbol||null,item.title,item.message,item.fingerprint,item.payload||{}]);saved+=result.rowCount}return {saved}}
async function alertHistory(limit=100){const db=database();if(!db)throw new Error('Banco de dados não configurado.');return (await db.query('SELECT id,kind,level,symbol,title,message,payload,acknowledged_at,created_at FROM alert_events ORDER BY created_at DESC LIMIT $1',[Math.min(Math.max(limit,1),500)])).rows}
async function savePositionWatch(watch){const db=database();if(!db)throw new Error('Banco de dados não configurado.');return (await db.query(`INSERT INTO position_watches(symbol,direction,entry,quantity,stop,target,trailing_pct,peak_price) VALUES($1,$2,$3,$4,$5,$6,$7,$3) RETURNING id,created_at`,[watch.symbol,watch.direction,watch.entry,watch.quantity,watch.stop||null,watch.target||null,watch.trailingPct||null])).rows[0]}
async function positionWatches(){const db=database();if(!db)throw new Error('Banco de dados não configurado.');return (await db.query(`SELECT id,symbol,direction,entry::float8,quantity::float8,stop::float8,target::float8,trailing_pct::float8,peak_price::float8,status,created_at,updated_at FROM position_watches WHERE status='ACTIVE' ORDER BY created_at DESC`)).rows}
async function updatePositionWatch(id,peakPrice,status='ACTIVE'){const db=database();if(!db)return;await db.query('UPDATE position_watches SET peak_price=$2,status=$3,updated_at=NOW() WHERE id=$1',[id,peakPrice,status])}

async function ledgerData(limit=200){
  const db=database();if(!db)throw new Error('Banco de dados não configurado.');
  const entries=(await db.query(`SELECT id,occurred_at,type,category,description,amount_brl::float8,amount_usdt::float8,source,notes
    FROM financial_ledger ORDER BY occurred_at DESC LIMIT $1`,[Math.min(Math.max(limit,1),1000)])).rows;
  const summary=(await db.query(`SELECT
    COALESCE(SUM(amount_brl) FILTER (WHERE type='expense'),0)::float8 AS expenses_brl,
    COALESCE(SUM(amount_usdt) FILTER (WHERE type='expense'),0)::float8 AS expenses_usdt,
    COALESCE(SUM(amount_usdt) FILTER (WHERE type='trade_pnl'),0)::float8 AS trade_pnl_usdt,
    COALESCE(SUM(amount_usdt) FILTER (WHERE type IN ('fee','interest')),0)::float8 AS costs_usdt,
    COALESCE(SUM(amount_brl) FILTER (WHERE type='income'),0)::float8 AS income_brl
    FROM financial_ledger WHERE occurred_at>=date_trunc('month',NOW())`)).rows[0];
  return {entries,summary};
}

async function addLedgerEntry(entry){
  const db=database();if(!db)throw new Error('Banco de dados não configurado.');
  const result=await db.query(`INSERT INTO financial_ledger(occurred_at,type,category,description,amount_brl,amount_usdt,source,external_id,notes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,occurred_at`,[entry.occurredAt,entry.type,entry.category,entry.description,entry.amountBrl,entry.amountUsdt,entry.source||'manual',entry.externalId||null,entry.notes||'']);
  return result.rows[0];
}

async function deleteLedgerEntry(id){
  const db=database();if(!db)throw new Error('Banco de dados não configurado.');
  await db.query("DELETE FROM financial_ledger WHERE id=$1 AND source='manual'",[id]);
}

async function importLedgerEntries(entries){
  const db=database();if(!db)throw new Error('Banco de dados não configurado.');
  let imported=0,duplicates=0;
  for(const entry of entries){const result=await db.query(`INSERT INTO financial_ledger(occurred_at,type,category,description,amount_brl,amount_usdt,source,external_id,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(source,external_id) DO NOTHING RETURNING id`,[entry.occurredAt,entry.type,entry.category,entry.description,entry.amountBrl||0,entry.amountUsdt||0,entry.source,entry.externalId,entry.notes||'']);result.rowCount?imported++:duplicates++}
  return {imported,duplicates,total:entries.length};
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

module.exports={initDatabase,saveSnapshot,history,portfolioBaseline,paperData,paperOrder,ledgerData,addLedgerEntry,deleteLedgerEntry,importLedgerEntries,saveMarketScan,marketScanHistory,saveTradePlan,tradePlanHistory,closeTradePlan,saveAlerts,alertHistory,savePositionWatch,positionWatches,updatePositionWatch};
