const mysql = require('mysql2/promise');

function cloneParams(params) {
  return Array.isArray(params) ? [...params] : [];
}

function pgToMysql(sql, params) {
  let text = String(sql || '');
  const originalValues = cloneParams(params);

  // Mark PostgreSQL array comparisons first. The markers are converted to
  // mysql2 placeholders only after all SQL rewrites, preserving parameter
  // order even when an array appears between normal $n parameters.
  text = text.replace(/([\w.]+)\s*=\s*ANY\s*\(\s*\$(\d+)\s*::(?:int|integer|bigint)\[\]\s*\)/gi,
    (_, lhs, n) => `__PG_ARRAY_${n}__` .replace(/__PG_ARRAY_(\d+)__/, `${lhs} IN (__PG_ARRAY_$1__)`));

  // PostgreSQL casts. MySQL receives values already typed by Node/mysql2.
  text = text.replace(/::(?:double\s+precision|timestamptz|timestamp|jsonb|json|integer|bigint|numeric|boolean|text|int)(?![A-Za-z0-9_])/gi, '');
  text = text.replace(/\bILIKE\b/gi, 'LIKE');
  text = text.replace(/('(?:[^']|'')*')\s*\|\|\s*\$(\d+)\s*\|\|\s*('(?:[^']|'')*')/g, (_, a, n, b) => `CONCAT(${a}, __PG_PARAM_${n}__, ${b})`);
  text = text.replace(/([^\s,]+)\s+IS\s+DISTINCT\s+FROM\s+(\([^\n]+\)|[^\s,]+)/gi, 'NOT ($1 <=> $2)');
  text = text.replace(/INTERVAL\s+'(\d+)\s+(minutes?|hours?|days?|weeks?|months?|years?)'/gi,
    (_, n, unit) => `INTERVAL ${n} ${unit.toUpperCase().replace(/S$/, '')}`);

  text = replaceFilteredAggregates(text);

  text = text.replace(/([A-Za-z_][A-Za-z0-9_.]*)\s+(ASC|DESC)\s+NULLS\s+LAST/gi,
    (_, expr, direction) => `${expr} IS NULL, ${expr} ${direction}`);

  text = text.replace(/TO_CHAR\(\s*DATE_TRUNC\(\s*'month'\s*,\s*([^()]+)\)\s*,\s*'Mon YYYY'\s*\)/gi,
    (_, expr) => `DATE_FORMAT(${expr}, '%b %Y')`);
  text = text.replace(/DATE_TRUNC\(\s*'month'\s*,\s*([^()]+)\)/gi,
    (_, expr) => `DATE_FORMAT(${expr}, '%Y-%m-01')`);

  text = text.replace(/ON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+NOTHING/gi,
    (_, keys) => `ON DUPLICATE KEY UPDATE ${keys.split(',')[0].trim()} = ${keys.split(',')[0].trim()}`);
  text = text.replace(/ON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+UPDATE\s+SET/gi,
    'ON DUPLICATE KEY UPDATE');
  text = text.replace(/\bEXCLUDED\.([A-Za-z_][A-Za-z0-9_]*)/gi, (_, col) => `VALUES(\`${col}\`)`);

  text = text.replace(/\$(\d+)/g, (_, n) => `__PG_PARAM_${n}__`);

  const bound = [];
  text = text.replace(/__PG_ARRAY_(\d+)__|__PG_PARAM_(\d+)__/g, (_, arrayN, paramN) => {
    if (arrayN) {
      const arr = Array.isArray(originalValues[Number(arrayN) - 1]) ? originalValues[Number(arrayN) - 1] : [];
      if (!arr.length) return 'NULL';
      bound.push(...arr);
      return arr.map(() => '?').join(', ');
    }
    bound.push(originalValues[Number(paramN) - 1]);
    return '?';
  });

  return { sql: text, params: bound };
}

function replaceFilteredAggregates(input) {
  let out = String(input);
  let searchFrom = 0;
  while (true) {
    const marker = /\b(COUNT|SUM|AVG)\s*\(/gi;
    marker.lastIndex = searchFrom;
    const m = marker.exec(out);
    if (!m) break;
    const fn = m[1].toUpperCase();
    const open = out.indexOf('(', m.index);
    let depth = 0, close = -1;
    for (let i = open; i < out.length; i++) {
      if (out[i] === '(') depth++;
      else if (out[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close < 0) break;
    const after = out.slice(close + 1);
    const fm = after.match(/^\s+FILTER\s*\(\s*WHERE\s+/i);
    if (!fm) { searchFrom = close + 1; continue; }
    const condStart = close + 1 + fm[0].length;
    let cdepth = 1, condEnd = -1;
    // FILTER opens one parenthesis; start scanning from the first character
    // inside that parenthesis.
    for (let i = condStart; i < out.length; i++) {
      if (out[i] === '(') cdepth++;
      else if (out[i] === ')') { cdepth--; if (cdepth === 0) { condEnd = i; break; } }
    }
    if (condEnd < 0) break;
    const expr = out.slice(open + 1, close).trim();
    const condition = out.slice(condStart, condEnd).trim();
    const replacement = fn === 'COUNT'
      ? `SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END)`
      : `${fn}(CASE WHEN ${condition} THEN ${expr} ELSE NULL END)`;
    out = out.slice(0, m.index) + replacement + out.slice(condEnd + 1);
    searchFrom = m.index + replacement.length;
  }
  return out;
}
function extractReturning(sql) {
  const m = String(sql).match(/\s+RETURNING\s+([\s\S]+?)\s*;?\s*$/i);
  if (!m) return null;
  return { baseSql: String(sql).slice(0, m.index).trim(), columns: m[1].trim() };
}

function parseInsertIdentity(sql, params) {
  const m = String(sql).match(/INSERT\s+INTO\s+([`\w]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
  if (!m) return null;
  const table = m[1].replace(/`/g, '');
  const columns = m[2].split(',').map(s => s.trim().replace(/`/g, ''));
  const placeholders = m[3].split(',').map(s => s.trim());
  const values = {};
  let p = 0;
  for (const ph of placeholders) {
    const mm = ph.match(/\?/);
    if (mm) values[columns[p]] = params[p];
    p += 1;
  }
  const conflict = String(sql).match(/ON\s+DUPLICATE\s+KEY\s+UPDATE/i) ? true : false;
  return { table, values, conflict };
}

function parseWhereId(sql) {
  const m = String(sql).match(/\bWHERE\s+[`\w.]+\.?(id)\s*=\s*\?/i);
  if (!m) return null;
  const params = [];
  return true;
}

async function rowsForReturning(rawQuery, originalSql, translatedSql, translatedParams, result, columns) {
  const upper = originalSql.toUpperCase();
  const returningColumns = columns === '*' ? '*' : columns;

  // INSERT: prefer AUTO_INCREMENT id. For upserts, fall back to the conflict key.
  if (/^\s*INSERT\b/i.test(originalSql)) {
    const info = parseInsertIdentity(translatedSql, translatedParams);
    if (!info) return [];
    let where = null;
    let whereValue = null;
    if (result.insertId) {
      where = 'id = ?'; whereValue = result.insertId;
    } else {
      const cm = originalSql.match(/ON\s+CONFLICT\s*\(([^)]+)\)/i);
      const key = cm?.[1]?.split(',')[0]?.trim();
      if (key && Object.prototype.hasOwnProperty.call(info.values, key)) {
        where = `\`${key}\` = ?`; whereValue = info.values[key];
      }
    }
    if (!where) return [];
    const [rows] = await rawQuery(`SELECT ${returningColumns} FROM \`${info.table}\` WHERE ${where} LIMIT 1`, [whereValue]);
    return rows;
  }

  // UPDATE: use id from the translated parameter list where possible.
  if (/^\s*UPDATE\b/i.test(originalSql)) {
    const m = originalSql.match(/\bWHERE\s+(?:[\w.]+\.)?id\s*=\s*\$(\d+)/i);
    if (m) {
      const id = paramsValueFromOriginal(originalSql, m[1], translatedParams);
      const table = originalSql.match(/^\s*UPDATE\s+[`\w]+/i)?.[0]?.replace(/^\s*UPDATE\s+/i, '').trim();
      if (table && id !== undefined) {
        const [rows] = await rawQuery(`SELECT ${returningColumns} FROM \`${table.replace(/`/g, '')}\` WHERE id = ? LIMIT 1`, [id]);
        return rows;
      }
    }
  }

  // DELETE RETURNING: select matching rows before the delete is executed in query().
  return [];
}

function paramsValueFromOriginal(originalSql, n, translatedParams) {
  // The adapter orders values according to $n appearance. For the common id=$n
  // case, locate the original placeholder's ordinal among all placeholders.
  const target = Number(n);
  const matches = [...String(originalSql).matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
  const index = matches.indexOf(target);
  return index >= 0 ? translatedParams[index] : undefined;
}

function createPoolFromEnv() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD ?? 'root',
    database: process.env.DB_NAME || 'gmfdmmzn_proflow',
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_MAX || 10),
    queueLimit: 0,
    connectTimeout: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000),
    dateStrings: false,
    // Keep pooled connections alive over the public internet link to Aiven —
    // without this, an idle connection can be silently dropped by a NAT/
    // firewall in between, and the next query on it (or a fresh connect())
    // times out instead of failing fast/reconnecting cleanly.
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
  });

  pool.on('error', (err) => {
    console.error('[MySQL pool error]', err.code || err.message);
  });

  const originalQuery = pool.query.bind(pool);
  pool.query = async (sql, params = []) => {
    const original = String(sql || '');
    const ret = extractReturning(original);
    const workSql = ret ? ret.baseSql : original;
    const { sql: translated, params: translatedParams } = pgToMysql(workSql, params);

    // Handle DELETE ... RETURNING by reading the rows first, then deleting.
    if (ret && /^\s*DELETE\b/i.test(original)) {
      const selectSql = translated.replace(/^\s*DELETE\s+FROM\s+([^\s]+)\s+/i, 'SELECT ' + ret.columns + ' FROM $1 ');
      const table = translated.match(/^\s*DELETE\s+FROM\s+([^\s]+)/i)?.[1];
      const wherePart = translated.replace(/^\s*DELETE\s+FROM\s+[^\s]+\s*/i, '');
      const [beforeRows] = await originalQuery(`SELECT ${ret.columns} FROM ${table} ${wherePart}`, translatedParams);
      const [deleteResult] = await originalQuery(translated, translatedParams);
      return { rows: beforeRows, rowCount: deleteResult.affectedRows || beforeRows.length, affectedRows: deleteResult.affectedRows || 0, insertId: deleteResult.insertId || 0 };
    }

    const [result] = await originalQuery(translated, translatedParams);
    if (ret) {
      const rows = await rowsForReturning(originalQuery, original, translated, translatedParams, result, ret.columns);
      return { rows, rowCount: rows.length, affectedRows: result.affectedRows || rows.length, insertId: result.insertId || 0 };
    }
    if (Array.isArray(result)) return { rows: result, rowCount: result.length };
    return { rows: [], rowCount: result.affectedRows || 0, affectedRows: result.affectedRows || 0, insertId: result.insertId || 0 };
  };

  const originalGetConnection = pool.getConnection.bind(pool);
  pool.connect = async () => {
    const conn = await originalGetConnection();
    const originalConnQuery = conn.query.bind(conn);
    conn.query = async (sql, params = []) => {
      const original = String(sql || '');
      const ret = extractReturning(original);
      const workSql = ret ? ret.baseSql : original;
      const { sql: translated, params: translatedParams } = pgToMysql(workSql, params);

      if (ret && /^\s*DELETE\b/i.test(original)) {
        const table = translated.match(/^\s*DELETE\s+FROM\s+([^\s]+)/i)?.[1];
        const wherePart = translated.replace(/^\s*DELETE\s+FROM\s+[^\s]+\s*/i, '');
        const [beforeRows] = await originalConnQuery(`SELECT ${ret.columns} FROM ${table} ${wherePart}`, translatedParams);
        const [deleteResult] = await originalConnQuery(translated, translatedParams);
        return { rows: beforeRows, rowCount: deleteResult.affectedRows || beforeRows.length, affectedRows: deleteResult.affectedRows || 0 };
      }

      const [result] = await originalConnQuery(translated, translatedParams);
      if (ret) {
        const rows = await rowsForReturning(originalConnQuery, original, translated, translatedParams, result, ret.columns);
        return { rows, rowCount: rows.length, affectedRows: result.affectedRows || rows.length, insertId: result.insertId || 0 };
      }
      if (Array.isArray(result)) return { rows: result, rowCount: result.length };
      return { rows: [], rowCount: result.affectedRows || 0, affectedRows: result.affectedRows || 0, insertId: result.insertId || 0 };
    };
    conn.release = conn.release.bind(conn);
    return conn;
  };

  pool.on('connection', () => console.log('MySQL connection established'));
  return pool;
}

module.exports = { createPoolFromEnv, pgToMysql };