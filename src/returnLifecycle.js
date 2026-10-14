export const RETURN_STATUS = Object.freeze({
  IDENTIFIED: 'identified',
  INSPECTION_IN_PROGRESS: 'inspection_in_progress',
  AWAITING_DECISION: 'awaiting_decision',
  COMPLETED: 'completed',
})

export const STATUS_DETAILS = Object.freeze({
  [RETURN_STATUS.IDENTIFIED]: {
    label: 'Identified',
    activityLabel: 'Return identified',
  },
  [RETURN_STATUS.INSPECTION_IN_PROGRESS]: {
    label: 'Inspection in progress',
    activityLabel: 'Inspection started',
  },
  [RETURN_STATUS.AWAITING_DECISION]: {
    label: 'Awaiting decision',
    activityLabel: 'Awaiting decision',
  },
  [RETURN_STATUS.COMPLETED]: {
    label: 'Completed',
    activityLabel: 'Decision recorded',
  },
})

const STATUS_ORDER = Object.freeze({
  [RETURN_STATUS.IDENTIFIED]: 0,
  [RETURN_STATUS.INSPECTION_IN_PROGRESS]: 1,
  [RETURN_STATUS.AWAITING_DECISION]: 2,
  [RETURN_STATUS.COMPLETED]: 3,
})

const NEXT_STATUS = Object.freeze({
  [RETURN_STATUS.IDENTIFIED]: RETURN_STATUS.INSPECTION_IN_PROGRESS,
  [RETURN_STATUS.INSPECTION_IN_PROGRESS]: RETURN_STATUS.AWAITING_DECISION,
  [RETURN_STATUS.AWAITING_DECISION]: RETURN_STATUS.COMPLETED,
})

function lifecycleEvent(status, label) {
  return {
    status,
    label: label || STATUS_DETAILS[status].activityLabel,
    occurredAt: new Date().toISOString(),
  }
}

export function createIdentifiedReturn(identifier) {
  return {
    id: 'RORD-8921',
    lookupIdentifier: identifier,
    orderNumber: 'ORD-8921',
    sku: 'DRL-20V-KIT',
    serialNumber: 'DT20-8821-K7',
    productName: '20V Cordless Drill',
    productModel: 'Model CD20',
    refundAmount: 129,
    customerName: 'Jane Doe',
    status: RETURN_STATUS.IDENTIFIED,
    decision: null,
    history: [lifecycleEvent(RETURN_STATUS.IDENTIFIED)],
  }
}

export function transitionReturn(returnCase, nextStatus, details = {}) {
  if (!returnCase) {
    throw new Error('A return must be identified before its status can change.')
  }

  if (returnCase.status === nextStatus) return returnCase

  if (NEXT_STATUS[returnCase.status] !== nextStatus) {
    throw new Error(`Cannot move a return from ${returnCase.status} to ${nextStatus}.`)
  }

  const activityLabel = details.activityLabel || STATUS_DETAILS[nextStatus].activityLabel

  return {
    ...returnCase,
    ...details,
    status: nextStatus,
    history: [...returnCase.history, lifecycleEvent(nextStatus, activityLabel)],
  }
}

export function canOpenStep(returnCase, step) {
  if (step === 'identify') return true
  if (!returnCase) return false

  const statusPosition = STATUS_ORDER[returnCase.status]
  if (step === 'inspection') return statusPosition >= STATUS_ORDER[RETURN_STATUS.INSPECTION_IN_PROGRESS]
  if (step === 'review') return statusPosition >= STATUS_ORDER[RETURN_STATUS.AWAITING_DECISION]
  return false
}

export function getStatusLabel(returnCase) {
  return returnCase ? STATUS_DETAILS[returnCase.status].label : 'Not created yet'
}
