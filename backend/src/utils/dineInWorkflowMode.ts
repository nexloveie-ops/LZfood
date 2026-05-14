import type mongoose from 'mongoose';
import { getModels } from '../getModels';

export type DineInWorkflowMode = 'pay_first' | 'pay_after';

/**
 * 店铺堂食流程模式。缺省或未识别时与历史数据一致：pay_first。
 */
export async function getDineInWorkflowModeForStore(storeId: mongoose.Types.ObjectId): Promise<DineInWorkflowMode> {
  const { Store } = getModels();
  const row = (await Store.findById(storeId).select('dineInWorkflowMode').lean()) as {
    dineInWorkflowMode?: string;
  } | null;
  if (row?.dineInWorkflowMode === 'pay_after') return 'pay_after';
  return 'pay_first';
}
