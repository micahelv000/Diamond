import type { Operation } from "../auth/types";

export function isOperationEnabled(op: Operation, operations: { only?: readonly Operation[]; except?: readonly Operation[] } = {}) {
  const { only, except } = operations;
  return (only === undefined || only.includes(op)) && !except?.includes(op);
}