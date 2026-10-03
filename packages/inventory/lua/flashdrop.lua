#!lua name=flashdrop
-- version 2. Bump it with every change: a loader never replaces a newer version, nor this version with
-- other code (src/library.ts), so processes of two releases can share one Redis during a rolling deploy. A
-- new version must keep answering what the previous one's callers parse.
--[[
  FlashDrop admission and settlement (design §4.2). Loaded with FUNCTION LOAD REPLACE by every process at
  startup and again on "ERR Function not found"; the AOF persists it.

  Keys of one drop share the hash tag {d:<dropId>} (§4.1), so every call touches one slot:
    inv  HASH  status startsAt endsAt holdMs limit retainAt productId gen seq total avail held sold
               reconcilingSince. One hash, so one HMGET is an atomic snapshot.
    rsv  HASH  <rid> -> JSON {u, q, s, fp, k}: the Redis-side idempotency record, s in HELD|COMMITTED|RELEASED
    uq   HASH  <userId> -> units HELD + COMMITTED (the per-user limit gate)
    exp  ZSET  <rid> scored hold expiry + GRACE_MS; HELD entries only; picks safety-net candidates only

  Redis does not roll back a Function that errors after a write. So every Function validates everything it
  will read or write first, and then either errors before its first write or does not error at all:
  arguments, inv fields, rsv entries, the uq field a write updates, the type of every key a write touches
  and the whole rebuild snapshot are checked up front, and publish() tolerates missing fields. Write
  functions are registered without allow-oom: under memory pressure Redis refuses them before they run,
  never halfway.

  Ordering rule (§4.3): Redis takes stock before Postgres records an order, and gives stock back only after
  Postgres committed the outcome, so Redis is never more optimistic than Postgres. Nothing here frees stock
  on Redis's own clock.
]]

local GRACE_MS = 30000
local MAX_INT = 9007199254740991 -- 2^53 - 1: beyond it a Lua number no longer holds an exact integer
local STATUSES = { SCHEDULED = true, LIVE = true, PAUSED = true, ENDED = true, RECONCILING = true }
local STATES = { HELD = true, COMMITTED = true, RELEASED = true }

local function fail(message) error({ err = 'ERR flashdrop: ' .. message }) end
local function str(x) return type(x) == 'string' end
local function int(x) return type(x) == 'number' and x == math.floor(x) and x >= -MAX_INT and x <= MAX_INT end

-- A stored integer as Redis's own parser reads it (string2ll, behind HINCRBY and INCR): '0', or an optional
-- '-', a digit 1-9 and more digits, nothing else. tonumber() also takes '1.0', ' 1', '1e0' and '0x1', which
-- HINCRBY then refuses after earlier writes of the same call landed (§4.2). At most 16 digits and within
-- MAX_INT, so the Lua number holds it exactly. nil for anything else, a missing field (false) included.
local function parse_int(s)
  if type(s) ~= 'string' or #s > 17 or (s ~= '0' and not s:match('^%-?[1-9]%d*$')) then return nil end
  local n = tonumber(s)
  if not int(n) then return nil end
  return n
end
local function now_ms() local t = redis.call('TIME'); return t[1] * 1000 + math.floor(t[2] / 1000) end

-- 'NO_DROP' (not in Redis), 'RETRY' (a rebuild is running) or the drop status
local function gate(inv)
  local m = redis.call('HMGET', inv, 'status', 'gen')
  if not m[1] or not m[2] then return 'NO_DROP' end
  if m[1] == 'RECONCILING' then return 'RETRY' end
  return m[1]
end

-- The named inv fields as integers. A missing or non-integer field means a hash this library never writes,
-- so the caller is refused before its first write instead of failing halfway through its writes.
local function ints(inv, ...)
  local names = { ... }
  local raw = redis.call('HMGET', inv, unpack(names))
  local out = {}
  for i = 1, #names do
    local n = parse_int(raw[i])
    if n == nil then fail('inv field ' .. names[i] .. ' missing or not an integer in ' .. inv) end
    out[i] = n
  end
  return out
end

-- Refuses a key of another type than `kind` (a missing key is fine). Called before the first write: a
-- wrong-typed key would otherwise fail a later write with WRONGTYPE after earlier ones landed.
local function want(key, kind)
  local t = redis.call('TYPE', key).ok
  if t ~= kind and t ~= 'none' then fail(key .. ' is a ' .. t .. ', not a ' .. kind) end
end

-- A uq field (units HELD + COMMITTED) as an integer, absent counting as 0
local function units(uq, uid)
  local n = parse_int(redis.call('HGET', uq, uid) or '0')
  if n == nil then fail('uq field of ' .. uid .. ' not an integer') end
  return n
end

-- A decoded rsv entry, validated before any write that depends on it
local function entry(raw)
  local ok, r = pcall(cjson.decode, raw)
  if not ok or type(r) ~= 'table' or not str(r.u) or not int(r.q) or not STATES[r.s] or not str(r.fp) then
    fail('malformed rsv entry')
  end
  return r
end

-- Level message gen:seq:avail:held:sold:status:ts, published inside the mutation, so in mutation order.
-- ts is the Redis time of the mutation, for the propagation metric (§7).
local function publish(inv, dropId)
  local v = redis.call('HMGET', inv, 'gen', 'seq', 'avail', 'held', 'sold', 'status')
  for i = 1, 6 do v[i] = v[i] or '' end -- HMGET gives false for a missing field
  v[7] = now_ms()
  redis.call('PUBLISH', 'fd:ch:stock:{d:' .. dropId .. '}', table.concat(v, ':'))
end

-- KEYS: inv rsv uq exp    ARGV: dropId rid userId qty fp idemKey
local function fd_reserve(keys, args)
  local inv, rsv, uq, exp = keys[1], keys[2], keys[3], keys[4]
  local dropId, rid, uid, qty, fp = args[1], args[2], args[3], parse_int(args[4]), args[5]
  if not qty or qty < 1 or qty > 10 then return { 'BAD_QTY' } end -- before any read
  local status = gate(inv)
  if status == 'NO_DROP' or status == 'RETRY' then return { status } end
  local prev = redis.call('HGET', rsv, rid) -- idempotent replay, atomic with creation
  if prev then
    local r = entry(prev)
    if r.fp ~= fp then return { 'FP_MISMATCH' } end
    return { 'EXISTING', r.s, redis.call('HGET', inv, 'gen') }
  end
  local m = ints(inv, 'startsAt', 'endsAt', 'limit', 'avail', 'gen', 'holdMs', 'retainAt', 'held', 'seq')
  local now = now_ms()
  -- Open = SCHEDULED or LIVE and inside [startsAt, endsAt). The scheduler's flip to LIVE matters only to
  -- Postgres and the UI, so an armed drop opens to the millisecond.
  if (status ~= 'LIVE' and status ~= 'SCHEDULED') or now < m[1] or now >= m[2] then return { 'NOT_LIVE' } end
  if units(uq, uid) + qty > m[3] then return { 'LIMIT' } end
  if m[4] < qty then return { 'SOLD_OUT' } end -- losers stop here: read-only, O(1)
  want(exp, 'zset') -- rsv and uq were read above, where a wrong type already failed
  -- every check passed: first write
  redis.call('HINCRBY', inv, 'avail', -qty)
  redis.call('HINCRBY', inv, 'held', qty)
  redis.call('HINCRBY', inv, 'seq', 1)
  redis.call('HINCRBY', uq, uid, qty)
  redis.call('HSET', rsv, rid, cjson.encode({ u = uid, q = qty, s = 'HELD', fp = fp, k = args[6] }))
  redis.call('ZADD', exp, now + m[6] + GRACE_MS, rid)
  for _, k in ipairs({ rsv, uq, exp }) do redis.call('PEXPIREAT', k, m[7]) end
  publish(inv, dropId)
  return { 'RESERVED', m[5] } -- gen, checked again by the Postgres transaction (the fence, §4.7)
end

-- KEYS: inv rsv exp    ARGV: dropId rid      HELD -> COMMITTED; the stock already left avail at reserve time
local function fd_confirm(keys, args)
  local inv, rsv, exp, rid = keys[1], keys[2], keys[3], args[2]
  local g = gate(inv)
  if g == 'NO_DROP' or g == 'RETRY' then return g end
  local raw = redis.call('HGET', rsv, rid)
  if not raw then return 'MISSING' end -- not in this generation: the rebuild already counted it
  local r = entry(raw)
  if r.s == 'COMMITTED' then return 'NOOP' end
  if r.s == 'RELEASED' then return 'CONFLICT' end -- INV-8 breach: DLQ + alert
  ints(inv, 'held', 'sold', 'seq')
  want(exp, 'zset')
  r.s = 'COMMITTED'
  redis.call('HSET', rsv, rid, cjson.encode(r))
  redis.call('HINCRBY', inv, 'held', -r.q)
  redis.call('HINCRBY', inv, 'sold', r.q)
  redis.call('HINCRBY', inv, 'seq', 1)
  redis.call('ZREM', exp, rid)
  publish(inv, args[1])
  return 'OK'
end

-- KEYS: inv rsv uq exp    ARGV: dropId rid      HELD -> RELEASED: stock and quota come back, exactly once
local function fd_release(keys, args)
  local inv, rsv, uq, exp, rid = keys[1], keys[2], keys[3], keys[4], args[2]
  local g = gate(inv)
  if g == 'NO_DROP' or g == 'RETRY' then return g end
  local raw = redis.call('HGET', rsv, rid)
  if not raw then return 'MISSING' end
  local r = entry(raw)
  if r.s == 'RELEASED' then return 'NOOP' end
  if r.s == 'COMMITTED' then return 'CONFLICT' end
  ints(inv, 'avail', 'held', 'seq')
  units(uq, r.u) -- also fails a wrong-typed uq, before the first write
  want(exp, 'zset')
  r.s = 'RELEASED' -- kept as an idempotency tombstone
  redis.call('HSET', rsv, rid, cjson.encode(r))
  redis.call('HINCRBY', inv, 'held', -r.q)
  redis.call('HINCRBY', inv, 'avail', r.q)
  if redis.call('HINCRBY', uq, r.u, -r.q) <= 0 then redis.call('HDEL', uq, r.u) end
  redis.call('HINCRBY', inv, 'seq', 1)
  redis.call('ZREM', exp, rid)
  publish(inv, args[1])
  return 'OK'
end

-- cjson.null is userdata, so a null field fails these checks
local function count(x) return int(x) and x >= 0 end
local function valid_snapshot(s)
  if type(s) ~= 'table' or type(s.meta) ~= 'table' or type(s.entries) ~= 'table' or type(s.quotas) ~= 'table' then
    return false
  end
  if not (count(s.gen) and count(s.total) and count(s.reserved) and count(s.sold)) then return false end
  local m = s.meta
  if not STATUSES[m.status] or m.status == 'RECONCILING' or not str(m.productId) then return false end
  for _, k in ipairs({ 'startsAt', 'endsAt', 'holdMs', 'limit', 'retainAt' }) do
    if not count(m[k]) then return false end
  end
  for _, e in ipairs(s.entries) do
    if type(e) ~= 'table' or not (str(e.rid) and str(e.u) and int(e.q) and e.q >= 1 and e.q <= 10
        and str(e.fp) and str(e.k) and count(e.expAt) and STATES[e.s]) then
      return false
    end
  end
  for uid, n in pairs(s.quotas) do
    if not (str(uid) and count(n)) then return false end
  end
  return s.total - s.sold - s.reserved >= 0
end

-- KEYS: inv rsv uq exp    ARGV: dropId snapshotJson      Atomic replace from a Postgres snapshot (§4.7)
local function fd_rebuild(keys, args)
  local inv, rsv, uq, exp = keys[1], keys[2], keys[3], keys[4]
  local ok, s = pcall(cjson.decode, args[2])
  if not ok or not valid_snapshot(s) then return 'BAD_SNAPSHOT' end -- every check runs before the first write
  -- fd_set_status RECONCILING, which every sync runs first, repairs a malformed gen
  local current = parse_int(redis.call('HGET', inv, 'gen') or '-1')
  if current == nil then fail('inv field gen not an integer in ' .. inv) end
  -- Never regress gen: a sync whose lock session died while its process kept running (a zombie) must not
  -- overwrite the rebuild of the sync that took the lock after it.
  if s.gen <= current then return 'STALE' end
  redis.call('DEL', rsv, uq, exp)
  for _, e in ipairs(s.entries) do -- every order of the drop, terminal ones included
    redis.call('HSET', rsv, e.rid, cjson.encode({ u = e.u, q = e.q, s = e.s, fp = e.fp, k = e.k }))
    if e.s == 'HELD' then redis.call('ZADD', exp, e.expAt + GRACE_MS, e.rid) end
  end
  for uid, n in pairs(s.quotas) do
    if n > 0 then redis.call('HSET', uq, uid, n) end
  end
  local m = s.meta
  redis.call('HSET', inv, 'total', s.total, 'avail', s.total - s.sold - s.reserved, 'held', s.reserved,
    'sold', s.sold, 'gen', s.gen, 'seq', 0, 'status', m.status, 'startsAt', m.startsAt, 'endsAt', m.endsAt,
    'holdMs', m.holdMs, 'limit', m.limit, 'retainAt', m.retainAt, 'productId', m.productId)
  redis.call('HDEL', inv, 'reconcilingSince') -- the only way out of RECONCILING
  for _, k in ipairs({ inv, rsv, uq, exp }) do redis.call('PEXPIREAT', k, m.retainAt) end
  publish(inv, args[1])
  return 'OK'
end

-- KEYS: inv    ARGV: dropId status
local function fd_set_status(keys, args)
  local inv, target = keys[1], args[2]
  if not STATUSES[target] then return 'BAD_STATUS' end
  local m = redis.call('HMGET', inv, 'status', 'gen', 'seq', 'reconcilingSince')
  local seq_ok = not m[3] or parse_int(m[3]) ~= nil -- the HINCRBY below must not fail after a write
  if target == 'RECONCILING' then
    if not m[2] then -- first arm, or keys lost: a complete, fail-closed hash that admits nobody
      redis.call('HSET', inv, 'gen', -1, 'seq', 0, 'total', 0, 'avail', 0, 'held', 0, 'sold', 0)
    else
      -- This path must succeed on any hash, because the rebuild it starts is what repairs the hash. A
      -- malformed seq would fail the HINCRBY below after the status landed, and a malformed gen would fail
      -- every fd_rebuild, leaving the drop RECONCILING for good. The rebuild rewrites both anyway; gen -1
      -- lets any snapshot generation through, as on a first arm.
      if parse_int(m[2]) == nil then redis.call('HSET', inv, 'gen', -1) end
      if not seq_ok then redis.call('HSET', inv, 'seq', 0) end
    end
    -- reconcilingSince marks when the drop stopped admitting. A sync retried after a failed one keeps it,
    -- so the "RECONCILING for more than 30 s" alert (§12) measures the outage, not the latest attempt.
    local since = m[4]
    if m[1] ~= 'RECONCILING' or parse_int(since) == nil then since = now_ms() end
    redis.call('HSET', inv, 'status', 'RECONCILING', 'reconcilingSince', since)
  else
    if not m[1] or not m[2] then return 'NO_DROP' end -- never create a partial hash
    if m[1] == 'RECONCILING' then return 'RETRY' end -- only fd_rebuild clears RECONCILING
    if m[1] == target then return 'NOOP' end
    if not seq_ok then fail('inv field seq not an integer in ' .. inv) end -- a rebuild repairs it
    redis.call('HSET', inv, 'status', target)
  end
  redis.call('HINCRBY', inv, 'seq', 1)
  publish(inv, args[1])
  return 'OK'
end

-- KEYS: counter    ARGV: windowMs      Fixed-window counter behind the custom @fastify/rate-limit store (§11)
local function fd_rl_hit(keys, args)
  local window = parse_int(args[1])
  if not window or window < 1 then fail('rate-limit window must be a positive integer') end
  local n = redis.call('INCR', keys[1])
  local ttl = redis.call('PTTL', keys[1])
  -- The first hit starts the window. A counter that somehow lost its TTL would block its key forever, so
  -- any counter without one gets it back.
  if ttl < 0 then
    redis.call('PEXPIRE', keys[1], window)
    ttl = window
  end
  return { n, ttl }
end

redis.register_function('fd_reserve', fd_reserve)
redis.register_function('fd_confirm', fd_confirm)
redis.register_function('fd_release', fd_release)
redis.register_function('fd_rebuild', fd_rebuild)
redis.register_function('fd_set_status', fd_set_status)
redis.register_function('fd_rl_hit', fd_rl_hit)
