// Converts backend records into the return-case shape the screens already use
// (see createIdentifiedReturn in returnLifecycle.js), plus the saved evidence.

import { RETURN_STATUS, STATUS_DETAILS } from './returnLifecycle.js'

export const DECISION_TITLES = Object.freeze({
  approve: 'Approve return',
  secondary: 'Request secondary review',
  fraud: 'Flag as suspected fraud',
})

const centsToDollars = (cents) => (cents === null || cents === undefined ? null : cents / 100)
const gramsToKg = (grams) => (grams === null || grams === undefined ? null : grams / 1000)

function itemFields(item) {
  return {
    productId: item.product_id,
    productName: item.product_name,
    productModel: item.sku || '',
    sku: item.sku || '—',
    serialNumber: item.serial_number || '—',
    refundAmount: centsToDollars(item.unit_price_cents),
    expectedWeightKg: gramsToKg(item.expected_weight_g),
    orderImages: item.images || [],
  }
}

// Picks the order line the reviewer most likely meant: an exact SKU / serial /
// barcode match, otherwise the first item.
export function pickItem(order, identifier) {
  const value = identifier.trim().toLowerCase()
  return (
    order.items.find((item) =>
      [item.sku, item.serial_number, item.barcode].some((field) => field?.toLowerCase() === value),
    ) || order.items[0]
  )
}

// Picks the order that best matches what was typed or scanned.
export function pickOrder(orders, identifier) {
  const value = identifier.trim().toLowerCase()
  return (
    orders.find((order) => order.id.toLowerCase() === value)
    || orders.find((order) =>
      order.items.some((item) =>
        [item.sku, item.serial_number].some((field) => field?.toLowerCase() === value),
      ),
    )
    || orders[0]
  )
}

// A return that has been matched to an order but not created on the server yet.
export function provisionalReturn(order, item, identifier) {
  return {
    id: 'Not created yet',
    saved: false,
    pending: { orderId: order.id, orderItemId: item.id },
    lookupIdentifier: identifier,
    orderNumber: order.id,
    customerName: order.customer_name || '—',
    ...itemFields(item),
    status: RETURN_STATUS.IDENTIFIED,
    decision: null,
    history: [{
      status: RETURN_STATUS.IDENTIFIED,
      label: STATUS_DETAILS[RETURN_STATUS.IDENTIFIED].activityLabel,
      occurredAt: new Date().toISOString(),
    }],
    returnImages: [],
    weightChecks: [],
    verifications: [],
  }
}

export function fromServerReturn(record) {
  const decision = record.decision
  return {
    id: record.id,
    saved: true,
    lookupIdentifier: record.lookup_identifier || record.order_id,
    orderNumber: record.order_id,
    customerName: record.customer_name || '—',
    ...(record.item ? itemFields(record.item) : {
      productName: 'Unknown item', productModel: '', sku: '—', serialNumber: '—',
      refundAmount: null, expectedWeightKg: null, orderImages: [], productId: null,
    }),
    status: record.status,
    decision: decision
      ? {
        type: decision.outcome,
        title: DECISION_TITLES[decision.outcome] || decision.outcome,
        reason: decision.reason || '',
        note: decision.note || '',
      }
      : null,
    history: record.events.map((event) => ({
      status: event.status,
      label: event.label,
      occurredAt: event.occurred_at,
    })),
    returnImages: record.images,
    weightChecks: record.weight_checks,
    verifications: record.verifications,
  }
}

export const latest = (list) => (list?.length ? list[list.length - 1] : null)

const VERIFY_LABELS = { consistent: 'Match', suspicious: 'Review', inconclusive: 'Review' }

// Signals shown on the inspection and review screens for a saved return.
export function evidenceSignals(returnCase) {
  const weight = latest(returnCase.weightChecks)
  const verification = latest(returnCase.verifications)
  const photos = returnCase.returnImages?.length || 0
  const kg = (grams) => `${(grams / 1000).toFixed(2)} kg`

  return [
    {
      key: 'weight',
      title: 'Weight consistency',
      label: weight
        ? `Weight: ${kg(weight.measured_weight_g)} / ${kg(weight.expected_weight_g)}`
        : 'Weight: not recorded',
      detail: weight
        ? `${weight.difference_g > 0 ? '+' : ''}${weight.difference_g.toFixed(0)} g vs. the original order (allowed ±${weight.tolerance_g.toFixed(0)} g)`
        : returnCase.expectedWeightKg
          ? 'Enter the scale reading to compare with the order'
          : 'No expected weight on file for this item',
      state: weight ? (weight.within_tolerance ? 'match' : 'review') : 'pending',
    },
    {
      key: 'visual',
      title: 'Visual match',
      label: 'Visual match (AI)',
      detail: verification
        ? `${Math.round(verification.confidence * 100)}% visual match — ${verification.decision}`
        : !returnCase.productId
          ? 'Product is not linked to the AI catalog'
          : photos
            ? 'No AI result for the saved photos yet'
            : 'Add a photo to run the AI comparison',
      state: verification ? (VERIFY_LABELS[verification.decision] === 'Match' ? 'match' : 'review') : 'pending',
    },
    {
      key: 'photos',
      title: 'Return photos',
      label: 'Return photos',
      detail: photos ? `${photos} photo${photos === 1 ? '' : 's'} saved to this return` : 'No photos captured yet',
      state: photos ? 'match' : 'pending',
    },
  ]
}

export function recommendation(signals) {
  const flagged = signals.filter((signal) => signal.state === 'review')
  const missing = signals.filter((signal) => signal.state === 'pending')
  if (flagged.length) {
    return {
      title: 'Needs a closer look',
      detail: `${flagged.map((s) => s.title).join(' and ')} did not match the original order. Human judgment is required.`,
    }
  }
  if (missing.length) {
    return {
      title: `${missing.length} check${missing.length === 1 ? '' : 's'} not completed`,
      detail: `${missing.map((s) => s.title).join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing. Decide with the evidence available or go back and capture it.`,
    }
  }
  return {
    title: 'Evidence agrees with the original order',
    detail: 'Weight, photos and the visual match are consistent. The final decision is still yours.',
  }
}
