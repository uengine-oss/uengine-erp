// S18: one piece of agent work is several MCP calls under one saga id. Undoing it reverts what can go back
// and offsets what cannot, by commands the catalog names, and the subscribers follow from events.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { company } from './lib/harness.mjs'

let c, agent
const mcp = async (name, args, user = agent.id) => {
  const r = (await c.db.asUser(user, 'select public.erp_mcp($1) r', [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })])).rows[0].r
  assert.ok(r.result, JSON.stringify(r))
  const text = r.result.content[0].text
  return { isError: r.result.isError ?? false, text, json: r.result.isError ? null : JSON.parse(text) }
}
const newSaga = () => crypto.randomUUID()
const undo = async (saga, reason = '사용자가 취소', user = agent.id, cascade = false) => {
  const plan = await mcp('erp_read', { rollback: { correlation_id: saga } }, user)
  if (plan.isError) return { plan }
  const done = await mcp('erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.json.hash, allow_cascade: cascade }, reason }, user)
  return { plan, done }
}
const child = async (invId) => (await c.db.query(`select * from erp.records where type = 't_child' and state ->> 'origin_id' = $1`, [invId])).rows[0]

before(async () => {
  c = await company()
  await c.db.query(`
    select erp.catalog_put('{"type":"t_part","module":"t","label":"거래처","fields":[{"name":"name","label":"이름","type":"text","required":true}],
      "commands":{"create":{"roles":["sales"]},"update":{"roles":["sales"]}}}'::jsonb);
    select erp.catalog_put('{"type":"t_inv","module":"t","label":"전표","revert_blocked_states":["posted"],"revert_blocked_reason":"게시된 전표는 되돌릴 수 없습니다",
      "compensate":{"command":"void","label":"상쇄","warning":"공급자에게 알려야 합니다"},
      "fields":[{"name":"name","label":"이름","type":"text","required":true},{"name":"state","label":"상태","type":"text","readonly":true},{"name":"qty","label":"수량","type":"number"}],
      "states":[{"value":"draft","label":"초안"},{"value":"posted","label":"게시"},{"value":"void","label":"상쇄"}],
      "transitions":[{"command":"post","to":"posted","from":["draft"],"label":"게시","roles":["sales"]}],
      "commands":{"create":{"roles":["sales"]},"update":{"roles":["sales"]},"void":{"roles":["sales"]}}}'::jsonb);
    select erp.catalog_put('{"type":"t_stuck","module":"t","label":"못 되돌리는 문서","revert_blocked_states":["posted"],"revert_blocked_reason":"이 문서는 사람이 정리합니다",
      "fields":[{"name":"name","label":"이름","type":"text","required":true},{"name":"state","label":"상태","type":"text","readonly":true}],
      "states":[{"value":"draft","label":"초안"},{"value":"posted","label":"게시"}],
      "transitions":[{"command":"post","to":"posted","from":["draft"],"label":"게시","roles":["sales"]}],
      "commands":{"create":{"roles":["sales"]}}}'::jsonb);
    select erp.catalog_put('{"type":"t_child","module":"t2","label":"파생 문서","fields":[{"name":"name","label":"이름","type":"text"},{"name":"origin_id","label":"원본","type":"text"},{"name":"qty","label":"수량","type":"number"},{"name":"state","label":"상태","type":"text"}],"commands":{}}'::jsonb);
    create function erp.h_t_part(p_id uuid, p_command text, p_p jsonb) returns uuid language plpgsql as $f$
    declare new_id uuid := coalesce(p_id, gen_random_uuid());
    begin perform erp.emit('t_part', new_id, 'PartMade', jsonb_build_object('set', erp.validate('t_part', p_p, p_id is null))); return new_id; end $f$;
    create function erp.h_t_inv(p_id uuid, p_command text, p_p jsonb) returns uuid language plpgsql as $f$
    declare new_id uuid := coalesce(p_id, gen_random_uuid()); s jsonb;
    begin
      case p_command
        when 'create' then perform erp.emit('t_inv', new_id, 'InvMade', jsonb_build_object('set', erp.validate('t_inv', p_p, true) || '{"state":"draft"}'::jsonb));
        when 'update' then perform erp.emit('t_inv', p_id, 'InvEdited', jsonb_build_object('set', erp.validate('t_inv', p_p, false)));
        when 'post' then s := erp.require_state(p_id, 't_inv'); perform erp.emit('t_inv', p_id, 'InvPosted', jsonb_build_object('set', '{"state":"posted"}'::jsonb, 'qty', s -> 'qty', 'name', s -> 'name'));
        when 'void' then s := erp.require_state(p_id, 't_inv');
          if s ->> 'state' <> 'posted' then perform erp.fail('ERP_INVALID', '게시된 전표만 상쇄합니다'); end if;
          perform erp.emit('t_inv', p_id, 'InvVoided', jsonb_build_object('set', '{"state":"void"}'::jsonb));
      end case;
      return new_id;
    end $f$;
    create function erp.h_t_stuck(p_id uuid, p_command text, p_p jsonb) returns uuid language plpgsql as $f$
    declare new_id uuid := coalesce(p_id, gen_random_uuid());
    begin
      if p_command = 'create' then perform erp.emit('t_stuck', new_id, 'StuckMade', jsonb_build_object('set', erp.validate('t_stuck', p_p, true) || '{"state":"draft"}'::jsonb));
      else perform erp.emit('t_stuck', p_id, 'StuckPosted', '{"set":{"state":"posted"}}'); end if;
      return new_id;
    end $f$;
    create function erp.s_t2(ev erp.events) returns void language plpgsql as $f$
    declare cid uuid := erp.seed_id('t2:' || ev.stream_id);
    begin
      if ev.event_type = 'InvPosted' then
        perform erp.emit('t_child', cid, 'ChildMade', jsonb_build_object('set', jsonb_build_object('name', ev.data ->> 'name', 'origin_id', ev.stream_id::text, 'qty', ev.data -> 'qty', 'state', 'open')));
      else
        perform erp.emit('t_child', cid, 'ChildClosed', '{"set":{"state":"closed","qty":0}}');
      end if;
    end $f$;
    select erp.module_put('{"id":"t","label":"시험"}'::jsonb);
    select erp.module_put('{"id":"t2","label":"구독 시험","subscribes":[{"name":"t2.inv","handler":"erp.s_t2","events":["InvPosted","InvVoided"]}]}'::jsonb);`)
  await c.admin('module', null, 'enable', { id: 't' })
  await c.admin('module', null, 'enable', { id: 't2' })
  agent = await c.addMember('사가 에이전트', ['sales'])
})
after(async () => { await c.close() })

test('several MCP calls under one saga id are one thing, and status says when the subscribers are done', async () => {
  const saga = newSaga()
  const part = await mcp('erp_create', { type: 't_part', values: { name: '한빛부품' }, saga_id: saga })
  const inv = await mcp('erp_create', { type: 't_inv', values: { name: 'B-1', qty: 10 }, saga_id: saga })
  await mcp('erp_update', { type: 't_inv', id: inv.json.id, values: { state: 'posted' }, saga_id: saga })
  const corr = [...await c.events(part.json.id), ...await c.events(inv.json.id)].map((e) => e.correlation_id)
  assert.deepEqual([...new Set(corr)], [saga])
  const before_ = (await mcp('erp_read', { saga })).json
  assert.equal(before_.undone, null)
  assert.ok(before_.documents.some((d) => d.type === 't_inv' && d.status === 'posted'))
  await c.settle()
  const st = (await mcp('erp_read', { saga })).json
  assert.equal(st.pending, false)
  assert.ok(st.documents.some((d) => d.type === 't_child'), 'what the subscriber made belongs to the saga')
  assert.deepEqual(st.stuck, [])
})

test('nothing blocked: the saga reverts whole', async () => {
  const saga = newSaga()
  const part = await mcp('erp_create', { type: 't_part', values: { name: '지울 거래처' }, saga_id: saga })
  const inv = await mcp('erp_create', { type: 't_inv', values: { name: 'B-2', qty: 1 }, saga_id: saga })
  const { plan, done } = await undo(saga)
  assert.equal(plan.json.mode, 'rollback')
  assert.equal(done.isError, false, done.text)
  assert.equal(done.json.mode, 'rollback')
  assert.equal((await c.rec(part.json.id)).state.deleted, true)
  assert.equal((await c.rec(inv.json.id)).state.deleted, true)
  assert.equal((await c.events(inv.json.id)).at(-1).event_type, 'Reverted')
})

test('a posted document is offset by the catalog command, subscribers follow, and nothing is erased', async () => {
  const saga = newSaga()
  const part = await mcp('erp_create', { type: 't_part', values: { name: '남길 거래처' }, saga_id: saga })
  const inv = await mcp('erp_create', { type: 't_inv', values: { name: 'B-3', qty: 500 }, saga_id: saga })
  await mcp('erp_update', { type: 't_inv', id: inv.json.id, values: { state: 'posted' }, saga_id: saga })
  await c.settle()
  assert.equal((await child(inv.json.id)).state.state, 'open')

  const plan = (await mcp('erp_read', { rollback: { correlation_id: saga } })).json
  assert.equal(plan.mode, 'compensate')
  assert.deepEqual(plan.compensations.map((x) => [x.type, x.command, x.action]), [['t_inv', 'void', '상쇄']])
  assert.ok(plan.follow.some((x) => x.type === 't_child'), 'the preview names what will follow')
  assert.ok(plan.keep.some((x) => x.id === part.json.id), 'the preview names what stays')
  assert.ok(plan.warnings.some((w) => /공급자/.test(w.message)))
  assert.equal((await c.rec(inv.json.id)).status, 'posted', 'reading the plan changes nothing')

  const stale = await mcp('erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: 'old' }, reason: 'x' })
  assert.equal(stale.isError, true); assert.match(stale.text, /ERP_CONFLICT/)
  const noReason = await mcp('erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.hash } })
  assert.equal(noReason.isError, true); assert.match(noReason.text, /ERP_REQUIRED/)

  const done = await mcp('erp_create', { type: 'rollback', values: { correlation_id: saga, plan_hash: plan.hash }, reason: '사용자가 취소' })
  assert.equal(done.isError, false, done.text)
  assert.equal(done.json.mode, 'compensate')
  assert.equal((await c.rec(inv.json.id)).status, 'void')
  const ev = await c.events(inv.json.id)
  assert.deepEqual(ev.map((e) => e.event_type), ['InvMade', 'InvPosted', 'InvVoided'], 'the mistake and the correction are both there')
  assert.equal(ev.at(-1).source, 'compensation'); assert.equal(ev.at(-1).reason, '사용자가 취소'); assert.equal(ev.at(-1).actor_id, agent.id)
  assert.equal((await c.rec(part.json.id)).state.deleted, undefined, 'the partner stays')
  await c.settle()
  const k = await child(inv.json.id)
  assert.equal(k.state.state, 'closed'); assert.equal(Number(k.state.qty), 0)
  const st = (await mcp('erp_read', { saga })).json
  assert.equal(st.pending, false); assert.equal(st.undone.mode, 'compensate')

  const twice = await undo(saga)
  assert.equal(twice.plan.json.mode, 'done')
  assert.equal(twice.done.isError, true); assert.match(twice.done.text, /ERP_NOTHING/)
  const late = await mcp('erp_create', { type: 't_part', values: { name: '늦은 호출' }, saga_id: saga })
  assert.equal(late.isError, true); assert.match(late.text, /ERP_SAGA_CLOSED/)
})

test('a posted document with no compensation stops the whole saga with its reason', async () => {
  const saga = newSaga()
  const inv = await mcp('erp_create', { type: 't_inv', values: { name: 'B-4', qty: 1 }, saga_id: saga })
  await mcp('erp_update', { type: 't_inv', id: inv.json.id, values: { state: 'posted' }, saga_id: saga })
  const st = await mcp('erp_create', { type: 't_stuck', values: { name: 'S-1' }, saga_id: saga })
  await mcp('erp_update', { type: 't_stuck', id: st.json.id, values: { state: 'posted' }, saga_id: saga })
  await c.settle()
  const { plan, done } = await undo(saga)
  assert.equal(plan.json.mode, 'blocked')
  assert.equal(done.isError, true); assert.match(done.text, /ERP_ROLLBACK_BLOCKED: 이 문서는 사람이 정리합니다/)
  assert.equal((await c.rec(inv.json.id)).status, 'posted', 'all or nothing')
})

test('someone else built on it: the agent is refused, an admin must accept and then the same plan runs', async () => {
  const saga = newSaga()
  const inv = await mcp('erp_create', { type: 't_inv', values: { name: 'B-5', qty: 1 }, saga_id: saga })
  await mcp('erp_update', { type: 't_inv', id: inv.json.id, values: { state: 'posted' }, saga_id: saga })
  await c.settle()
  await c.admin('t_inv', inv.json.id, 'update', { qty: 2 })
  const refused = await mcp('erp_read', { rollback: { correlation_id: saga } })
  assert.equal(refused.isError, true); assert.match(refused.text, /ERP_FORBIDDEN/)
  const noCascade = await undo(saga, '정리', c.adminId)
  assert.equal(noCascade.done.isError, true); assert.match(noCascade.done.text, /ERP_ROLLBACK_CASCADE/)
  const ok = await undo(saga, '정리', c.adminId, true)
  assert.equal(ok.done.isError, false, ok.done.text)
  assert.equal((await c.rec(inv.json.id)).status, 'void')
})

test('another member cannot undo or see the plan of a saga that is not theirs; roles still apply to the command', async () => {
  const saga = newSaga()
  await mcp('erp_create', { type: 't_inv', values: { name: 'B-6' }, saga_id: saga })
  const other = await c.addMember('다른 에이전트 2', ['sales'])
  const { plan } = await undo(saga, '시도', other.id)
  assert.equal(plan.isError, true); assert.match(plan.text, /ERP_FORBIDDEN/)
  const bad = await mcp('erp_create', { type: 't_part', values: { name: 'x' }, saga_id: 'not-a-uuid' })
  assert.equal(bad.isError, true); assert.match(bad.text, /ERP_INVALID/)
})
