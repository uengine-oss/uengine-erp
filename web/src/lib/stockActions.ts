// Asking for the stock changes several screens offer. The quantity rules live in the commands these send.
import { messageOf } from './api'
import { sendCommand } from './commands'
import { catalogOf, hasRole } from './session'
import type { ErpRecord, Field, State } from './types'
import { ask, toast } from './ui'

export const canAdjustStock = () => !!catalogOf('stock_adjustment') && hasRole(catalogOf('stock_adjustment')?.write_roles)
export const canReplenish = () => !!catalogOf('stock_replenishment') && hasRole(catalogOf('stock_replenishment')?.write_roles)

async function asking(title: string, message: string, fields: Field[], values: State, send: (v: State) => Promise<unknown>, done: string): Promise<boolean> {
  let error = ''
  let current = values
  for (;;) {
    const answer = await ask({ title, message, error, fields, values: current, confirmLabel: '확인' })
    if (!answer) return false
    current = answer.values
    try {
      await send(current)
      toast(done)
      return true
    } catch (e) {
      error = messageOf(e)
    }
  }
}

/** The count goes on record as an adjustment and takes effect at once. */
export function editOnHand(where: { variantId: string; locationId?: string | null; lotId?: string | null; current?: number }): Promise<boolean> {
  return asking('현재고 수정', '실제로 있는 수량을 넣으세요. 재고 조정 문서로 남고 바로 반영됩니다.',
    [{ name: 'counted_qty', label: '실제 수량', type: 'number', required: true }, { name: 'reason', label: '사유', type: 'text' }],
    { counted_qty: where.current ?? null },
    (v) => sendCommand({ type: 'stock_adjustment', command: 'create', payload: {
      variant_id: where.variantId, location_id: where.locationId ?? undefined, lot_id: where.lotId ?? undefined, counted_qty: v.counted_qty, reason: v.reason || undefined, apply: true,
    } }),
    '현재고를 고쳤습니다.')
}

export function replenishNow(variantId: string, warehouseId?: string | null): Promise<boolean> {
  return asking('지금 보충', '구매 모듈이 켜져 있으면 공급사별 견적 요청에 담깁니다. 공급사를 비우면 제품에 정한 공급사를 씁니다.',
    [
      { name: 'qty', label: '수량', type: 'number', required: true, default: 1 },
      { name: 'vendor_id', label: '공급사', type: 'ref', ref: 'partner' },
      { name: 'warehouse_id', label: '창고', type: 'ref', ref: 'warehouse' },
    ],
    { qty: 1, warehouse_id: warehouseId ?? null },
    (v) => sendCommand({ type: 'stock_replenishment', command: 'create', payload: { variant_id: variantId, qty: v.qty, vendor_id: v.vendor_id ?? undefined, warehouse_id: v.warehouse_id ?? undefined } }),
    '보충을 요청했습니다.')
}

/** The variant a product-level action means. One is obvious; several are for the person to say. */
export async function pickVariant(product: ErpRecord): Promise<string | null> {
  const list: State[] = (product.state.variants ?? []).filter((v: State) => v.active !== false)
  if (list.length <= 1) return list[0]?.id ?? null
  const answer = await ask({
    title: '어느 변형인가요?', confirmLabel: '선택',
    fields: [{ name: 'id', label: '변형', type: 'enum', required: true, options: list.map((v) => ({ value: v.id, label: v.name ?? v.id })) }],
    values: { id: list[0].id },
  })
  return answer ? String(answer.values.id) : null
}
